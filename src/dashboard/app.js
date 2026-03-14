(function () {
  const state = {
    view: (window.location.hash || '#overview').slice(1) || 'overview',
    jobsView: 'overview',
    stats: null,
    jobs: [],
    inbox: [],
    activity: [],
    approvals: [],
    runtime: null,
    health: null,
    selectedJobId: null,
    selectedJobDetail: null,
    selectedJobCandidates: [],
    selectedJobStageFilter: 'all',
    loading: false,
  };

  const app = document.getElementById('app');
  const toastWrap = document.createElement('div');
  toastWrap.className = 'toast-wrap';
  document.body.appendChild(toastWrap);
  let savedDrafts = {};

  function parseTemplates(rawTemplates) {
    if (!rawTemplates) return {};
    if (typeof rawTemplates === 'object') return rawTemplates;
    try {
      return JSON.parse(rawTemplates);
    } catch (error) {
      return {};
    }
  }

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function badge(value) {
    const status = String(value || 'neutral').replaceAll(' ', '_').toLowerCase().replaceAll('—', '_');
    return '<span class="badge ' + status + '">' + esc(value || 'Unknown') + '</span>';
  }

  function time(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString();
  }

  function money(min, max, currency) {
    if (!min && !max) return '—';
    return [min || '—', max || '—'].join(' - ') + ' ' + (currency || 'GBP');
  }

  function getActiveJobs() {
    return (state.jobs || []).filter((job) => job.status === 'ACTIVE' && !job.paused);
  }

  function getArchivedJobs() {
    return (state.jobs || []).filter((job) => job.status !== 'ACTIVE' || job.paused);
  }

  function setActiveNav() {
    document.querySelectorAll('.nav-link').forEach((link) => {
      link.classList.toggle('active', link.dataset.view === state.view);
    });
  }

  function showToast(message, tone) {
    const el = document.createElement('div');
    el.className = 'toast' + (tone ? ' ' + tone : '');
    el.textContent = message;
    toastWrap.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  async function request(path, options) {
    const response = await fetch(path, options);
    if (!response.ok) {
      let message = 'Request failed';
      try {
        const payload = await response.json();
        message = payload.error || message;
      } catch (error) {
        message = await response.text();
      }
      throw new Error(message);
    }
    return response.json();
  }

  function serializeForm(form) {
    if (!form) return null;
    const payload = {};
    Array.from(form.elements || []).forEach((field) => {
      if (!field.name) return;
      payload[field.name] = field.value;
    });
    return payload;
  }

  function captureDrafts() {
    savedDrafts = {
      createJob: serializeForm(document.getElementById('job-create-form')),
      jobAsset: serializeForm(document.getElementById('job-asset-form')),
      jobSettings: serializeForm(document.getElementById('job-settings-form')),
      jobTemplates: serializeForm(document.getElementById('job-templates-form')),
    };
  }

  function restoreForm(formId, draft) {
    const form = document.getElementById(formId);
    if (!form || !draft) return;
    Object.entries(draft).forEach(([name, value]) => {
      const field = form.elements.namedItem(name);
      if (!field || typeof value === 'undefined' || value === null) return;
      field.value = value;
    });
  }

  function restoreDrafts() {
    restoreForm('job-create-form', savedDrafts.createJob);
    restoreForm('job-asset-form', savedDrafts.jobAsset);
    restoreForm('job-settings-form', savedDrafts.jobSettings);
    restoreForm('job-templates-form', savedDrafts.jobTemplates);
  }

  function hasMeaningfulDraft(formId) {
    const form = document.getElementById(formId);
    if (!form) return false;
    return Array.from(form.elements || []).some((field) => field.name && String(field.value || '').trim() !== '');
  }

  function isEditingSensitiveView() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
      return true;
    }
    if (state.view === 'jobs' && (hasMeaningfulDraft('job-create-form') || hasMeaningfulDraft('job-asset-form') || hasMeaningfulDraft('job-settings-form') || hasMeaningfulDraft('job-templates-form'))) {
      return true;
    }
    return state.view === 'controls';
  }

  async function loadCoreData(options) {
    const config = { background: false, preserveDrafts: false, ...options };
    if (!config.background) {
      state.loading = true;
      render();
    }

    const [stats, jobs, inbox, activity, approvals, runtime, health] = await Promise.all([
      request('/api/stats'),
      request('/api/jobs'),
      request('/api/inbox'),
      request('/api/activity'),
      request('/api/approval-queue'),
      request('/api/state'),
      request('/api/health'),
    ]);
    state.stats = stats;
    state.jobs = jobs;
    state.inbox = inbox;
    state.activity = activity;
    state.approvals = approvals;
    state.runtime = runtime;
    state.health = health;
    const activeJobs = jobs.filter((job) => job.status === 'ACTIVE' && !job.paused);
    state.selectedJobId = state.selectedJobId || activeJobs[0]?.id || jobs[0]?.id || null;
    state.loading = false;
    if (state.selectedJobId) {
      await loadSelectedJob(state.selectedJobId, { preserveDrafts: config.preserveDrafts });
    } else {
      render();
    }
  }

  async function loadSelectedJob(jobId, options) {
    const config = { preserveDrafts: false, ...options };
    state.selectedJobId = jobId;
    if (!jobId) {
      state.selectedJobDetail = null;
      state.selectedJobCandidates = [];
      render();
      return;
    }
    const [job, candidates] = await Promise.all([
      request('/api/jobs/' + jobId),
      request('/api/jobs/' + jobId + '/candidates?limit=200' + (state.selectedJobStageFilter !== 'all' ? '&stage=' + encodeURIComponent(state.selectedJobStageFilter) : '')),
    ]);
    state.selectedJobDetail = job;
    state.selectedJobCandidates = candidates;
    if (config.preserveDrafts) {
      captureDrafts();
    }
    render();
    if (config.preserveDrafts) {
      restoreDrafts();
    }
  }

  function renderOverview() {
    const stats = state.stats || {};
    const topJobs = getActiveJobs().slice(0, 5).map((job) => (
      '<tr>' +
        '<td><strong>' + esc(job.job_title || job.name) + '</strong><div class="stat-note">' + esc(job.client_name || 'No client set') + '</div></td>' +
        '<td>' + badge(job.status) + '</td>' +
        '<td>' + (job.metrics?.candidates_sourced || 0) + '</td>' +
        '<td>' + (job.metrics?.replies || 0) + '</td>' +
        '<td><button class="btn btn-secondary" data-action="select-job" data-job-id="' + esc(job.id) + '">Open</button></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="5">No active jobs yet.</td></tr>';

    const recentActivity = state.activity.slice(0, 10).map((item) => (
      '<div class="timeline-item">' +
        '<div class="timeline-meta">' + time(item.created_at) + '</div>' +
        '<div><strong>' + esc(item.event_type) + '</strong> · ' + esc(item.summary || '') + '</div>' +
      '</div>'
    )).join('') || '<div class="notice">No activity logged yet.</div>';

    return (
      '<section class="view-section">' +
        '<div class="grid grid-3">' +
          '<div class="card kpi"><div class="label-caps">Active Jobs</div><div class="stat-value">' + (stats.active_jobs || 0) + '</div></div>' +
          '<div class="card kpi"><div class="label-caps">Candidates in Outreach</div><div class="stat-value">' + (stats.candidates_in_outreach || 0) + '</div></div>' +
          '<div class="card kpi"><div class="label-caps">Invites Sent</div><div class="stat-value">' + (stats.invites_sent || 0) + '</div></div>' +
          '<div class="card kpi"><div class="label-caps">Replies</div><div class="stat-value">' + (stats.replies || 0) + '</div></div>' +
          '<div class="card kpi"><div class="label-caps">Qualified</div><div class="stat-value">' + (stats.qualified || 0) + '</div></div>' +
          '<div class="card kpi"><div class="label-caps">Interviews Booked</div><div class="stat-value">' + (stats.interviews_booked || 0) + '</div></div>' +
        '</div>' +
        '<div class="split">' +
          '<div class="table-card">' +
            '<div class="panel-head"><div><div class="label-caps">Live Jobs</div><h2 class="section-title">Open Pipelines</h2></div></div>' +
            '<table><thead><tr><th>Job</th><th>Status</th><th>Sourced</th><th>Replies</th><th></th></tr></thead><tbody>' + topJobs + '</tbody></table>' +
          '</div>' +
          '<div class="card">' +
            '<div class="label-caps">Live Activity</div><h2 class="section-title">Latest Events</h2>' +
            '<div id="activity-feed" class="timeline push-top">' + recentActivity + '</div>' +
          '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function renderArchived() {
    const rows = getArchivedJobs().map((job) => (
      '<tr>' +
        '<td><strong>' + esc(job.job_title || job.name) + '</strong><div class="stat-note">' + esc(job.client_name || 'No client set') + '</div></td>' +
        '<td>' + badge(job.status) + '</td>' +
        '<td>' + time(job.closed_at || job.created_at) + '</td>' +
        '<td>' + (job.metrics?.candidates_sourced || 0) + '</td>' +
        '<td><button class="btn btn-secondary" data-action="select-job" data-job-id="' + esc(job.id) + '">Open</button></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="5">No archived jobs yet.</td></tr>';

    return (
      '<section class="view-section">' +
        '<div class="table-card">' +
          '<div class="panel-head"><div><div class="label-caps">Archived Jobs</div><h2 class="section-title">Closed and Paused Searches</h2></div></div>' +
          '<table><thead><tr><th>Job</th><th>Status</th><th>Closed</th><th>Sourced</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div>' +
      '</section>'
    );
  }

  function renderJobForm() {
    return (
      '<form id="job-create-form" class="card form-grid">' +
        '<div class="form-span-2"><div class="label-caps">Launch Job</div><h2 class="section-title">Create New Search</h2></div>' +
        '<label><span>Job title</span><input class="input" name="job_title" required /></label>' +
        '<label><span>Client name</span><input class="input" name="client_name" /></label>' +
        '<label><span>Location</span><input class="input" name="location" /></label>' +
        '<label><span>Seniority</span><input class="input" name="seniority_level" /></label>' +
        '<label><span>Salary min</span><input class="input" name="salary_min" type="number" /></label>' +
        '<label><span>Salary max</span><input class="input" name="salary_max" type="number" /></label>' +
        '<label><span>Send from</span><input class="input" name="send_from" type="time" value="08:00" /></label>' +
        '<label><span>Send until</span><input class="input" name="send_until" type="time" value="18:00" /></label>' +
        '<label><span>Timezone</span><input class="input" name="timezone" value="Europe/London" /></label>' +
        '<label><span>Active days</span><input class="input" name="active_days" value="Mon,Tue,Wed,Thu,Fri" /></label>' +
        '<label class="form-span-2"><span>Must-have stack</span><input class="input" name="tech_stack_must" placeholder="Node.js, TypeScript, PostgreSQL" /></label>' +
        '<label class="form-span-2"><span>Candidate profile</span><textarea class="input textarea" name="candidate_profile" placeholder="Who are we targeting and why?"></textarea></label>' +
        '<label class="form-span-2"><span>Full job description</span><textarea class="input textarea" name="full_job_description" placeholder="Paste the brief or core hiring context"></textarea></label>' +
        '<div class="form-span-2 button-row"><button class="btn btn-primary" type="submit">Create Job</button></div>' +
      '</form>'
    );
  }

  function renderJobDetail() {
    const job = state.selectedJobDetail;
    if (!job) {
      return '<div class="notice">Create a job or select one from the table to see pipeline detail.</div>';
    }

    const candidateRows = state.selectedJobCandidates.map((candidate) => (
      '<tr>' +
        '<td><strong>' + esc(candidate.name || 'Unknown') + '</strong><div class="stat-note">' + esc(candidate.current_title || 'No title') + '</div></td>' +
        '<td>' + badge(candidate.pipeline_stage) + '</td>' +
        '<td>' + badge(candidate.fit_grade || 'Unknown') + '</td>' +
        '<td>' + esc(candidate.current_company || '—') + '</td>' +
        '<td>' + (candidate.fit_score || 0) + '</td>' +
        '<td>' + esc(candidate.location || '—') + '</td>' +
        '<td><a class="btn btn-secondary" target="_blank" rel="noreferrer" href="' + esc(candidate.linkedin_url || '#') + '">LinkedIn</a></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="7">No candidates loaded yet.</td></tr>';

    const activityRows = (job.recent_activity || []).map((item) => (
      '<div class="timeline-item"><div class="timeline-meta">' + time(item.created_at) + '</div><div><strong>' + esc(item.event_type) + '</strong> · ' + esc(item.summary || '') + '</div></div>'
    )).join('') || '<div class="notice">No activity for this job yet.</div>';

    const assetRows = (job.assets || []).map((asset) => (
      '<tr>' +
        '<td>' + esc(asset.name) + '</td>' +
        '<td>' + badge(asset.asset_type) + '</td>' +
        '<td><a href="' + esc(asset.url) + '" target="_blank" rel="noreferrer">' + esc(asset.url) + '</a></td>' +
        '<td><button class="btn btn-secondary" data-action="delete-asset" data-asset-id="' + esc(asset.id) + '">Remove</button></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="4">No job assets yet.</td></tr>';
    const templates = parseTemplates(job.outreach_templates);

    const settingsForm =
      '<form id="job-settings-form" class="card form-grid" data-job-id="' + esc(job.id) + '">' +
        '<div class="form-span-2"><div class="label-caps">Job Settings</div><h2 class="section-title">Per-Job Controls</h2></div>' +
        '<label><span>Send from</span><input class="input" name="send_from" type="time" value="' + esc(job.send_from || '08:00') + '" /></label>' +
        '<label><span>Send until</span><input class="input" name="send_until" type="time" value="' + esc(job.send_until || '18:00') + '" /></label>' +
        '<label><span>Timezone</span><input class="input" name="timezone" value="' + esc(job.timezone || 'Europe/London') + '" /></label>' +
        '<label><span>Active days</span><input class="input" name="active_days" value="' + esc(job.active_days || 'Mon,Tue,Wed,Thu,Fri') + '" /></label>' +
        '<label><span>LinkedIn daily limit</span><input class="input" name="linkedin_daily_limit" type="number" value="' + esc(job.linkedin_daily_limit || 28) + '" /></label>' +
        '<label><span>Status</span><input class="input" name="status" value="' + esc(job.status || 'ACTIVE') + '" readonly /></label>' +
        '<div class="form-span-2 button-row"><button class="btn btn-primary" type="submit">Save Settings</button></div>' +
      '</form>';
    const templatesForm =
      '<form id="job-templates-form" class="card form-grid" data-job-id="' + esc(job.id) + '">' +
        '<div class="form-span-2"><div class="label-caps">Templates</div><h2 class="section-title">Per-Job Outreach Guidance</h2></div>' +
        '<label class="form-span-2"><span>Connection request template guidance</span><textarea class="input textarea" name="connection_request" placeholder="Tone, CTA, hooks, constraints">' + esc(templates.connection_request || '') + '</textarea></label>' +
        '<label class="form-span-2"><span>LinkedIn DM template guidance</span><textarea class="input textarea" name="linkedin_dm" placeholder="How the first DM should sound for this job">' + esc(templates.linkedin_dm || '') + '</textarea></label>' +
        '<label class="form-span-2"><span>Email template guidance</span><textarea class="input textarea" name="email" placeholder="How outreach emails should be framed for this job">' + esc(templates.email || '') + '</textarea></label>' +
        '<label class="form-span-2"><span>Follow-up template guidance</span><textarea class="input textarea" name="follow_up" placeholder="How follow-ups should sound for this job">' + esc(templates.follow_up || '') + '</textarea></label>' +
        '<div class="form-span-2 button-row"><button class="btn btn-primary" type="submit">Save Templates</button></div>' +
      '</form>';

    const stageFilters = [
      ['all', 'All'],
      ['Shortlisted', 'Shortlisted'],
      ['Enriched', 'Enriched'],
      ['invite_sent', 'Invited'],
      ['invite_accepted', 'Accepted'],
      ['Qualified', 'Qualified'],
      ['Replied', 'Replied'],
      ['Archived', 'Archived'],
    ].map(([value, label]) => (
      '<button class="btn filter-pill ' + (state.selectedJobStageFilter === value ? 'active' : '') + '" data-action="set-stage-filter" data-stage="' + esc(value) + '">' + esc(label) + '</button>'
    )).join('');

    const jobSubnav = [
      ['overview', 'Overview'],
      ['shortlist', 'Shortlist'],
      ['activity', 'Activity'],
      ['assets', 'Assets'],
      ['templates', 'Templates'],
    ].map(([value, label]) => (
      '<button class="btn filter-pill ' + (state.jobsView === value ? 'active' : '') + '" data-action="set-job-view" data-job-view="' + esc(value) + '">' + esc(label) + '</button>'
    )).join('');

    let detailBody = '';
    if (state.jobsView === 'shortlist') {
      detailBody =
        '<div class="split">' +
          '<div class="table-card">' +
            '<div class="panel-head"><div><div class="label-caps">Shortlist</div><h2 class="section-title">All Candidates for This Job</h2></div><div class="filters">' + stageFilters + '</div></div>' +
            '<table><thead><tr><th>Candidate</th><th>Stage</th><th>Grade</th><th>Company</th><th>Score</th><th>Location</th><th></th></tr></thead><tbody>' + candidateRows + '</tbody></table>' +
          '</div>' +
          settingsForm +
        '</div>';
    } else if (state.jobsView === 'activity') {
      detailBody =
        '<div class="card">' +
          '<div class="label-caps">Recent Activity</div><h2 class="section-title">Job Timeline</h2>' +
          '<div class="timeline push-top">' + activityRows + '</div>' +
        '</div>';
    } else if (state.jobsView === 'assets') {
      detailBody =
        '<div class="split">' +
          '<div class="table-card">' +
            '<div class="panel-head"><div><div class="label-caps">Assets</div><h2 class="section-title">Reply Links</h2></div></div>' +
            '<table><thead><tr><th>Name</th><th>Type</th><th>URL</th><th></th></tr></thead><tbody>' + assetRows + '</tbody></table>' +
          '</div>' +
          '<form id="job-asset-form" class="card form-grid" data-job-id="' + esc(job.id) + '">' +
            '<div class="form-span-2"><div class="label-caps">Add Asset</div><h2 class="section-title">Calendly, JD, or useful links</h2></div>' +
            '<label><span>Name</span><input class="input" name="name" required /></label>' +
            '<label><span>Type</span><select class="input" name="asset_type"><option value="calendly">Calendly</option><option value="jd">JD</option><option value="video">Video</option><option value="image">Image</option><option value="link">Link</option><option value="other">Other</option></select></label>' +
            '<label class="form-span-2"><span>URL</span><input class="input" name="url" type="url" required /></label>' +
            '<label class="form-span-2"><span>Description</span><textarea class="input textarea" name="description"></textarea></label>' +
            '<div class="form-span-2 button-row"><button class="btn btn-primary" type="submit">Save Asset</button></div>' +
          '</form>' +
        '</div>';
    } else if (state.jobsView === 'templates') {
      detailBody = templatesForm;
    } else {
      detailBody =
        '<div class="split">' +
          '<div class="table-card">' +
            '<div class="panel-head"><div><div class="label-caps">Pipeline Snapshot</div><h2 class="section-title">Recent Candidates</h2></div><div class="filters">' + stageFilters + '</div></div>' +
            '<table><thead><tr><th>Candidate</th><th>Stage</th><th>Grade</th><th>Company</th><th>Score</th><th>Location</th><th></th></tr></thead><tbody>' + candidateRows + '</tbody></table>' +
          '</div>' +
          '<div class="detail-stack">' +
            settingsForm +
            '<div class="card">' +
            '<div class="label-caps">Recent Activity</div><h2 class="section-title">Job Timeline</h2>' +
            '<div class="timeline push-top">' + activityRows + '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    return (
      '<div class="detail-stack">' +
        '<div class="card">' +
          '<div class="label-caps">Selected Job</div><h2 class="section-title">' + esc(job.job_title || job.name) + '</h2>' +
          '<div class="stat-note">' + esc(job.client_name || 'No client set') + ' · ' + esc(job.location || 'No location') + ' · ' + money(job.salary_min, job.salary_max, job.currency) + '</div>' +
          '<div class="stat-note">Send window: ' + esc(job.send_from || '08:00') + ' - ' + esc(job.send_until || '18:00') + ' · ' + esc(job.timezone || 'Europe/London') + ' · ' + esc(job.active_days || 'Mon,Tue,Wed,Thu,Fri') + '</div>' +
          '<div class="button-row push-top">' +
            '<button class="btn btn-primary" data-action="source-now" data-job-id="' + esc(job.id) + '">Source Now</button>' +
            (job.status === 'ACTIVE' ? '<button class="btn btn-secondary" data-action="close-job" data-job-id="' + esc(job.id) + '">Close Job</button>' : '') +
            '<button class="btn btn-secondary" data-action="delete-job" data-job-id="' + esc(job.id) + '">Delete Job</button>' +
          '</div>' +
          '<div class="grid grid-4 push-top">' +
            '<div class="card card-tight"><div class="label-caps">Sourced</div><div class="stat-value">' + (job.metrics?.candidates_sourced || 0) + '</div></div>' +
            '<div class="card card-tight"><div class="label-caps">Outreach</div><div class="stat-value">' + (job.metrics?.candidates_in_outreach || 0) + '</div></div>' +
            '<div class="card card-tight"><div class="label-caps">Replies</div><div class="stat-value">' + (job.metrics?.replies || 0) + '</div></div>' +
            '<div class="card card-tight"><div class="label-caps">Approvals</div><div class="stat-value">' + (job.metrics?.approval_queue_count || 0) + '</div></div>' +
          '</div>' +
          '<div class="filters push-top">' + jobSubnav + '</div>' +
        '</div>' +
        detailBody +
      '</div>'
    );
  }

  function renderJobs() {
    const jobRows = getActiveJobs().map((job) => (
      '<tr>' +
        '<td><strong>' + esc(job.job_title || job.name) + '</strong><div class="stat-note">' + esc(job.client_name || 'No client set') + '</div></td>' +
        '<td>' + badge(job.status) + '</td>' +
        '<td>' + (job.metrics?.candidates_sourced || 0) + '</td>' +
        '<td>' + (job.metrics?.candidates_in_outreach || 0) + '</td>' +
        '<td>' + (job.metrics?.replies || 0) + '</td>' +
        '<td><button class="btn btn-secondary" data-action="select-job" data-job-id="' + esc(job.id) + '">Inspect</button></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="6">No jobs yet.</td></tr>';

    return (
      '<section class="view-section">' +
        '<div class="split split-rail">' +
          renderJobForm() +
          '<div class="table-card">' +
            '<div class="panel-head"><div><div class="label-caps">Active Jobs</div><h2 class="section-title">Pipeline Directory</h2></div></div>' +
            '<table><thead><tr><th>Job</th><th>Status</th><th>Sourced</th><th>Outreach</th><th>Replies</th><th></th></tr></thead><tbody>' + jobRows + '</tbody></table>' +
          '</div>' +
        '</div>' +
        renderJobDetail() +
      '</section>'
    );
  }

  function renderInbox() {
    const rows = state.inbox.map((item) => (
      '<tr>' +
        '<td>' + esc(item.candidates?.name || 'Unknown') + '</td>' +
        '<td>' + esc(item.jobs?.job_title || 'Unknown') + '</td>' +
        '<td>' + esc((item.message_text || '').slice(0, 220)) + '</td>' +
        '<td>' + time(item.sent_at) + '</td>' +
        '<td>' + badge(item.channel) + '</td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="5">No inbound messages yet.</td></tr>';

    return (
      '<section class="view-section">' +
        '<div class="table-card">' +
          '<div class="panel-head"><div><div class="label-caps">Inbox</div><h2 class="section-title">Replies and Candidate Messages</h2></div></div>' +
          '<table><thead><tr><th>Candidate</th><th>Job</th><th>Message</th><th>Time</th><th>Channel</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div>' +
      '</section>'
    );
  }

  function renderActivity() {
    const rows = state.activity.map((item) => (
      '<div class="timeline-item">' +
        '<div class="timeline-meta">' + time(item.created_at) + '</div>' +
        '<div><strong>' + esc(item.event_type) + '</strong> · ' + esc(item.summary || '') + '</div>' +
      '</div>'
    )).join('') || '<div class="notice">No activity logged yet.</div>';

    return (
      '<section class="view-section">' +
        '<div class="card">' +
          '<div class="label-caps">Activity</div><h2 class="section-title">Global Feed</h2>' +
          '<div id="activity-feed" class="timeline push-top">' + rows + '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function renderApprovals() {
    const rows = state.approvals.map((item) => (
      '<tr>' +
        '<td>' + badge(item.channel) + '</td>' +
        '<td>' + esc(item.stage || '—') + '</td>' +
        '<td>' + esc((item.message_text || '').slice(0, 220)) + '</td>' +
        '<td>' + time(item.created_at) + '</td>' +
        '<td><div class="button-row"><button class="btn btn-primary" data-action="approve" data-id="' + esc(item.id) + '">Approve</button><button class="btn btn-secondary" data-action="skip" data-id="' + esc(item.id) + '">Skip</button></div></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="5">No pending approvals.</td></tr>';

    return (
      '<section class="view-section">' +
        '<div class="table-card">' +
          '<div class="panel-head"><div><div class="label-caps">Approvals</div><h2 class="section-title">Human Review Queue</h2></div></div>' +
          '<table><thead><tr><th>Channel</th><th>Stage</th><th>Message</th><th>Created</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div>' +
      '</section>'
    );
  }

  function renderControls() {
    const runtime = state.runtime || {};
    const health = state.health || {};
    const toggles = [
      ['outreachEnabled', 'Outreach'],
      ['followupEnabled', 'Follow-ups'],
      ['enrichmentEnabled', 'Enrichment'],
      ['researchEnabled', 'Research'],
      ['linkedinEnabled', 'LinkedIn'],
      ['postsEnabled', 'Posts'],
    ].map(([key, label]) => (
      '<div class="card control-card">' +
        '<div><div class="label-caps">Module</div><h2 class="section-title">' + esc(label) + '</h2></div>' +
        '<div class="button-row"><button class="btn ' + (runtime[key] ? 'btn-primary' : 'btn-secondary') + '" data-action="toggle" data-key="' + esc(key) + '">' + (runtime[key] ? 'Enabled' : 'Disabled') + '</button></div>' +
      '</div>'
    )).join('');

    return (
      '<section class="view-section">' +
        '<div class="grid grid-3">' +
          '<div class="card kpi"><div class="label-caps">System Status</div><div class="stat-value serif">' + esc(runtime.raxionStatus || 'ACTIVE') + '</div></div>' +
          '<div class="card kpi"><div class="label-caps">Pending Approvals</div><div class="stat-value">' + (health.pending_approvals || 0) + '</div></div>' +
          '<div class="card kpi"><div class="label-caps">Webhook Events Logged</div><div class="stat-value">' + (health.webhook_events_logged || 0) + '</div></div>' +
        '</div>' +
        '<div class="grid grid-3 push-top">' + toggles + '</div>' +
        '<div class="card push-top"><div class="label-caps">Health</div><h2 class="section-title">Runtime Snapshot</h2><pre class="code-block">' + esc(JSON.stringify(health, null, 2)) + '</pre></div>' +
      '</section>'
    );
  }

  function render() {
    captureDrafts();
    setActiveNav();
    if (state.loading) {
      app.innerHTML = '<div class="card">Loading Mission Control…</div>';
      return;
    }

    const views = {
      overview: renderOverview,
      jobs: renderJobs,
      archived: renderArchived,
      inbox: renderInbox,
      activity: renderActivity,
      approvals: renderApprovals,
      controls: renderControls,
    };

    const view = views[state.view] || views.overview;
    app.innerHTML = view();
    restoreDrafts();
  }

  async function handleAction(action, id, extra) {
    if (action === 'approve') {
      await request('/api/approval-queue/' + id + '/approve', { method: 'POST' });
      await loadCoreData();
      state.view = 'approvals';
      render();
      return;
    }

    if (action === 'skip') {
      await request('/api/approval-queue/' + id + '/skip', { method: 'POST' });
      await loadCoreData();
      state.view = 'approvals';
      render();
      return;
    }

    if (action === 'select-job') {
      state.view = 'jobs';
      window.location.hash = 'jobs';
      await loadSelectedJob(id);
      return;
    }

    if (action === 'toggle') {
      await request('/api/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: extra }),
      });
      await loadCoreData();
      state.view = 'controls';
      render();
      return;
    }

    if (action === 'delete-asset') {
      await request('/api/jobs/' + state.selectedJobId + '/assets/' + id, { method: 'DELETE' });
      await loadSelectedJob(state.selectedJobId);
      return;
    }

    if (action === 'set-job-view') {
      state.jobsView = extra;
      render();
      return;
    }

    if (action === 'set-stage-filter') {
      state.selectedJobStageFilter = extra;
      await loadSelectedJob(state.selectedJobId, { preserveDrafts: true });
      return;
    }

    if (action === 'source-now') {
      await request('/api/jobs/' + id + '/source-now', { method: 'POST' });
      showToast('Sourcing triggered. Watch the shortlist and live activity feed.');
      state.jobsView = 'shortlist';
      await loadCoreData({ preserveDrafts: true });
      await loadSelectedJob(id, { preserveDrafts: true });
      return;
    }

    if (action === 'close-job') {
      await request('/api/jobs/' + id + '/close', { method: 'POST' });
      showToast('Job closed. No further action will run for it.');
      state.view = 'archived';
      window.location.hash = 'archived';
      await loadCoreData({ preserveDrafts: true });
      return;
    }

    if (action === 'delete-job') {
      const confirmed = window.confirm('Delete this job and all related candidates from Mission Control and Supabase?');
      if (!confirmed) return;
      await request('/api/jobs/' + id, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      showToast('Job and related candidates deleted.');
      if (state.selectedJobId === id) {
        state.selectedJobId = null;
        state.selectedJobDetail = null;
        state.selectedJobCandidates = [];
      }
      await loadCoreData({ preserveDrafts: true });
    }
  }

  document.addEventListener('click', async (event) => {
    const link = event.target.closest('.nav-link');
    if (link) {
      event.preventDefault();
      state.view = link.dataset.view;
      window.location.hash = state.view;
      render();
      return;
    }

    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      event.preventDefault();
      try {
        await handleAction(
          actionEl.dataset.action,
          actionEl.dataset.id || actionEl.dataset.jobId || actionEl.dataset.assetId,
          actionEl.dataset.key || actionEl.dataset.jobView || actionEl.dataset.stage,
        );
      } catch (error) {
        showToast(error.message, 'error');
      }
      return;
    }

    if (event.target.id === 'refresh-dashboard') {
      await loadCoreData({ preserveDrafts: true });
      return;
    }

    if (event.target.id === 'launch-job') {
      state.view = 'jobs';
      window.location.hash = 'jobs';
      render();
      const form = document.getElementById('job-create-form');
      if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  document.addEventListener('submit', async (event) => {
    if (event.target.id === 'job-create-form') {
      event.preventDefault();
      const formData = new FormData(event.target);
      const payload = Object.fromEntries(formData.entries());
      payload.name = payload.job_title;
      payload.status = 'ACTIVE';
      if (payload.salary_min) payload.salary_min = Number(payload.salary_min);
      if (payload.salary_max) payload.salary_max = Number(payload.salary_max);
      try {
        const result = await request('/api/jobs/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        event.target.reset();
        state.jobsView = 'overview';
        state.selectedJobStageFilter = 'all';
        await loadCoreData();
        await loadSelectedJob(result.job_id);
        state.view = 'jobs';
        render();
      } catch (error) {
        showToast(error.message, 'error');
      }
      return;
    }

    if (event.target.id === 'job-asset-form') {
      event.preventDefault();
      const jobId = event.target.dataset.jobId;
      const payload = Object.fromEntries(new FormData(event.target).entries());
      try {
        await request('/api/jobs/' + jobId + '/assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        event.target.reset();
        await loadSelectedJob(jobId);
      } catch (error) {
        showToast(error.message.indexOf('job_assets') >= 0 ? 'Run the new Supabase migration 003_raxion_dashboard_assets.sql before using job assets.' : error.message, 'error');
      }
      return;
    }

    if (event.target.id === 'job-settings-form') {
      event.preventDefault();
      const jobId = event.target.dataset.jobId;
      const payload = Object.fromEntries(new FormData(event.target).entries());
      if (payload.linkedin_daily_limit) payload.linkedin_daily_limit = Number(payload.linkedin_daily_limit);
      try {
        await request('/api/jobs/' + jobId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        showToast('Job settings saved.');
        await loadCoreData({ preserveDrafts: true });
        await loadSelectedJob(jobId, { preserveDrafts: true });
      } catch (error) {
        showToast(error.message, 'error');
      }
      return;
    }

    if (event.target.id === 'job-templates-form') {
      event.preventDefault();
      const jobId = event.target.dataset.jobId;
      const rawTemplates = Object.fromEntries(new FormData(event.target).entries());
      try {
        await request('/api/jobs/' + jobId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outreach_templates: rawTemplates }),
        });
        showToast('Job templates saved.');
        await loadCoreData({ preserveDrafts: true });
        await loadSelectedJob(jobId, { preserveDrafts: true });
      } catch (error) {
        showToast(error.message, 'error');
      }
    }
  });

  window.addEventListener('hashchange', () => {
    state.view = (window.location.hash || '#overview').slice(1) || 'overview';
    render();
  });

  const stream = new EventSource('/api/activity/stream');
  stream.onmessage = (event) => {
    const item = JSON.parse(event.data);
    state.activity = [item].concat(state.activity || []).slice(0, 100);
    if (state.view === 'activity' || state.view === 'overview') {
      render();
    }
  };

  loadCoreData().catch((error) => {
    app.innerHTML = '<div class="notice">Failed to load dashboard: ' + esc(error.message) + '</div>';
  });
  setInterval(() => {
    if (isEditingSensitiveView()) return;
    loadCoreData({ background: true, preserveDrafts: true }).catch(() => null);
  }, 30000);
}());
