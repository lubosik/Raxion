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
    selectedJobActivity: [],
    selectedJobApprovals: [],
    selectedJobStageFilter: 'all',
    selectedActivityFilter: 'all',
    candidatePanelId: null,
    candidatePanelDetail: null,
    loading: false,
  };

  const app = document.getElementById('app');
  const toastWrap = document.createElement('div');
  toastWrap.className = 'toast-wrap';
  document.body.appendChild(toastWrap);
  let savedDrafts = {};

  const STAGE_COLORS = {
    Sourced: 'stage-sourced',
    Shortlisted: 'stage-shortlisted',
    Enriched: 'stage-enriched',
    invite_sent: 'stage-invite_sent',
    invite_accepted: 'stage-invite_accepted',
    dm_sent: 'stage-dm_sent',
    email_sent: 'stage-email_sent',
    Replied: 'stage-replied',
    Qualified: 'stage-qualified',
    Archived: 'stage-archived',
    Rejected: 'stage-archived',
    Placed: 'stage-qualified',
  };

  const GRADE_COLORS = {
    HOT: 'grade-hot',
    WARM: 'grade-warm',
    POSSIBLE: 'grade-possible',
    ARCHIVE: 'grade-archive',
  };

  const PIPELINE_STAGES = [
    'Sourced',
    'Shortlisted',
    'Enriched',
    'invite_sent',
    'invite_accepted',
    'dm_sent',
    'email_sent',
    'Replied',
    'Qualified',
    'Archived',
  ];

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function parseTemplates(rawTemplates) {
    if (!rawTemplates) return {};
    if (typeof rawTemplates === 'object') return rawTemplates;
    try {
      return JSON.parse(rawTemplates);
    } catch {
      return {};
    }
  }

  function time(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString();
  }

  function shortTime(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function money(min, max, currency) {
    if (!min && !max) return '—';
    return [min || '—', max || '—'].join(' - ') + ' ' + (currency || 'GBP');
  }

  function formatUrl(url) {
    if (!url) return 'No profile';
    try {
      const parsed = new URL(url);
      return (parsed.hostname + parsed.pathname).replace(/\/$/, '').slice(0, 36) + ((parsed.hostname + parsed.pathname).length > 36 ? '...' : '');
    } catch {
      return 'Open profile';
    }
  }

  function initials(name) {
    const parts = String(name || 'Unknown').trim().split(/\s+/).slice(0, 2);
    return parts.map((part) => part[0] || '').join('').toUpperCase() || 'U';
  }

  function badge(value, kind) {
    const text = String(value || 'Unknown');
    const cls = kind === 'stage'
      ? (STAGE_COLORS[text] || 'stage-default')
      : kind === 'grade'
        ? (GRADE_COLORS[text] || 'grade-default')
        : 'stage-default';
    return '<span class="chip ' + cls + '">' + esc(text) + '</span>';
  }

  function eventBadge(value) {
    const type = String(value || 'SYSTEM');
    const tone = /ERROR|FAILED/.test(type)
      ? 'event-error'
      : /REPLY|QUALIFIED|ACCEPTED/.test(type)
        ? 'event-positive'
        : /DRAFT|APPROVED|SENT|ENRICHMENT/.test(type)
          ? 'event-info'
          : /OUTSIDE_SENDING_WINDOW/.test(type)
            ? 'event-muted'
            : 'event-default';
    return '<span class="chip event-chip ' + tone + '">' + esc(type) + '</span>';
  }

  function enrichmentIcon(candidate) {
    const status = String(candidate.enrichment_status || 'Pending');
    const cls = status === 'Enriched' ? 'enrichment-good' : status === 'Failed' ? 'enrichment-bad' : status === 'No Data' ? 'enrichment-empty' : 'enrichment-pending';
    return '<span class="enrichment-dot ' + cls + '" title="' + esc(status) + '"></span>';
  }

  function copyButton(url) {
    if (!url) return '';
    return '<button class="btn btn-secondary btn-xs" data-action="copy-url" data-url="' + esc(url) + '">Copy</button>';
  }

  function latestCandidateTimestamp(candidate) {
    const values = [
      candidate.last_reply_at,
      candidate.qualified_at,
      candidate.dm_sent_at,
      candidate.invite_accepted_at,
      candidate.invite_sent_at,
      candidate.created_at,
    ].filter(Boolean).sort().reverse();
    return values[0] || null;
  }

  function getActiveJobs() {
    return (state.jobs || []).filter((job) => job.status === 'ACTIVE' && !job.paused);
  }

  function getArchivedJobs() {
    return (state.jobs || []).filter((job) => job.status !== 'ACTIVE' || job.paused);
  }

  function getSelectedJob() {
    return state.selectedJobDetail;
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
      } catch {
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

  function groupInboxThreads(items) {
    const threads = new Map();
    for (const item of items || []) {
      const key = item.candidate_id || item.candidates?.id || item.id;
      if (!threads.has(key)) {
        threads.set(key, {
          candidateId: item.candidate_id || item.candidates?.id || null,
          candidateName: item.candidates?.name || 'Unknown',
          company: item.candidates?.current_company || 'Unknown company',
          jobTitle: item.jobs?.job_title || 'Unknown job',
          clientName: item.jobs?.client_name || '',
          latest: item,
          unread: false,
          messages: [],
        });
      }
      const thread = threads.get(key);
      thread.messages.push(item);
      if (!item.read) thread.unread = true;
      if (!thread.latest?.sent_at || new Date(item.sent_at) > new Date(thread.latest.sent_at)) {
        thread.latest = item;
      }
    }
    return Array.from(threads.values()).sort((a, b) => new Date(b.latest?.sent_at || 0) - new Date(a.latest?.sent_at || 0));
  }

  function recentReplyPreview(candidateId) {
    const thread = groupInboxThreads(state.inbox).find((item) => item.candidateId === candidateId);
    return thread?.latest?.message_text || 'No reply summary yet.';
  }

  function stageCounts(candidates) {
    return PIPELINE_STAGES.reduce((acc, stage) => {
      acc[stage] = (candidates || []).filter((candidate) => {
        const pipelineStage = candidate.pipeline_stage === 'Rejected' ? 'Archived' : candidate.pipeline_stage;
        return pipelineStage === stage;
      }).length;
      return acc;
    }, {});
  }

  function renderPipelineBar(candidates) {
    const counts = stageCounts(candidates);
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0) || 1;
    return (
      '<div class="pipeline-bar">' +
        PIPELINE_STAGES.map((stage) => {
          const count = counts[stage] || 0;
          const width = Math.max(0, (count / total) * 100);
          return '<div class="pipeline-segment ' + (STAGE_COLORS[stage] || 'stage-default') + '" style="width:' + width + '%" title="' + esc(stage + ': ' + count) + '"></div>';
        }).join('') +
      '</div>' +
      '<div class="pipeline-legend">' +
        PIPELINE_STAGES.map((stage) => (
          '<div class="pipeline-legend-item"><span class="pipeline-swatch ' + (STAGE_COLORS[stage] || 'stage-default') + '"></span><span>' + esc(stage) + '</span><strong>' + (counts[stage] || 0) + '</strong></div>'
        )).join('') +
      '</div>'
    );
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
      state.selectedJobActivity = [];
      state.selectedJobApprovals = [];
      render();
      return;
    }

    const [job, candidates, activity, approvals] = await Promise.all([
      request('/api/jobs/' + jobId),
      request('/api/jobs/' + jobId + '/candidates?limit=200' + (state.selectedJobStageFilter !== 'all' ? '&stage=' + encodeURIComponent(state.selectedJobStageFilter) : '')),
      request('/api/jobs/' + jobId + '/activity' + (state.selectedActivityFilter !== 'all' ? '?eventType=' + encodeURIComponent(state.selectedActivityFilter) : '')),
      request('/api/jobs/' + jobId + '/approval-queue'),
    ]);

    state.selectedJobDetail = job;
    state.selectedJobCandidates = candidates;
    state.selectedJobActivity = activity;
    state.selectedJobApprovals = approvals;

    if (config.preserveDrafts) captureDrafts();
    render();
    if (config.preserveDrafts) restoreDrafts();
  }

  async function openCandidatePanel(candidateId) {
    state.candidatePanelId = candidateId;
    state.candidatePanelDetail = await request('/api/candidates/' + candidateId);
    render();
  }

  function closeCandidatePanel() {
    state.candidatePanelId = null;
    state.candidatePanelDetail = null;
    render();
  }

  function renderOverview() {
    const stats = state.stats || {};
    const jobs = getActiveJobs().map((job) => (
      '<tr>' +
        '<td><strong>' + esc(job.job_title || job.name) + '</strong><div class="cell-sub">' + esc(job.client_name || 'No client') + '</div></td>' +
        '<td>' + badge(job.status, 'stage') + '</td>' +
        '<td>' + (job.metrics?.candidates_sourced || 0) + '</td>' +
        '<td>' + (job.metrics?.outreach_sent || 0) + '</td>' +
        '<td>' + (job.metrics?.replies || 0) + '</td>' +
        '<td><button class="btn btn-secondary" data-action="select-job" data-job-id="' + esc(job.id) + '">Open</button></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="6">No active jobs yet.</td></tr>';

    const latestEvents = (state.activity || []).slice(0, 12).map((item) => (
      '<div class="event-row">' +
        eventBadge(item.event_type) +
        '<div class="event-summary">' + esc(item.summary || 'No summary') + '</div>' +
        '<div class="event-time">' + shortTime(item.created_at) + '</div>' +
      '</div>'
    )).join('') || '<div class="notice">No activity logged yet.</div>';

    return (
      '<section class="view-section">' +
        '<div class="metric-grid">' +
          '<div class="metric-card"><div class="metric-label">Total Sourced</div><div class="metric-value">' + (stats.candidates_sourced || 0) + '</div></div>' +
          '<div class="metric-card"><div class="metric-label">Outreach Sent</div><div class="metric-value">' + (stats.outreach_sent || 0) + '</div></div>' +
          '<div class="metric-card"><div class="metric-label">Replies</div><div class="metric-value">' + (stats.replies || 0) + '</div></div>' +
          '<div class="metric-card"><div class="metric-label">Active Jobs</div><div class="metric-value">' + (stats.active_jobs || 0) + '</div></div>' +
        '</div>' +
        '<div class="overview-grid">' +
          '<div class="table-card panel-large">' +
            '<div class="panel-head"><div><div class="label-caps">Pipelines</div><h2 class="section-title">Open Pipelines</h2></div></div>' +
            '<table><thead><tr><th>Job title</th><th>Status</th><th>Sourced</th><th>Outreach</th><th>Replies</th><th></th></tr></thead><tbody>' + jobs + '</tbody></table>' +
          '</div>' +
          '<div class="card panel-side">' +
            '<div class="label-caps">Live Activity</div><h2 class="section-title">Latest Events</h2>' +
            '<div id="activity-feed" class="event-feed push-top">' + latestEvents + '</div>' +
          '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function renderArchived() {
    const rows = getArchivedJobs().map((job) => (
      '<tr>' +
        '<td><strong>' + esc(job.job_title || job.name) + '</strong><div class="cell-sub">' + esc(job.client_name || 'No client') + '</div></td>' +
        '<td>' + badge(job.status, 'stage') + '</td>' +
        '<td>' + time(job.closed_at || job.created_at) + '</td>' +
        '<td>' + (job.metrics?.candidates_sourced || 0) + '</td>' +
        '<td><button class="btn btn-secondary" data-action="select-job" data-job-id="' + esc(job.id) + '">Open</button></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="5">No archived jobs yet.</td></tr>';

    return (
      '<section class="view-section">' +
        '<div class="table-card">' +
          '<div class="panel-head"><div><div class="label-caps">Archived</div><h2 class="section-title">Closed and Paused Searches</h2></div></div>' +
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

  function renderCandidateRow(candidate) {
    const normalizedStage = candidate.pipeline_stage === 'Rejected' ? 'Archived' : candidate.pipeline_stage;
    return (
      '<tr>' +
        '<td>' +
          '<div class="person-cell">' +
            '<div class="avatar ' + (GRADE_COLORS[candidate.fit_grade] || 'grade-default') + '">' + esc(initials(candidate.name)) + '</div>' +
            '<div>' +
              '<button class="text-link person-name" data-action="open-candidate" data-id="' + esc(candidate.id) + '">' + esc(candidate.name || 'Unknown') + '</button>' +
              '<div class="cell-sub truncate-one">' + esc((candidate.current_title || 'No title') + ' at ' + (candidate.current_company || 'Unknown company')) + '</div>' +
            '</div>' +
          '</div>' +
        '</td>' +
        '<td><span class="score-pill">' + (candidate.fit_score || 0) + '</span></td>' +
        '<td>' + badge(candidate.fit_grade || 'UNKNOWN', 'grade') + '</td>' +
        '<td>' + badge(normalizedStage || 'Unknown', 'stage') + '</td>' +
        '<td>' + enrichmentIcon(candidate) + '</td>' +
        '<td>' + shortTime(latestCandidateTimestamp(candidate)) + '</td>' +
        '<td>' +
          '<div class="button-row">' +
            '<a class="btn btn-secondary btn-xs" target="_blank" rel="noreferrer" href="' + esc(candidate.linkedin_url || '#') + '">View Profile</a>' +
            '<button class="btn btn-secondary btn-xs" data-action="archive-candidate" data-id="' + esc(candidate.id) + '">Skip</button>' +
            '<button class="btn btn-primary btn-xs" data-action="approve-candidate" data-id="' + esc(candidate.id) + '">Approve</button>' +
          '</div>' +
        '</td>' +
      '</tr>'
    );
  }

  function renderOutreachRows(candidates) {
    return candidates.map((candidate) => (
      '<tr>' +
        '<td><button class="text-link" data-action="open-candidate" data-id="' + esc(candidate.id) + '">' + esc(candidate.name || 'Unknown') + '</button></td>' +
        '<td>' + badge(candidate.pipeline_stage, 'stage') + '</td>' +
        '<td>' + shortTime(latestCandidateTimestamp(candidate)) + '</td>' +
        '<td>' + shortTime(candidate.follow_up_due_at) + '</td>' +
        '<td>' + esc(candidate.pipeline_stage === 'email_sent' ? 'Email' : 'LinkedIn') + '</td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="5">No active outreach in flight.</td></tr>';
  }

  function renderReplyRows(candidates) {
    return candidates.map((candidate) => (
      '<tr>' +
        '<td><button class="text-link" data-action="open-candidate" data-id="' + esc(candidate.id) + '">' + esc(candidate.name || 'Unknown') + '</button></td>' +
        '<td>' + esc(candidate.current_company || 'Unknown company') + '</td>' +
        '<td class="truncate-one">' + esc(recentReplyPreview(candidate.id).slice(0, 120)) + '</td>' +
        '<td>' + (candidate.pipeline_stage === 'Qualified' ? 'Yes' : 'No') + '</td>' +
        '<td>' + badge(candidate.pipeline_stage, 'stage') + '</td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="5">No replies yet.</td></tr>';
  }

  function renderActivityRows(items) {
    return (items || []).map((item) => (
      '<div class="activity-entry">' +
        '<div class="activity-meta">' + shortTime(item.created_at) + '</div>' +
        eventBadge(item.event_type) +
        '<div class="activity-summary">' + esc(item.summary || '') + '</div>' +
      '</div>'
    )).join('') || '<div class="notice">No activity for this job yet.</div>';
  }

  function renderJobOverview(job, candidates) {
    const counts = stageCounts(candidates);
    return (
      '<div class="detail-stack">' +
        '<div class="metric-grid">' +
          '<div class="metric-card"><div class="metric-label">Sourced</div><div class="metric-value">' + (job.metrics?.candidates_sourced || 0) + '</div></div>' +
          '<div class="metric-card"><div class="metric-label">Outreach Sent</div><div class="metric-value">' + (job.metrics?.outreach_sent || 0) + '</div></div>' +
          '<div class="metric-card"><div class="metric-label">Replies</div><div class="metric-value">' + (job.metrics?.replies || 0) + '</div></div>' +
          '<div class="metric-card"><div class="metric-label">Approvals Pending</div><div class="metric-value">' + (job.metrics?.approval_queue_count || 0) + '</div></div>' +
        '</div>' +
        '<div class="split split-rail">' +
          '<div class="card">' +
            '<div class="label-caps">Pipeline Snapshot</div><h2 class="section-title">Stage Breakdown</h2>' +
            '<div class="push-top">' + renderPipelineBar(candidates) + '</div>' +
            '<div class="snapshot-grid push-top">' +
              '<div class="snapshot-row"><span>Shortlisted</span><strong>' + (counts.Shortlisted || 0) + '</strong></div>' +
              '<div class="snapshot-row"><span>Invites Sent</span><strong>' + (counts.invite_sent || 0) + '</strong></div>' +
              '<div class="snapshot-row"><span>Invite Accepted</span><strong>' + (counts.invite_accepted || 0) + '</strong></div>' +
              '<div class="snapshot-row"><span>Replies</span><strong>' + (counts.Replied || 0) + '</strong></div>' +
            '</div>' +
          '</div>' +
          '<form id="job-settings-form" class="card form-grid" data-job-id="' + esc(job.id) + '">' +
            '<div class="form-span-2"><div class="label-caps">Job Settings</div><h2 class="section-title">Sending Window</h2></div>' +
            '<label><span>Send from</span><input class="input" name="send_from" type="time" value="' + esc(job.send_from || '08:00') + '" /></label>' +
            '<label><span>Send until</span><input class="input" name="send_until" type="time" value="' + esc(job.send_until || '18:00') + '" /></label>' +
            '<label><span>Timezone</span><input class="input" name="timezone" value="' + esc(job.timezone || 'Europe/London') + '" /></label>' +
            '<label><span>Active days</span><input class="input" name="active_days" value="' + esc(job.active_days || 'Mon,Tue,Wed,Thu,Fri') + '" /></label>' +
            '<label><span>LinkedIn daily limit</span><input class="input" name="linkedin_daily_limit" type="number" value="' + esc(job.linkedin_daily_limit || 28) + '" /></label>' +
            '<label><span>Status</span><input class="input" name="status" value="' + esc(job.status || 'ACTIVE') + '" readonly /></label>' +
            '<div class="form-span-2 button-row"><button class="btn btn-primary" type="submit">Save Settings</button></div>' +
          '</form>' +
        '</div>' +
      '</div>'
    );
  }

  function renderJobDetail() {
    const job = getSelectedJob();
    if (!job) return '<div class="notice">Create a job or select one to inspect the pipeline.</div>';

    const templates = parseTemplates(job.outreach_templates);
    const candidates = state.selectedJobCandidates || [];
    const shortlisted = candidates
      .filter((candidate) => (candidate.fit_score || 0) >= 60 && ['Shortlisted', 'Enriched', 'invite_sent', 'invite_accepted', 'dm_sent', 'email_sent', 'Replied', 'Qualified'].includes(candidate.pipeline_stage))
      .sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0));
    const outreach = candidates.filter((candidate) => ['invite_sent', 'invite_accepted', 'dm_sent', 'email_sent'].includes(candidate.pipeline_stage));
    const replies = candidates.filter((candidate) => ['Replied', 'Qualified'].includes(candidate.pipeline_stage));
    const activityFilters = ['all', 'AUTO_SOURCING', 'CANDIDATE_SOURCED', 'CANDIDATE_SCORED', 'ENRICHMENT_ATTEMPTED', 'MESSAGE_DRAFTED', 'MESSAGE_APPROVED', 'MESSAGE_SENT', 'INVITE_ACCEPTED', 'REPLY_RECEIVED', 'MESSAGE_SEND_ERROR'];

    const tabs = [
      ['overview', 'Overview'],
      ['rankings', 'Rankings'],
      ['outreach', 'Outreach'],
      ['replies', 'Replies'],
      ['activity', 'Activity'],
      ['templates', 'Templates'],
      ['assets', 'Assets'],
    ].map(([value, label]) => (
      '<button class="btn filter-pill ' + (state.jobsView === value ? 'active' : '') + '" data-action="set-job-view" data-job-view="' + esc(value) + '">' + esc(label) + '</button>'
    )).join('');

    const assetRows = (job.assets || []).map((asset) => (
      '<tr>' +
        '<td>' + esc(asset.name) + '</td>' +
        '<td>' + badge(asset.asset_type, 'stage') + '</td>' +
        '<td><a class="text-link" href="' + esc(asset.url) + '" target="_blank" rel="noreferrer">' + esc(formatUrl(asset.url)) + '</a> ' + copyButton(asset.url) + '</td>' +
        '<td><button class="btn btn-secondary btn-xs" data-action="delete-asset" data-asset-id="' + esc(asset.id) + '">Remove</button></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="4">No job assets yet.</td></tr>';

    let body = '';
    if (state.jobsView === 'rankings') {
      body =
        '<div class="table-card">' +
          '<div class="panel-head"><div><div class="label-caps">Rankings</div><h2 class="section-title">Shortlisted Candidates</h2></div></div>' +
          '<table><thead><tr><th>Name</th><th>Score</th><th>Fit Grade</th><th>Stage</th><th>Enriched</th><th>Last Activity</th><th>Actions</th></tr></thead><tbody>' + (shortlisted.map(renderCandidateRow).join('') || '<tr><td colspan="7">No shortlisted candidates yet.</td></tr>') + '</tbody></table>' +
        '</div>';
    } else if (state.jobsView === 'outreach') {
      body =
        '<div class="table-card">' +
          '<div class="panel-head"><div><div class="label-caps">Outreach</div><h2 class="section-title">Candidates in Outreach</h2></div></div>' +
          '<table><thead><tr><th>Name</th><th>Stage</th><th>Last Action</th><th>Next Follow-up</th><th>Channel</th></tr></thead><tbody>' + renderOutreachRows(outreach) + '</tbody></table>' +
        '</div>';
    } else if (state.jobsView === 'replies') {
      body =
        '<div class="table-card">' +
          '<div class="panel-head"><div><div class="label-caps">Replies</div><h2 class="section-title">Active Conversations</h2></div></div>' +
          '<table><thead><tr><th>Name</th><th>Company</th><th>Reply Summary</th><th>Qualified</th><th>Next Action</th></tr></thead><tbody>' + renderReplyRows(replies) + '</tbody></table>' +
        '</div>';
    } else if (state.jobsView === 'activity') {
      body =
        '<div class="card">' +
          '<div class="panel-head"><div><div class="label-caps">Activity</div><h2 class="section-title">Job Timeline</h2></div><div class="filters">' + activityFilters.map((filter) => (
            '<button class="btn filter-pill ' + (state.selectedActivityFilter === filter ? 'active' : '') + '" data-action="set-activity-filter" data-id="' + esc(filter) + '">' + esc(filter === 'all' ? 'All' : filter.replaceAll('_', ' ')) + '</button>'
          )).join('') + '</div></div>' +
          '<div class="activity-list push-top">' + renderActivityRows(state.selectedJobActivity) + '</div>' +
        '</div>';
    } else if (state.jobsView === 'templates') {
      body =
        '<form id="job-templates-form" class="card form-grid" data-job-id="' + esc(job.id) + '">' +
          '<div class="form-span-2"><div class="label-caps">Templates</div><h2 class="section-title">Outreach Guidance</h2></div>' +
          '<label class="form-span-2"><span>Connection request guidance</span><textarea class="input textarea" name="connection_request">' + esc(templates.connection_request || '') + '</textarea></label>' +
          '<label class="form-span-2"><span>LinkedIn DM guidance</span><textarea class="input textarea" name="linkedin_dm">' + esc(templates.linkedin_dm || '') + '</textarea></label>' +
          '<label class="form-span-2"><span>Email guidance</span><textarea class="input textarea" name="email">' + esc(templates.email || '') + '</textarea></label>' +
          '<label class="form-span-2"><span>Follow-up guidance</span><textarea class="input textarea" name="follow_up">' + esc(templates.follow_up || '') + '</textarea></label>' +
          '<div class="form-span-2 button-row"><button class="btn btn-primary" type="submit">Save Templates</button></div>' +
        '</form>';
    } else if (state.jobsView === 'assets') {
      body =
        '<div class="split split-rail">' +
          '<div class="table-card">' +
            '<div class="panel-head"><div><div class="label-caps">Assets</div><h2 class="section-title">Links and Collateral</h2></div></div>' +
            '<table><thead><tr><th>Name</th><th>Type</th><th>Link</th><th></th></tr></thead><tbody>' + assetRows + '</tbody></table>' +
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
    } else {
      body = renderJobOverview(job, candidates);
    }

    return (
      '<div class="detail-stack">' +
        '<div class="card hero-card">' +
          '<div class="hero-head">' +
            '<div>' +
              '<div class="label-caps">Selected Job</div>' +
              '<h2 class="section-title">' + esc(job.job_title || job.name) + '</h2>' +
              '<div class="hero-sub">' + esc(job.client_name || 'No client') + ' · ' + esc(job.location || 'No location') + ' · ' + money(job.salary_min, job.salary_max, job.currency) + '</div>' +
              '<div class="hero-sub">Send window: ' + esc(job.send_from || '08:00') + ' to ' + esc(job.send_until || '18:00') + ' · ' + esc(job.timezone || 'Europe/London') + ' · ' + esc(job.active_days || 'Mon,Tue,Wed,Thu,Fri') + '</div>' +
            '</div>' +
            '<div class="button-row">' +
              '<button class="btn btn-primary" data-action="source-now" data-job-id="' + esc(job.id) + '">Source Now</button>' +
              (job.status === 'ACTIVE' ? '<button class="btn btn-secondary" data-action="close-job" data-job-id="' + esc(job.id) + '">Close Job</button>' : '') +
              '<button class="btn btn-secondary" data-action="delete-job" data-job-id="' + esc(job.id) + '">Delete Job</button>' +
            '</div>' +
          '</div>' +
          '<div class="filters push-top">' + tabs + '</div>' +
        '</div>' +
        body +
      '</div>'
    );
  }

  function renderJobs() {
    const rows = getActiveJobs().map((job) => (
      '<tr>' +
        '<td><strong>' + esc(job.job_title || job.name) + '</strong><div class="cell-sub">' + esc(job.client_name || 'No client') + '</div></td>' +
        '<td>' + badge(job.status, 'stage') + '</td>' +
        '<td>' + (job.metrics?.candidates_sourced || 0) + '</td>' +
        '<td>' + (job.metrics?.outreach_sent || 0) + '</td>' +
        '<td>' + (job.metrics?.replies || 0) + '</td>' +
        '<td><button class="btn btn-secondary" data-action="select-job" data-job-id="' + esc(job.id) + '">Open</button></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="6">No jobs yet.</td></tr>';

    return (
      '<section class="view-section">' +
        '<div class="split split-rail">' +
          renderJobForm() +
          '<div class="table-card">' +
            '<div class="panel-head"><div><div class="label-caps">Active Jobs</div><h2 class="section-title">Pipeline Directory</h2></div></div>' +
            '<table><thead><tr><th>Job</th><th>Status</th><th>Sourced</th><th>Outreach</th><th>Replies</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '</div>' +
        '</div>' +
        renderJobDetail() +
      '</section>'
    );
  }

  function renderInbox() {
    const rows = groupInboxThreads(state.inbox).map((thread) => (
      '<div class="thread-row ' + (thread.unread ? 'thread-unread' : '') + '">' +
        '<div class="thread-main">' +
          '<button class="text-link person-name" data-action="open-candidate" data-id="' + esc(thread.candidateId) + '">' + esc(thread.candidateName) + '</button>' +
          '<div class="cell-sub">' + esc(thread.company) + ' · ' + esc(thread.jobTitle) + '</div>' +
          '<div class="thread-preview">' + esc((thread.latest?.message_text || '').slice(0, 100)) + '</div>' +
        '</div>' +
        '<div class="thread-meta">' +
          '<div>' + shortTime(thread.latest?.sent_at) + '</div>' +
          '<div>' + esc(thread.clientName || '—') + '</div>' +
        '</div>' +
      '</div>'
    )).join('') || '<div class="notice">No inbound messages yet.</div>';

    return (
      '<section class="view-section">' +
        '<div class="card">' +
          '<div class="label-caps">Inbox</div><h2 class="section-title">Conversation Threads</h2>' +
          '<div class="thread-list push-top">' + rows + '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function renderActivity() {
    return (
      '<section class="view-section">' +
        '<div class="card">' +
          '<div class="label-caps">Activity</div><h2 class="section-title">Global Feed</h2>' +
          '<div class="activity-list push-top">' + renderActivityRows(state.activity) + '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function renderApprovals() {
    const rows = (state.approvals || []).map((item) => (
      '<tr>' +
        '<td>' + esc(item.candidates?.name || 'Unknown') + '<div class="cell-sub">' + esc(item.jobs?.job_title || 'Unknown job') + '</div></td>' +
        '<td>' + badge(item.channel, 'stage') + '</td>' +
        '<td>' + badge(item.status, 'stage') + '</td>' +
        '<td class="truncate-one">' + esc((item.message_text || '').slice(0, 180)) + '</td>' +
        '<td>' + shortTime(item.created_at) + '</td>' +
        '<td><div class="button-row"><button class="btn btn-primary btn-xs" data-action="approve" data-id="' + esc(item.id) + '">Approve</button><button class="btn btn-secondary btn-xs" data-action="skip" data-id="' + esc(item.id) + '">Skip</button></div></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="6">No pending approvals.</td></tr>';

    return (
      '<section class="view-section">' +
        '<div class="table-card">' +
          '<div class="panel-head"><div><div class="label-caps">Approvals</div><h2 class="section-title">Human Review Queue</h2></div></div>' +
          '<table><thead><tr><th>Candidate</th><th>Channel</th><th>Status</th><th>Message</th><th>Created</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div>' +
      '</section>'
    );
  }

  function renderControls() {
    const runtime = state.runtime || {};
    const health = state.health || {};
    const modules = [
      ['outreachEnabled', 'Outreach'],
      ['followupEnabled', 'Follow-ups'],
      ['enrichmentEnabled', 'Enrichment'],
      ['researchEnabled', 'Research'],
      ['linkedinEnabled', 'LinkedIn'],
      ['postsEnabled', 'Posts'],
    ].map(([key, label]) => (
      '<div class="card toggle-card">' +
        '<div>' +
          '<div class="label-caps">Module</div>' +
          '<h2 class="section-title">' + esc(label) + '</h2>' +
          '<div class="cell-sub">' + (runtime[key] ? 'Enabled and live' : 'Disabled') + '</div>' +
        '</div>' +
        '<button class="toggle-switch ' + (runtime[key] ? 'is-on' : '') + '" data-action="toggle" data-key="' + esc(key) + '" aria-label="Toggle ' + esc(label) + '"><span></span></button>' +
      '</div>'
    )).join('');

    return (
      '<section class="view-section">' +
        '<div class="metric-grid">' +
          '<div class="metric-card"><div class="metric-label">System Status</div><div class="metric-value metric-value-small">' + esc(runtime.raxionStatus || 'ACTIVE') + '</div></div>' +
          '<div class="metric-card"><div class="metric-label">Pending Approvals</div><div class="metric-value">' + (health.pending_approvals || 0) + '</div></div>' +
          '<div class="metric-card"><div class="metric-label">Webhook Events</div><div class="metric-value">' + (health.webhook_events_logged || 0) + '</div></div>' +
          '<div class="metric-card"><div class="metric-label">Last Updated</div><div class="metric-value metric-value-small">' + shortTime(runtime.lastUpdated || health.server_time) + '</div></div>' +
        '</div>' +
        '<div class="grid grid-3">' + modules + '</div>' +
      '</section>'
    );
  }

  function renderCandidatePanel() {
    const candidate = state.candidatePanelDetail;
    if (!candidate) return '';
    const approvals = candidate.approvals || [];
    const conversations = candidate.conversation_history || [];
    return (
      '<div class="drawer-backdrop" data-action="close-candidate"></div>' +
      '<aside class="drawer">' +
        '<div class="drawer-head">' +
          '<div><div class="label-caps">Candidate</div><h2 class="section-title">' + esc(candidate.name || 'Unknown') + '</h2><div class="hero-sub">' + esc((candidate.current_title || 'No title') + ' at ' + (candidate.current_company || 'Unknown company')) + '</div></div>' +
          '<button class="btn btn-secondary btn-xs" data-action="close-candidate">Close</button>' +
        '</div>' +
        '<div class="drawer-body">' +
          '<div class="detail-card">' +
            '<div class="detail-grid">' +
              '<div><span class="detail-label">Location</span><strong>' + esc(candidate.location || '—') + '</strong></div>' +
              '<div><span class="detail-label">Score</span><strong>' + (candidate.fit_score || 0) + '</strong></div>' +
              '<div><span class="detail-label">Fit grade</span>' + badge(candidate.fit_grade || 'UNKNOWN', 'grade') + '</div>' +
              '<div><span class="detail-label">Stage</span>' + badge(candidate.pipeline_stage || 'Unknown', 'stage') + '</div>' +
            '</div>' +
            '<div class="push-top button-row"><a class="btn btn-primary" target="_blank" rel="noreferrer" href="' + esc(candidate.linkedin_url || '#') + '">LinkedIn Profile</a>' + copyButton(candidate.linkedin_url) + '<button class="btn btn-secondary" data-action="sync-ats" data-id="' + esc(candidate.id) + '">Sync to ATS</button></div>' +
          '</div>' +
          '<div class="detail-card"><div class="detail-label">Fit rationale</div><p>' + esc(candidate.fit_rationale || 'No rationale captured.') + '</p></div>' +
          '<div class="detail-card"><div class="detail-label">Skills</div><p>' + esc(candidate.tech_skills || 'No skills captured.') + '</p></div>' +
          '<div class="detail-card"><div class="detail-label">Past employers</div><p>' + esc(candidate.past_employers || 'No employer history captured.') + '</p></div>' +
          '<div class="detail-card"><div class="detail-label">Approvals</div>' + (approvals.length ? approvals.map((approval) => (
            '<div class="approval-inline"><div>' + badge(approval.channel, 'stage') + ' ' + badge(approval.status, 'stage') + '</div><div class="thread-preview">' + esc((approval.message_text || '').slice(0, 160)) + '</div></div>'
          )).join('') : '<p>No queued approvals.</p>') + '</div>' +
          '<div class="detail-card"><div class="detail-label">Conversation history</div>' + (conversations.length ? conversations.map((message) => (
            '<div class="conversation-item ' + (message.direction === 'inbound' ? 'inbound' : 'outbound') + '"><div class="conversation-meta">' + esc(message.channel || 'message') + ' · ' + shortTime(message.sent_at) + '</div><div>' + esc(message.message_text || '') + '</div></div>'
          )).join('') : '<p>No conversation history yet.</p>') + '</div>' +
          '<div class="button-row"><button class="btn btn-primary" data-action="approve-candidate" data-id="' + esc(candidate.id) + '">Approve Message</button><button class="btn btn-secondary" data-action="archive-candidate" data-id="' + esc(candidate.id) + '">Archive</button><button class="btn btn-secondary" data-action="skip-candidate-approval" data-id="' + esc(candidate.id) + '">Skip Approval</button></div>' +
        '</div>' +
      '</aside>'
    );
  }

  function render() {
    captureDrafts();
    setActiveNav();
    if (state.loading) {
      app.innerHTML = '<div class="card">Loading Mission Control...</div>';
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
    app.innerHTML = view() + renderCandidatePanel();
    restoreDrafts();
  }

  async function approveFirstCandidateApproval(candidateId) {
    const detail = state.candidatePanelDetail?.id === candidateId ? state.candidatePanelDetail : await request('/api/candidates/' + candidateId);
    const approval = (detail.approvals || []).find((item) => ['pending', 'edited'].includes(item.status));
    if (!approval) {
      showToast('No pending approval for this candidate.');
      return;
    }
    await request('/api/approval-queue/' + approval.id + '/approve', { method: 'POST' });
    showToast('Approval marked for the next sending window.');
    await loadCoreData({ preserveDrafts: true });
    if (state.selectedJobId) await loadSelectedJob(state.selectedJobId, { preserveDrafts: true });
    if (state.candidatePanelId) await openCandidatePanel(state.candidatePanelId);
  }

  async function skipFirstCandidateApproval(candidateId) {
    const detail = state.candidatePanelDetail?.id === candidateId ? state.candidatePanelDetail : await request('/api/candidates/' + candidateId);
    const approval = (detail.approvals || []).find((item) => ['pending', 'edited', 'approved'].includes(item.status));
    if (!approval) {
      showToast('No approval to skip.');
      return;
    }
    await request('/api/approval-queue/' + approval.id + '/skip', { method: 'POST' });
    showToast('Approval skipped.');
    await loadCoreData({ preserveDrafts: true });
    if (state.selectedJobId) await loadSelectedJob(state.selectedJobId, { preserveDrafts: true });
    if (state.candidatePanelId) await openCandidatePanel(state.candidatePanelId);
  }

  async function archiveCandidate(candidateId) {
    await request('/api/candidates/' + candidateId + '/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'Archived' }),
    });
    showToast('Candidate archived.');
    await loadCoreData({ preserveDrafts: true });
    if (state.selectedJobId) await loadSelectedJob(state.selectedJobId, { preserveDrafts: true });
    if (state.candidatePanelId === candidateId) closeCandidatePanel();
  }

  async function handleAction(action, id, extra, sourceEl) {
    if (action === 'approve') {
      await request('/api/approval-queue/' + id + '/approve', { method: 'POST' });
      showToast('Approval marked for the next sending window.');
      await loadCoreData({ preserveDrafts: true });
      return;
    }

    if (action === 'skip') {
      await request('/api/approval-queue/' + id + '/skip', { method: 'POST' });
      showToast('Approval skipped.');
      await loadCoreData({ preserveDrafts: true });
      return;
    }

    if (action === 'select-job') {
      state.view = 'jobs';
      state.jobsView = 'overview';
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
      await loadCoreData({ preserveDrafts: true });
      state.view = 'controls';
      render();
      return;
    }

    if (action === 'delete-asset') {
      await request('/api/jobs/' + state.selectedJobId + '/assets/' + id, { method: 'DELETE' });
      await loadSelectedJob(state.selectedJobId, { preserveDrafts: true });
      return;
    }

    if (action === 'set-job-view') {
      state.jobsView = extra;
      render();
      return;
    }

    if (action === 'set-activity-filter') {
      state.selectedActivityFilter = id;
      await loadSelectedJob(state.selectedJobId, { preserveDrafts: true });
      return;
    }

    if (action === 'source-now') {
      await request('/api/jobs/' + id + '/source-now', { method: 'POST' });
      showToast('Sourcing triggered. Watch Rankings and Activity.');
      state.jobsView = 'rankings';
      await loadCoreData({ preserveDrafts: true });
      await loadSelectedJob(id, { preserveDrafts: true });
      return;
    }

    if (action === 'close-job') {
      await request('/api/jobs/' + id + '/close', { method: 'POST' });
      showToast('Job closed.');
      state.view = 'archived';
      window.location.hash = 'archived';
      await loadCoreData({ preserveDrafts: true });
      return;
    }

    if (action === 'delete-job') {
      const confirmed = window.confirm('Delete this job and all related candidates from Raxion?');
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
      return;
    }

    if (action === 'open-candidate') {
      await openCandidatePanel(id);
      return;
    }

    if (action === 'close-candidate') {
      closeCandidatePanel();
      return;
    }

    if (action === 'copy-url') {
      await navigator.clipboard.writeText(sourceEl?.dataset.url || '');
      showToast('Link copied.');
      return;
    }

    if (action === 'archive-candidate') {
      await archiveCandidate(id);
      return;
    }

    if (action === 'approve-candidate') {
      await approveFirstCandidateApproval(id);
      return;
    }

    if (action === 'skip-candidate-approval') {
      await skipFirstCandidateApproval(id);
      return;
    }

    if (action === 'sync-ats') {
      await request('/api/candidates/' + id + '/sync-ats', { method: 'POST' });
      showToast('ATS sync triggered.');
      return;
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
          actionEl,
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
      const payload = Object.fromEntries(new FormData(event.target).entries());
      payload.name = payload.job_title;
      payload.status = 'ACTIVE';
      if (payload.salary_min) payload.salary_min = Number(payload.salary_min);
      if (payload.salary_max) payload.salary_max = Number(payload.salary_max);
      const result = await request('/api/jobs/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      event.target.reset();
      state.view = 'jobs';
      state.jobsView = 'overview';
      await loadCoreData();
      await loadSelectedJob(result.job_id);
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
        await loadSelectedJob(jobId, { preserveDrafts: true });
      } catch (error) {
        showToast(error.message.indexOf('job_assets') >= 0 ? 'Run migration 003_raxion_dashboard_assets.sql before using assets.' : error.message, 'error');
      }
      return;
    }

    if (event.target.id === 'job-settings-form') {
      event.preventDefault();
      const jobId = event.target.dataset.jobId;
      const payload = Object.fromEntries(new FormData(event.target).entries());
      if (payload.linkedin_daily_limit) payload.linkedin_daily_limit = Number(payload.linkedin_daily_limit);
      await request('/api/jobs/' + jobId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('Job settings saved.');
      await loadCoreData({ preserveDrafts: true });
      await loadSelectedJob(jobId, { preserveDrafts: true });
      return;
    }

    if (event.target.id === 'job-templates-form') {
      event.preventDefault();
      const jobId = event.target.dataset.jobId;
      const form = Object.fromEntries(new FormData(event.target).entries());
      await request('/api/jobs/' + jobId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outreach_templates: form }),
      });
      showToast('Templates saved.');
      await loadCoreData({ preserveDrafts: true });
      await loadSelectedJob(jobId, { preserveDrafts: true });
    }
  });

  window.addEventListener('hashchange', () => {
    state.view = (window.location.hash || '#overview').slice(1) || 'overview';
    render();
  });

  const stream = new EventSource('/api/activity/stream');
  stream.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      state.activity = [payload, ...(state.activity || [])].slice(0, 100);
      const jobId = state.selectedJobDetail?.id;
      if (jobId && payload.job_id === jobId) {
        state.selectedJobActivity = [payload, ...(state.selectedJobActivity || [])].slice(0, 200);
      }
      if (document.visibilityState === 'visible' && state.view === 'overview') render();
    } catch {
      return;
    }
  };

  loadCoreData().catch((error) => {
    app.innerHTML = '<div class="card">Failed to load dashboard: ' + esc(error.message) + '</div>';
  });
}());
