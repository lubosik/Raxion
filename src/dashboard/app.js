(function () {
  const state = {
    view: (window.location.hash || '#overview').slice(1) || 'overview',
    stats: null,
    jobs: [],
    jobCandidates: {},
    inbox: [],
    activity: [],
    approvals: [],
    runtime: null,
    health: null,
    config: [],
    selectedJobId: null,
    selectedJobDetail: null,
    selectedJobCandidates: [],
    selectedJobActivity: [],
    selectedJobApprovals: [],
    selectedJobTab: 'all_candidates',
    selectedActivityGroup: 'all',
    selectedGlobalActivityGroup: 'all',
    selectedJobActivityType: 'all',
    showCreateJobForm: false,
    candidatePanelId: null,
    candidatePanelDetail: null,
    loading: false,
  };

  const app = document.getElementById('app');
  const toastWrap = document.createElement('div');
  toastWrap.className = 'toast-wrap';
  document.body.appendChild(toastWrap);

  const STAGE_META = {
    Sourced: { cls: 'stage-sourced', label: 'Sourced' },
    Shortlisted: { cls: 'stage-shortlisted', label: 'Shortlisted' },
    Enriched: { cls: 'stage-enriched', label: 'Enriched' },
    invite_sent: { cls: 'stage-invite', label: 'Invite Sent' },
    invite_accepted: { cls: 'stage-accepted', label: 'Invite Accepted' },
    dm_sent: { cls: 'stage-dm', label: 'DM Sent' },
    email_sent: { cls: 'stage-email', label: 'Email Sent' },
    Replied: { cls: 'stage-replied', label: 'Replied' },
    Qualified: { cls: 'stage-qualified', label: 'Qualified' },
    Rejected: { cls: 'stage-rejected', label: 'Rejected' },
    Archived: { cls: 'stage-archived', label: 'Archived' },
    Withdrawn: { cls: 'stage-withdrawn', label: 'Withdrawn' },
    Placed: { cls: 'stage-placed', label: 'Placed' },
  };

  const JOB_TABS = [
    ['overview', 'Overview'],
    ['all_candidates', 'All Candidates'],
    ['shortlisted', 'Shortlisted'],
    ['ranked', 'Ranked'],
    ['outreach', 'Outreach'],
    ['replies', 'Replies'],
    ['archived', 'Archived'],
    ['activity', 'Activity'],
    ['templates', 'Templates'],
  ];

  const ACTIVITY_GROUPS = [
    ['all', 'All Types'],
    ['messages', 'Messages'],
    ['enrichment', 'Enrichment'],
    ['outreach', 'Outreach'],
    ['replies', 'Replies'],
    ['errors', 'Errors'],
  ];

  const JOB_ACTIVITY_TYPES = [
    'all',
    'AUTO_SOURCING',
    'CANDIDATE_SOURCED',
    'CANDIDATE_SCORED',
    'ENRICHMENT_ATTEMPTED',
    'MESSAGE_DRAFTED',
    'MESSAGE_APPROVED',
    'MESSAGE_SENT',
    'INVITE_SENT',
    'INVITE_ACCEPTED',
    'REPLY_RECEIVED',
    'MESSAGE_SEND_ERROR',
  ];

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function request(path, options) {
    return fetch(path, options).then(async (response) => {
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
    });
  }

  function showToast(message, tone) {
    const el = document.createElement('div');
    el.className = 'toast' + (tone ? ` ${tone}` : '');
    el.textContent = message;
    toastWrap.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function stageInfo(stage) {
    return STAGE_META[stage] || { cls: 'stage-default', label: stage || 'Unknown' };
  }

  function stageChip(stage) {
    const meta = stageInfo(stage);
    return `<span class="stage-chip ${meta.cls}">${esc(meta.label)}</span>`;
  }

  function scoreClass(score) {
    if (score >= 75) return 'score-high';
    if (score >= 50) return 'score-mid';
    return 'score-low';
  }

  function scorePill(score) {
    return `<span class="score-pill ${scoreClass(Number(score || 0))}">${Number(score || 0)}</span>`;
  }

  function initials(name) {
    return String(name || 'Unknown')
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] || '')
      .join('')
      .toUpperCase() || 'U';
  }

  function gradeClass(grade) {
    if (grade === 'HOT') return 'avatar-hot';
    if (grade === 'WARM') return 'avatar-warm';
    return 'avatar-possible';
  }

  function formatTime(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatDateTime(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString();
  }

  function statusChip(status) {
    const mapping = {
      ACTIVE: 'job-active',
      PAUSED: 'job-paused',
      CLOSED: 'job-closed',
    };
    return `<span class="stage-chip ${mapping[status] || 'job-closed'}">${esc(status || 'Unknown')}</span>`;
  }

  function candidateLastAction(candidate) {
    return candidate.last_reply_at || candidate.dm_sent_at || candidate.invite_accepted_at || candidate.invite_sent_at || candidate.created_at;
  }

  function profileButton(url) {
    return url
      ? `<a class="btn btn-secondary btn-sm" href="${esc(url)}" target="_blank" rel="noreferrer">View Profile</a>`
      : '<span class="muted-inline">No profile</span>';
  }

  function percent(numerator, denominator) {
    if (!denominator) return '0%';
    return `${Math.round((Number(numerator || 0) / Number(denominator || 0)) * 100)}%`;
  }

  function scrollToId(id) {
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function getActiveJobs() {
    return (state.jobs || []).filter((job) => job.status === 'ACTIVE' && !job.paused);
  }

  function getArchivedJobs() {
    return (state.jobs || []).filter((job) => job.status !== 'ACTIVE' || job.paused);
  }

  function getJobCandidates(jobId) {
    return state.jobCandidates[jobId] || [];
  }

  function isShortlistedCandidate(candidate) {
    return Number(candidate?.fit_score || 0) >= 60 && !['Archived', 'Rejected', 'Withdrawn'].includes(candidate?.pipeline_stage);
  }

  function candidateStageCounts(candidates) {
    const counts = {};
    for (const candidate of candidates || []) {
      const stage = candidate.pipeline_stage || 'Unknown';
      counts[stage] = (counts[stage] || 0) + 1;
    }
    return counts;
  }

  function getJobCounts(jobId) {
    const candidates = getJobCandidates(jobId);
    const counts = candidateStageCounts(candidates);
    return {
      sourced: counts.Sourced || 0,
      shortlisted: candidates.filter(isShortlistedCandidate).length,
      outreach: (counts.invite_sent || 0) + (counts.invite_accepted || 0) + (counts.dm_sent || 0) + (counts.email_sent || 0),
      replies: (counts.Replied || 0) + (counts.Qualified || 0),
    };
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

  function getScheduleWindows(job) {
    const templates = parseTemplates(job?.outreach_templates);
    const scheduleWindows = templates.schedule_windows || {};
    const fallback = {
      send_from: job?.send_from || '08:00',
      send_until: job?.send_until || '18:00',
    };

    return {
      default: {
        send_from: fallback.send_from,
        send_until: fallback.send_until,
      },
      linkedin_invite: {
        send_from: scheduleWindows.linkedin_invite?.send_from || fallback.send_from,
        send_until: scheduleWindows.linkedin_invite?.send_until || fallback.send_until,
      },
      linkedin_dm: {
        send_from: scheduleWindows.linkedin_dm?.send_from || fallback.send_from,
        send_until: scheduleWindows.linkedin_dm?.send_until || fallback.send_until,
      },
      email: {
        send_from: scheduleWindows.email?.send_from || fallback.send_from,
        send_until: scheduleWindows.email?.send_until || fallback.send_until,
      },
    };
  }

  function activityGroupFor(eventType) {
    const type = String(eventType || '');
    if (/ERROR|FAILED/.test(type)) return 'errors';
    if (/REPLY|QUALIFIED/.test(type)) return 'replies';
    if (/ENRICHMENT/.test(type)) return 'enrichment';
    if (/INVITE|MESSAGE_SENT|OUTSIDE_SENDING_WINDOW/.test(type)) return 'outreach';
    if (/MESSAGE_/.test(type)) return 'messages';
    return 'all';
  }

  function activityChipClass(eventType) {
    const type = String(eventType || '');
    if (type === 'MESSAGE_DRAFTED' || type === 'MESSAGE_APPROVED' || type === 'MESSAGE_SENT') return 'chip-message';
    if (type === 'ENRICHMENT_ATTEMPTED' || type === 'CANDIDATE_ENRICHMENT_NO_DATA' || type === 'CANDIDATE_ENRICHED') return 'chip-enrichment';
    if (type === 'INVITE_SENT') return 'chip-invite';
    if (type === 'INVITE_ACCEPTED') return 'chip-accepted';
    if (type === 'REPLY_RECEIVED' || type === 'CANDIDATE_QUALIFIED') return 'chip-reply';
    if (/ERROR|FAILED/.test(type)) return 'chip-error';
    if (type === 'OUTSIDE_SENDING_WINDOW') return 'chip-window';
    return 'chip-default';
  }

  function filterActivities(items, group) {
    if (group === 'all') return items || [];
    return (items || []).filter((item) => activityGroupFor(item.event_type) === group);
  }

  function renderActivityRows(items) {
    return (items || []).slice(0, 50).map((item) => {
      const muted = item.event_type === 'OUTSIDE_SENDING_WINDOW' ? ' activity-muted' : '';
      return (
        `<div class="activity-event-row${muted}">` +
          `<span class="activity-timestamp">${esc(formatTime(item.created_at))}</span>` +
          `<span class="activity-chip ${activityChipClass(item.event_type)}">${esc(item.event_type)}</span>` +
          `<span class="activity-description">${esc(item.summary || '')}</span>` +
        '</div>'
      );
    }).join('') || '<div class="empty-state">No activity yet.</div>';
  }

  function renderProgressBar(counts) {
    const total = Math.max(1, counts.sourced + counts.shortlisted + counts.outreach + counts.replies);
    const segments = [
      ['stage-sourced', counts.sourced],
      ['stage-shortlisted', counts.shortlisted],
      ['stage-invite', counts.outreach],
      ['stage-replied', counts.replies],
    ];
    return (
      '<div class="mini-progress">' +
        segments.map(([cls, count]) => `<span class="mini-progress-segment ${cls}" style="width:${(count / total) * 100}%"></span>`).join('') +
      '</div>'
    );
  }

  async function loadCoreData() {
    state.loading = true;
    render();

    const [stats, jobs, inbox, activity, approvals, runtime, health, config] = await Promise.all([
      request('/api/stats'),
      request('/api/jobs'),
      request('/api/inbox'),
      request('/api/activity'),
      request('/api/approval-queue'),
      request('/api/state'),
      request('/api/health'),
      request('/api/config'),
    ]);

    const candidateResponses = await Promise.all(
      (jobs || []).map(async (job) => [job.id, await request(`/api/jobs/${job.id}/candidates?limit=500`)]),
    );

    state.stats = stats;
    state.jobs = jobs || [];
    state.inbox = inbox || [];
    state.activity = activity || [];
    state.approvals = (approvals || []).filter((item) => item.channel !== 'connection_request');
    state.runtime = runtime;
    state.health = health;
    state.config = config || [];
    state.jobCandidates = Object.fromEntries(candidateResponses);
    state.selectedJobId = state.selectedJobId || getActiveJobs()[0]?.id || jobs?.[0]?.id || null;
    state.loading = false;

    if (state.selectedJobId) {
      await loadSelectedJob(state.selectedJobId);
      return;
    }
    render();
  }

  async function loadSelectedJob(jobId) {
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
      request(`/api/jobs/${jobId}`),
      request(`/api/jobs/${jobId}/candidates?limit=500`),
      request(`/api/jobs/${jobId}/activity`),
      request(`/api/jobs/${jobId}/approval-queue`),
    ]);

    state.selectedJobDetail = job;
    state.selectedJobCandidates = candidates || [];
    state.selectedJobActivity = activity || [];
    state.selectedJobApprovals = (approvals || []).filter((item) => item.channel !== 'connection_request');
    state.jobCandidates[jobId] = candidates || [];
    render();
  }

  async function openCandidatePanel(candidateId) {
    state.candidatePanelId = candidateId;
    const detail = await request(`/api/candidates/${candidateId}`);
    detail.approvals = (detail.approvals || []).filter((item) => item.channel !== 'connection_request');
    state.candidatePanelDetail = detail;
    render();
  }

  function closeCandidatePanel() {
    state.candidatePanelId = null;
    state.candidatePanelDetail = null;
    render();
  }

  function renderOverview() {
    const stats = state.stats || {};
    const rows = getActiveJobs().map((job) => {
      const counts = getJobCounts(job.id);
      return (
        '<tr>' +
          `<td><strong>${esc(job.job_title || job.name)}</strong></td>` +
          `<td>${esc(job.client_name || '—')}</td>` +
          `<td>${statusChip(job.status)}</td>` +
          `<td>${counts.sourced}</td>` +
          `<td>${counts.shortlisted}</td>` +
          `<td>${counts.outreach}</td>` +
          `<td>${counts.replies}</td>` +
          `<td>${renderProgressBar(counts)}</td>` +
          `<td><button class="btn btn-primary btn-sm" data-action="open-job" data-id="${esc(job.id)}">View</button></td>` +
        '</tr>'
      );
    }).join('') || '<tr><td colspan="9">No active jobs.</td></tr>';

    return (
      '<section class="view-section">' +
        '<div class="metric-strip">' +
          `<div class="metric-card strip-card"><div class="metric-number">${stats.candidates_sourced || 0}</div><div class="metric-caption">Total Sourced</div></div>` +
          `<div class="metric-card strip-card"><div class="metric-number">${stats.invites_sent || 0}</div><div class="metric-caption">LinkedIn Requests</div></div>` +
          `<div class="metric-card strip-card"><div class="metric-number">${percent(stats.invites_accepted, stats.invites_sent)}</div><div class="metric-caption">LinkedIn Acceptance Rate</div></div>` +
          `<div class="metric-card strip-card"><div class="metric-number">${stats.emails_sent || 0}</div><div class="metric-caption">Emails Sent</div></div>` +
          `<div class="metric-card strip-card"><div class="metric-number">${percent(stats.email_replies, stats.emails_sent)}</div><div class="metric-caption">Email Reply Rate</div></div>` +
          `<div class="metric-card strip-card"><div class="metric-number">${stats.replies || 0}</div><div class="metric-caption">Replies</div></div>` +
          `<div class="metric-card strip-card"><div class="metric-number">${stats.active_jobs || 0}</div><div class="metric-caption">Active Jobs</div></div>` +
        '</div>' +
        '<div class="surface">' +
          '<div class="section-head"><div><div class="label-caps">Pipelines</div><h2 class="section-title">Open Pipelines</h2></div></div>' +
          '<div class="table-shell"><table><thead><tr><th>Job Title</th><th>Client</th><th>Status</th><th>Sourced</th><th>Shortlisted</th><th>Outreach</th><th>Replies</th><th>Progress</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '</div>' +
        '<div class="surface">' +
          '<div class="section-head"><div><div class="label-caps">Live Activity</div><h2 class="section-title">Latest Events</h2></div><select class="select" data-action="set-activity-group" data-id="overview"><option value="all"' + (state.selectedActivityGroup === 'all' ? ' selected' : '') + '>All Types</option><option value="messages"' + (state.selectedActivityGroup === 'messages' ? ' selected' : '') + '>Messages</option><option value="enrichment"' + (state.selectedActivityGroup === 'enrichment' ? ' selected' : '') + '>Enrichment</option><option value="outreach"' + (state.selectedActivityGroup === 'outreach' ? ' selected' : '') + '>Outreach</option><option value="replies"' + (state.selectedActivityGroup === 'replies' ? ' selected' : '') + '>Replies</option><option value="errors"' + (state.selectedActivityGroup === 'errors' ? ' selected' : '') + '>Errors</option></select></div>' +
          '<div class="activity-feed">' + renderActivityRows(filterActivities(state.activity, state.selectedActivityGroup)) + '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function renderJobCard(job) {
    const counts = getJobCounts(job.id);
    const borderClass = job.status === 'ACTIVE' ? 'job-border-active' : job.status === 'PAUSED' ? 'job-border-paused' : 'job-border-closed';
    const selectedClass = state.selectedJobId === job.id ? ' is-selected' : '';
    return (
      '<article class="job-card ' + borderClass + selectedClass + '">' +
        `<div class="job-card-head"><div><h3 class="job-card-title">${esc(job.job_title || job.name)}</h3><div class="job-card-sub">${esc(job.client_name || 'Unknown client')} · ${esc(job.location || 'No location')}</div></div>${statusChip(job.status)}</div>` +
        '<div class="job-bars">' +
          `<div class="job-bar-row"><span>${renderProgressBar({ sourced: counts.sourced, shortlisted: 0, outreach: 0, replies: 0 })}</span><strong>${counts.sourced} sourced</strong></div>` +
          `<div class="job-bar-row"><span>${renderProgressBar({ sourced: 0, shortlisted: counts.shortlisted, outreach: 0, replies: 0 })}</span><strong>${counts.shortlisted} shortlisted</strong></div>` +
          `<div class="job-bar-row"><span>${renderProgressBar({ sourced: 0, shortlisted: 0, outreach: counts.outreach, replies: 0 })}</span><strong>${counts.outreach} outreach</strong></div>` +
        '</div>' +
        `<div class="button-row"><button class="btn btn-primary btn-sm" data-action="open-job" data-id="${esc(job.id)}">View</button><button class="btn btn-secondary btn-sm" data-action="source-now" data-id="${esc(job.id)}">Source Now</button><button class="btn btn-danger btn-sm" data-action="close-job" data-id="${esc(job.id)}">Close</button></div>` +
      '</article>'
    );
  }

  function renderCreateJobForm() {
    if (!state.showCreateJobForm) return '';
    return (
      '<form id="job-create-form" class="surface form-grid create-job-form">' +
        '<div class="form-span-2"><div class="label-caps">Launch Job</div><h2 class="section-title">Create New Pipeline</h2><div class="job-detail-sub">Add the brief here, then Raxion can source and sequence from this pipeline immediately.</div></div>' +
        '<label><span>Job Title</span><input class="input" name="job_title" required placeholder="Senior Recruitment Consultant" /></label>' +
        '<label><span>Client</span><input class="input" name="client_name" required placeholder="LIBDR" /></label>' +
        '<label><span>Location</span><input class="input" name="location" placeholder="United States" /></label>' +
        '<label><span>Sector</span><input class="input" name="sector" placeholder="Recruitment" /></label>' +
        '<label><span>Seniority</span><input class="input" name="seniority_level" placeholder="Senior" /></label>' +
        '<label><span>Must-have Skills</span><input class="input" name="tech_stack_must" placeholder="Recruitment, BD, LinkedIn outreach" /></label>' +
        '<label><span>Timezone</span><input class="input" name="timezone" placeholder="Europe/London" /></label>' +
        '<label><span>Send Window Start</span><input class="input" name="send_from" placeholder="09:00" /></label>' +
        '<label><span>Send Window End</span><input class="input" name="send_until" placeholder="17:00" /></label>' +
        '<label><span>LinkedIn Daily Limit</span><input class="input" name="linkedin_daily_limit" type="number" min="1" placeholder="28" /></label>' +
        '<label class="form-span-2"><span>Role Notes</span><textarea class="input textarea" name="notes" placeholder="What makes a good candidate, market notes, messaging context, client nuances."></textarea></label>' +
        '<div class="form-span-2 button-row"><button class="btn btn-primary" type="submit">Create Job</button><button class="btn btn-secondary" type="button" data-action="toggle-create-job" data-id="off">Cancel</button></div>' +
      '</form>'
    );
  }

  function renderCandidateTable(candidates, options = {}) {
    const { showJob = false, archived = false, outreach = false, replies = false } = options;
    const rows = (candidates || []).map((candidate) => {
      const detailLines = [
        candidate.current_title || 'No title',
        candidate.current_company || 'No company',
      ].filter(Boolean).join(' · ');
      const job = state.jobs.find((item) => item.id === candidate.job_id);
      return (
        '<tr>' +
          `<td><div class="candidate-primary"><button class="text-link candidate-name" data-action="open-candidate" data-id="${esc(candidate.id)}">${esc(candidate.name || 'Unknown')}</button><div class="candidate-sub">${esc(detailLines)}</div></div></td>` +
          (showJob ? `<td>${esc(job?.job_title || '—')}</td>` : '') +
          `<td>${esc(candidate.current_company || '—')}</td>` +
          `<td>${scorePill(candidate.fit_score)}</td>` +
          `<td>${stageChip(candidate.pipeline_stage)}</td>` +
          `<td><span class="enrichment-mark ${candidate.enrichment_status === 'Enriched' ? 'good' : candidate.enrichment_status === 'No Data' ? 'empty' : candidate.enrichment_status === 'Failed' ? 'bad' : 'pending'}"></span></td>` +
          (archived ? `<td>${esc((candidate.notes || '').slice(0, 80) || 'Archived')}</td>` : '') +
          (outreach ? `<td>${esc(candidate.pipeline_stage.includes('email') ? 'Email' : 'LinkedIn')}</td><td>${esc(formatTime(candidateLastAction(candidate)))}</td><td>${esc(formatTime(candidate.follow_up_due_at))}</td>` : '') +
          (replies ? `<td>${esc(((state.inbox.find((item) => item.candidate_id === candidate.id) || {}).message_text || '').slice(0, 80) || 'No reply summary')}</td><td>${candidate.pipeline_stage === 'Qualified' ? '<span class="stage-chip stage-qualified">Yes</span>' : '<span class="stage-chip stage-sourced">No</span>'}</td><td>${stageChip(candidate.pipeline_stage)}</td>` : '') +
          `<td>${esc(formatTime(candidateLastAction(candidate)))}</td>` +
          `<td><div class="button-row">${profileButton(candidate.linkedin_url)}<button class="btn btn-secondary btn-sm" data-action="${archived ? 'reinstate-candidate' : 'archive-candidate'}" data-id="${esc(candidate.id)}">${archived ? 'Reinstate' : 'Archive'}</button></div></td>` +
        '</tr>'
      );
    }).join('') || '<tr><td colspan="' + (showJob ? '8' : archived ? '8' : outreach ? '10' : replies ? '10' : '7') + '">No candidates in this view.</td></tr>';

    return (
      '<div class="table-shell"><table><thead><tr>' +
        '<th>Name</th>' +
        (showJob ? '<th>Job</th>' : '') +
        '<th>Company</th><th>Score</th><th>Stage</th><th>Enriched</th>' +
        (archived ? '<th>Reason Archived</th>' : '') +
        (outreach ? '<th>Channel</th><th>Last Action</th><th>Next Follow-up</th>' : '') +
        (replies ? '<th>Reply Summary</th><th>Qualified</th><th>Next Action</th>' : '') +
        '<th>Last Activity</th><th>Actions</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    );
  }

  function renderJobDetail() {
    const job = state.selectedJobDetail;
    if (!job) return '<div class="empty-state">Select a job to inspect the pipeline.</div>';

    const all = state.selectedJobCandidates || [];
    const shortlisted = all.filter(isShortlistedCandidate);
    const ranked = [...all].sort((a, b) => Number(b.fit_score || 0) - Number(a.fit_score || 0));
    const outreach = all.filter((candidate) => ['invite_sent', 'invite_accepted', 'dm_sent', 'email_sent'].includes(candidate.pipeline_stage));
    const replies = all.filter((candidate) => ['Replied', 'Qualified'].includes(candidate.pipeline_stage));
    const archived = all.filter((candidate) => ['Archived', 'Rejected', 'Withdrawn'].includes(candidate.pipeline_stage));
    const templates = parseTemplates(job.outreach_templates);
    const metrics = job.metrics || {};
    const counts = candidateStageCounts(all);

    let content = '';
    if (state.selectedJobTab === 'overview') {
      const scheduleWindows = getScheduleWindows(job);
      content = (
        '<section class="view-section">' +
          '<div class="metric-strip metric-strip-job">' +
            `<div class="metric-card strip-card"><div class="metric-number">${metrics.candidates_sourced || all.length || 0}</div><div class="metric-caption">Candidates</div></div>` +
            `<div class="metric-card strip-card"><div class="metric-number">${metrics.invites_sent || 0}</div><div class="metric-caption">LinkedIn Requests</div></div>` +
            `<div class="metric-card strip-card"><div class="metric-number">${percent(metrics.invites_accepted, metrics.invites_sent)}</div><div class="metric-caption">Acceptance Rate</div></div>` +
            `<div class="metric-card strip-card"><div class="metric-number">${metrics.emails_sent || 0}</div><div class="metric-caption">Emails Sent</div></div>` +
            `<div class="metric-card strip-card"><div class="metric-number">${percent(metrics.email_replies, metrics.emails_sent)}</div><div class="metric-caption">Email Reply Rate</div></div>` +
            `<div class="metric-card strip-card"><div class="metric-number">${metrics.approval_queue_count || 0}</div><div class="metric-caption">Pending Approvals</div></div>` +
          '</div>' +
          '<div class="surface">' +
            '<div class="section-head"><div><div class="label-caps">Pipeline Snapshot</div><h2 class="section-title">Stage Breakdown</h2></div></div>' +
            '<div class="job-snapshot-grid">' +
              Object.entries(counts).map(([stage, count]) => `<div class="snapshot-card"><div>${stageChip(stage)}</div><strong>${esc(count)}</strong></div>`).join('') +
            '</div>' +
          '</div>' +
          '<form id="job-schedule-form" class="surface form-grid" data-job-id="' + esc(job.id) + '">' +
            '<div class="form-span-2"><div class="label-caps">Sending Settings</div><h2 class="section-title">Per-Job Outreach Windows</h2><div class="job-detail-sub">These values are live. Raxion will use them on the next cycle for this job.</div></div>' +
            '<label><span>Timezone</span><input class="input" name="timezone" value="' + esc(job.timezone || 'Europe/London') + '" placeholder="America/New_York" /></label>' +
            '<label><span>Active Days</span><input class="input" name="active_days" value="' + esc(job.active_days || 'Mon,Tue,Wed,Thu,Fri') + '" placeholder="Mon,Tue,Wed,Thu,Fri" /></label>' +
            '<label><span>Default Window Start</span><input class="input" name="send_from" value="' + esc(scheduleWindows.default.send_from) + '" placeholder="09:00" /></label>' +
            '<label><span>Default Window End</span><input class="input" name="send_until" value="' + esc(scheduleWindows.default.send_until) + '" placeholder="17:00" /></label>' +
            '<label><span>LinkedIn Requests Start</span><input class="input" name="linkedin_invite_send_from" value="' + esc(scheduleWindows.linkedin_invite.send_from) + '" placeholder="' + esc(scheduleWindows.default.send_from) + '" /></label>' +
            '<label><span>LinkedIn Requests End</span><input class="input" name="linkedin_invite_send_until" value="' + esc(scheduleWindows.linkedin_invite.send_until) + '" placeholder="' + esc(scheduleWindows.default.send_until) + '" /></label>' +
            '<label><span>LinkedIn DMs Start</span><input class="input" name="linkedin_dm_send_from" value="' + esc(scheduleWindows.linkedin_dm.send_from) + '" placeholder="' + esc(scheduleWindows.default.send_from) + '" /></label>' +
            '<label><span>LinkedIn DMs End</span><input class="input" name="linkedin_dm_send_until" value="' + esc(scheduleWindows.linkedin_dm.send_until) + '" placeholder="' + esc(scheduleWindows.default.send_until) + '" /></label>' +
            '<label><span>Email Start</span><input class="input" name="email_send_from" value="' + esc(scheduleWindows.email.send_from) + '" placeholder="' + esc(scheduleWindows.default.send_from) + '" /></label>' +
            '<label><span>Email End</span><input class="input" name="email_send_until" value="' + esc(scheduleWindows.email.send_until) + '" placeholder="' + esc(scheduleWindows.default.send_until) + '" /></label>' +
            '<div class="form-span-2 button-row"><button class="btn btn-primary" type="submit">Save Sending Settings</button></div>' +
          '</form>' +
          '<div class="surface">' +
            '<div class="section-head"><div><div class="label-caps">Current Schedule</div><h2 class="section-title">Live Windows</h2></div></div>' +
            '<div class="job-snapshot-grid">' +
              `<div class="snapshot-card"><div class="candidate-sub">Timezone</div><strong>${esc(job.timezone || 'Europe/London')}</strong></div>` +
              `<div class="snapshot-card"><div class="candidate-sub">Active Days</div><strong>${esc(job.active_days || 'Mon,Tue,Wed,Thu,Fri')}</strong></div>` +
              `<div class="snapshot-card"><div class="candidate-sub">LinkedIn Requests</div><strong>${esc(scheduleWindows.linkedin_invite.send_from)} - ${esc(scheduleWindows.linkedin_invite.send_until)}</strong></div>` +
              `<div class="snapshot-card"><div class="candidate-sub">LinkedIn DMs</div><strong>${esc(scheduleWindows.linkedin_dm.send_from)} - ${esc(scheduleWindows.linkedin_dm.send_until)}</strong></div>` +
              `<div class="snapshot-card"><div class="candidate-sub">Email</div><strong>${esc(scheduleWindows.email.send_from)} - ${esc(scheduleWindows.email.send_until)}</strong></div>` +
            '</div>' +
          '</div>' +
        '</section>'
      );
    } else if (state.selectedJobTab === 'shortlisted') {
      content = renderCandidateTable(shortlisted);
    } else if (state.selectedJobTab === 'ranked') {
      content = renderCandidateTable(ranked);
    } else if (state.selectedJobTab === 'outreach') {
      content = renderCandidateTable(outreach, { outreach: true });
    } else if (state.selectedJobTab === 'replies') {
      content = renderCandidateTable(replies, { replies: true });
    } else if (state.selectedJobTab === 'archived') {
      content = renderCandidateTable(archived, { archived: true });
    } else if (state.selectedJobTab === 'activity') {
      const filtered = state.selectedJobActivityType === 'all'
        ? state.selectedJobActivity
        : state.selectedJobActivity.filter((item) => item.event_type === state.selectedJobActivityType);
      content = (
        '<div class="surface">' +
          '<div class="section-head"><div><div class="label-caps">Activity</div><h2 class="section-title">Job Activity</h2></div><select class="select" data-action="set-job-activity-filter" data-id="' + esc(job.id) + '">' +
          JOB_ACTIVITY_TYPES.map((type) => `<option value="${esc(type)}"${state.selectedJobActivityType === type ? ' selected' : ''}>${esc(type === 'all' ? 'All Types' : type)}</option>`).join('') +
          '</select></div>' +
          '<div class="activity-feed">' + renderActivityRows(filtered) + '</div></div>'
      );
    } else if (state.selectedJobTab === 'templates') {
      content = (
        '<form id="job-templates-form" class="surface form-grid" data-job-id="' + esc(job.id) + '">' +
          '<div class="form-span-2"><div class="label-caps">Templates</div><h2 class="section-title">Message Templates</h2></div>' +
          '<label class="form-span-2"><span>LinkedIn DM</span><textarea class="input textarea" name="linkedin_dm">' + esc(templates.linkedin_dm || '') + '</textarea></label>' +
          '<label class="form-span-2"><span>Email</span><textarea class="input textarea" name="email">' + esc(templates.email || '') + '</textarea></label>' +
          '<label class="form-span-2"><span>Follow-up</span><textarea class="input textarea" name="follow_up">' + esc(templates.follow_up || '') + '</textarea></label>' +
          '<div class="form-span-2 button-row"><button class="btn btn-primary" type="submit">Save Templates</button></div>' +
        '</form>'
      );
    } else {
      content = renderCandidateTable(all);
    }

    return (
      '<section class="view-section" id="job-detail-anchor">' +
        '<div class="job-detail-header surface">' +
          '<div><div class="label-caps">Job Detail</div><h2 class="section-title">' + esc(job.job_title || job.name) + '</h2><div class="job-detail-sub">' + esc(job.client_name || 'Unknown client') + ' · ' + esc(job.location || 'No location') + '</div></div>' +
          '<div class="button-row"><button class="btn btn-primary btn-sm" data-action="source-now" data-id="' + esc(job.id) + '">Source Now</button><button class="btn btn-secondary btn-sm" data-action="close-job" data-id="' + esc(job.id) + '">Close</button></div>' +
        '</div>' +
        '<div class="tab-row">' + JOB_TABS.map(([key, label]) => `<button class="tab-button${state.selectedJobTab === key ? ' active' : ''}" data-action="set-job-tab" data-id="${esc(key)}">${esc(label)}</button>`).join('') + '</div>' +
        content +
      '</section>'
    );
  }

  function renderJobs() {
    return (
      '<section class="view-section">' +
        renderCreateJobForm() +
        '<div class="jobs-grid">' + getActiveJobs().map(renderJobCard).join('') + '</div>' +
        renderJobDetail() +
      '</section>'
    );
  }

  function renderPipeline() {
    const candidates = Object.values(state.jobCandidates).flat();
    return (
      '<section class="view-section">' +
        '<div class="surface"><div class="section-head"><div><div class="label-caps">Pipeline</div><h2 class="section-title">All Candidates</h2></div></div>' + renderCandidateTable(candidates, { showJob: true }) + '</div>' +
      '</section>'
    );
  }

  function renderArchived() {
    const rows = getArchivedJobs().map((job) => (
      '<tr>' +
      `<td><strong>${esc(job.job_title || job.name)}</strong></td>` +
      `<td>${esc(job.client_name || '—')}</td>` +
      `<td>${statusChip(job.status)}</td>` +
      `<td>${esc(formatDateTime(job.closed_at || job.created_at))}</td>` +
      `<td><button class="btn btn-secondary btn-sm" data-action="open-job" data-id="${esc(job.id)}">View</button></td>` +
      '</tr>'
    )).join('') || '<tr><td colspan="5">No archived jobs.</td></tr>';
    return '<section class="view-section"><div class="surface"><div class="section-head"><div><div class="label-caps">Archived</div><h2 class="section-title">Closed and Paused Jobs</h2></div></div><div class="table-shell"><table><thead><tr><th>Job</th><th>Client</th><th>Status</th><th>Closed</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div></section>';
  }

  function renderInbox() {
    const rows = (state.inbox || []).reduce((map, item) => {
      const key = item.candidate_id || item.candidates?.id || item.id;
      if (!map[key] || new Date(item.sent_at) > new Date(map[key].sent_at || 0)) map[key] = item;
      return map;
    }, {});
    return (
      '<section class="view-section"><div class="surface"><div class="section-head"><div><div class="label-caps">Inbox</div><h2 class="section-title">Conversation Threads</h2></div></div><div class="thread-list">' +
      Object.values(rows).map((item) => (
        '<div class="thread-card">' +
          `<button class="text-link candidate-name" data-action="open-candidate" data-id="${esc(item.candidate_id || item.candidates?.id)}">${esc(item.candidates?.name || 'Unknown')}</button>` +
          `<div class="candidate-sub">${esc(item.candidates?.current_company || 'Unknown company')} · ${esc(item.jobs?.job_title || 'Unknown job')}</div>` +
          `<div class="thread-preview">${esc((item.message_text || '').slice(0, 100))}</div>` +
          `<div class="thread-meta">${esc(formatTime(item.sent_at))}</div>` +
        '</div>'
      )).join('') +
      '</div></div></section>'
    );
  }

  function renderActivity() {
    return (
      '<section class="view-section">' +
        '<div class="surface">' +
          '<div class="section-head"><div><div class="label-caps">Activity</div><h2 class="section-title">Global Activity Feed</h2></div><select class="select" data-action="set-activity-group" data-id="global"><option value="all"' + (state.selectedGlobalActivityGroup === 'all' ? ' selected' : '') + '>All Types</option><option value="messages"' + (state.selectedGlobalActivityGroup === 'messages' ? ' selected' : '') + '>Messages</option><option value="enrichment"' + (state.selectedGlobalActivityGroup === 'enrichment' ? ' selected' : '') + '>Enrichment</option><option value="outreach"' + (state.selectedGlobalActivityGroup === 'outreach' ? ' selected' : '') + '>Outreach</option><option value="replies"' + (state.selectedGlobalActivityGroup === 'replies' ? ' selected' : '') + '>Replies</option><option value="errors"' + (state.selectedGlobalActivityGroup === 'errors' ? ' selected' : '') + '>Errors</option></select></div>' +
          '<div class="activity-feed">' + renderActivityRows(filterActivities(state.activity, state.selectedGlobalActivityGroup)) + '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function renderApprovals() {
    const cards = (state.approvals || []).map((item) => {
      const faded = item._faded ? ' approval-faded' : '';
      const actions = ['approved', 'sent'].includes(item.status)
        ? `<div class="approval-approved"><span class="stage-chip stage-qualified">✓ ${esc(item.status === 'sent' ? 'Sent' : 'Approved')}</span></div>`
        : `<div class="button-row"><button class="btn btn-success btn-sm" data-action="approve-approval" data-id="${esc(item.id)}">✓ Approve</button><button class="btn btn-secondary btn-sm" data-action="edit-approval" data-id="${esc(item.id)}">✎ Edit</button><button class="btn btn-danger btn-sm" data-action="skip-approval" data-id="${esc(item.id)}">✗ Skip</button></div>`;
      return (
        `<article class="approval-card${faded}">` +
          `<div class="approval-card-head"><div class="approval-type ${item.channel === 'linkedin_dm' ? 'approval-dm' : item.channel === 'email' ? 'approval-email' : 'approval-followup'}">${esc(item.channel === 'linkedin_dm' ? 'LINKEDIN DM' : item.channel === 'email' ? 'EMAIL' : item.channel.toUpperCase())}</div><div class="approval-meta">${esc(formatTime(item.created_at))} ${stageChip(item.status)}</div></div>` +
          `<div class="approval-person">${esc(item.candidates?.name || 'Unknown')}</div>` +
          `<div class="candidate-sub">${esc(item.candidates?.current_title || 'No title')} · ${esc(item.candidates?.current_company || 'No company')}</div>` +
          `<blockquote class="approval-message">${esc(item.message_text || '')}</blockquote>` +
          actions +
        '</article>'
      );
    }).join('') || '<div class="empty-state">No approval items.</div>';
    return '<section class="view-section"><div class="approvals-stack">' + cards + '</div></section>';
  }

  function renderControls() {
    const runtime = state.runtime || {};
    const health = state.health || {};
    const integrationHealth = health.integration_health || { statuses: [], checked_at: null };
    const toggles = [
      ['outreachEnabled', 'Outreach'],
      ['followupEnabled', 'Follow-up'],
      ['enrichmentEnabled', 'Enrichment'],
      ['researchEnabled', 'Research'],
      ['linkedinEnabled', 'LinkedIn'],
      ['postsEnabled', 'Posts'],
    ];

    const groupedConfig = (state.config || []).reduce((groups, field) => {
      if (!groups[field.category]) groups[field.category] = [];
      groups[field.category].push(field);
      return groups;
    }, {});

    return (
      '<section class="view-section">' +
        '<div class="metric-strip">' +
          `<div class="metric-card strip-card"><div class="metric-number">${esc(runtime.raxionStatus || 'ACTIVE')}</div><div class="metric-caption">System Status</div></div>` +
          `<div class="metric-card strip-card"><div class="metric-number">${health.pending_approvals || 0}</div><div class="metric-caption">Pending Approvals</div></div>` +
          `<div class="metric-card strip-card"><div class="metric-number">${health.webhook_events_logged || 0}</div><div class="metric-caption">Webhook Events</div></div>` +
          `<div class="metric-card strip-card"><div class="metric-number metric-small">${esc(formatTime(health.server_time))}</div><div class="metric-caption">Server Time</div></div>` +
        '</div>' +
        '<div class="jobs-grid">' + toggles.map(([key, label]) => `<div class="surface toggle-surface"><div><div class="label-caps">Module</div><h3 class="section-title small">${esc(label)}</h3></div><button class="toggle-switch ${runtime[key] ? 'is-on' : ''}" data-action="toggle-runtime" data-id="${esc(key)}"><span></span></button></div>`).join('') + '</div>' +
        '<div class="surface"><div class="section-head"><div><div class="label-caps">API Health</div><h2 class="section-title">Integration Status</h2></div><button class="btn btn-secondary btn-sm" data-action="refresh-health">Refresh</button></div><div class="health-grid">' + (integrationHealth.statuses || []).map((item) => `<div class="health-card"><div class="health-head"><span class="health-dot ${esc(item.status)}"></span><strong>${esc(item.name)}</strong></div><div class="candidate-sub">${esc(item.detail || '')}</div></div>`).join('') + '</div></div>' +
        '<div class="surface"><div class="section-head"><div><div class="label-caps">Environment</div><h2 class="section-title">Runtime Config</h2></div></div><div class="view-section">' + Object.entries(groupedConfig).map(([category, fields]) => (
          '<section class="config-group">' +
            `<div><div class="label-caps">${esc(category)}</div><h3 class="section-title small">${esc(category)} Controls</h3></div>` +
            '<div class="config-grid">' +
            fields.map((field) => {
              const inputType = field.inputType || 'text';
              const inputClass = inputType === 'number' || inputType === 'password' || inputType === 'text'
                ? `input config-input${field.secret ? ' mono-text' : ''}`
                : 'input textarea mono-text';
              const inputMarkup = inputType === 'number' || inputType === 'password' || inputType === 'text'
                ? `<input class="${inputClass}" type="${esc(inputType)}" name="value" value="${esc(field.value || '')}" />`
                : `<textarea class="input textarea mono-text" name="value">${esc(field.value || '')}</textarea>`;
              return `<form class="config-card" data-config-form="true"><input type="hidden" name="key" value="${esc(field.key)}" /><div class="config-head"><div><div class="label-caps">${esc(field.category)}</div><h3 class="section-title small">${esc(field.label)}</h3><div class="candidate-sub">${esc(field.key)}${field.restartRequired ? ' · restart required' : ' · live update'}</div>${field.description ? `<div class="candidate-sub">${esc(field.description)}</div>` : ''}</div>${field.overridden ? `<button class="btn btn-secondary btn-sm" data-action="delete-config" data-id="${esc(field.key)}">Delete</button>` : ''}</div>${inputMarkup}<div class="button-row"><button class="btn btn-primary btn-sm" type="submit">Save</button></div></form>`;
            }).join('') +
            '</div>' +
          '</section>'
        )).join('') + '</div></div>' +
      '</section>'
    );
  }

  function renderCandidatePanel() {
    const candidate = state.candidatePanelDetail;
    if (!candidate) return '';
    const stageOptions = Object.keys(STAGE_META).map((stage) => `<option value="${esc(stage)}"${candidate.pipeline_stage === stage ? ' selected' : ''}>${esc(stageInfo(stage).label)}</option>`).join('');
    const hasLatestEvaluation = candidate.latest_fit_score != null
      && (
        Number(candidate.latest_fit_score) !== Number(candidate.fit_score || 0)
        || String(candidate.latest_fit_grade || '') !== String(candidate.fit_grade || '')
        || String(candidate.latest_fit_rationale || '') !== String(candidate.fit_rationale || '')
      );
    return (
      '<div class="drawer-backdrop" data-action="close-candidate"></div>' +
      '<aside class="drawer">' +
        '<div class="drawer-head"><div><div class="label-caps">Candidate</div><h2 class="section-title">' + esc(candidate.name || 'Unknown') + '</h2><div class="candidate-sub">' + esc(candidate.current_title || 'No title') + ' · ' + esc(candidate.current_company || 'No company') + '</div></div><button class="btn btn-secondary btn-sm" data-action="close-candidate">Close</button></div>' +
        '<div class="drawer-body">' +
          '<div class="panel-block"><div class="panel-grid"><div><span class="panel-label">Location</span><strong>' + esc(candidate.location || '—') + '</strong></div><div><span class="panel-label">Score</span>' + scorePill(candidate.fit_score) + '</div><div><span class="panel-label">Stage</span>' + stageChip(candidate.pipeline_stage) + '</div><div><span class="panel-label">Profile</span>' + profileButton(candidate.linkedin_url) + '</div></div></div>' +
          '<div class="panel-block"><div class="panel-label">Fit rationale</div><p>' + esc(candidate.fit_rationale || 'No rationale.') + '</p></div>' +
          (hasLatestEvaluation
            ? '<div class="panel-block"><div class="panel-label">Latest Re-evaluation</div><p><strong>' + esc(`${candidate.latest_fit_score}/100 ${candidate.latest_fit_grade || ''}`.trim()) + '</strong></p><p>' + esc(candidate.latest_fit_rationale || 'No latest rationale.') + '</p></div>'
            : '') +
          '<div class="panel-block"><div class="panel-label">Skills</div><div class="tag-row">' + (String(candidate.tech_skills || '').split(',').map((tag) => tag.trim()).filter(Boolean).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('') || '<span class="muted-inline">No skills captured</span>') + '</div></div>' +
          '<div class="panel-block"><div class="panel-label">Past employers</div><p>' + esc(candidate.past_employers || 'No employer history captured.') + '</p></div>' +
          '<div class="panel-block"><div class="panel-label">Stage change</div><div class="button-row"><select id="candidate-stage-select" class="select">' + stageOptions + '</select><button class="btn btn-primary btn-sm" data-action="save-candidate-stage" data-id="' + esc(candidate.id) + '">Save Stage</button></div></div>' +
          '<div class="panel-block"><div class="panel-label">Conversation history</div>' + (candidate.conversation_history || []).map((message) => `<div class="conversation-card ${message.direction === 'inbound' ? 'inbound' : 'outbound'}"><div class="conversation-meta">${esc(message.channel || 'message')} · ${esc(formatTime(message.sent_at))}</div><div>${esc(message.message_text || '')}</div></div>`).join('') + ((candidate.conversation_history || []).length ? '' : '<div class="muted-inline">No conversation history.</div>') + '</div>' +
          '<div class="button-row"><button class="btn btn-secondary btn-sm" data-action="sync-ats" data-id="' + esc(candidate.id) + '">Sync to ATS</button><button class="btn btn-secondary btn-sm" data-action="archive-candidate" data-id="' + esc(candidate.id) + '">Archive</button></div>' +
        '</div>' +
      '</aside>'
    );
  }

  function render() {
    document.querySelectorAll('.nav-link').forEach((link) => {
      link.classList.toggle('active', link.dataset.view === state.view);
    });

    if (state.loading) {
      app.innerHTML = '<div class="surface">Loading Mission Control...</div>';
      return;
    }

    const views = {
      overview: renderOverview,
      jobs: renderJobs,
      pipeline: renderPipeline,
      archived: renderArchived,
      inbox: renderInbox,
      activity: renderActivity,
      approvals: renderApprovals,
      controls: renderControls,
    };

    app.innerHTML = (views[state.view] || renderOverview)() + renderCandidatePanel();
  }

  function markApprovalLocally(approvalId, status) {
    const collections = [state.approvals, state.selectedJobApprovals, state.candidatePanelDetail?.approvals].filter(Boolean);
    collections.forEach((items) => {
      const target = items.find((item) => item.id === approvalId);
      if (target) {
        target.status = status;
        target._faded = false;
        setTimeout(() => {
          target._faded = true;
          render();
        }, 3000);
      }
    });
  }

  async function handleAction(action, id, extra, sourceEl) {
    if (action === 'open-job') {
      state.view = 'jobs';
      state.selectedJobTab = 'all_candidates';
      state.showCreateJobForm = false;
      window.location.hash = 'jobs';
      await loadSelectedJob(id);
      scrollToId('job-detail-anchor');
      return;
    }

    if (action === 'toggle-create-job') {
      state.showCreateJobForm = id !== 'off';
      state.view = 'jobs';
      window.location.hash = 'jobs';
      render();
      if (state.showCreateJobForm) scrollToId('job-create-form');
      return;
    }

    if (action === 'set-job-tab') {
      state.selectedJobTab = id;
      render();
      return;
    }

    if (action === 'set-activity-group') {
      if (id === 'overview') state.selectedActivityGroup = sourceEl.value;
      if (id === 'global') state.selectedGlobalActivityGroup = sourceEl.value;
      render();
      return;
    }

    if (action === 'set-job-activity-filter') {
      state.selectedJobActivityType = sourceEl.value;
      render();
      return;
    }

    if (action === 'source-now') {
      await request(`/api/jobs/${id}/source-now`, { method: 'POST' });
      showToast('Sourcing triggered.');
      await loadCoreData();
      await loadSelectedJob(id);
      return;
    }

    if (action === 'close-job') {
      await request(`/api/jobs/${id}/close`, { method: 'POST' });
      showToast('Job closed.');
      await loadCoreData();
      state.view = 'archived';
      window.location.hash = 'archived';
      render();
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

    if (action === 'archive-candidate') {
      await request(`/api/candidates/${id}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'Archived' }),
      });
      showToast('Candidate archived.');
      await loadCoreData();
      if (state.selectedJobId) await loadSelectedJob(state.selectedJobId);
      if (state.candidatePanelId === id) closeCandidatePanel();
      return;
    }

    if (action === 'reinstate-candidate') {
      const candidate = Object.values(state.jobCandidates).flat().find((item) => item.id === id);
      const nextStage = Number(candidate?.fit_score || 0) >= 60 ? 'Shortlisted' : 'Sourced';
      await request(`/api/candidates/${id}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: nextStage }),
      });
      showToast('Candidate reinstated.');
      await loadCoreData();
      if (state.selectedJobId) await loadSelectedJob(state.selectedJobId);
      return;
    }

    if (action === 'save-candidate-stage') {
      const stage = document.getElementById('candidate-stage-select')?.value;
      await request(`/api/candidates/${id}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      showToast('Candidate stage updated.');
      await openCandidatePanel(id);
      await loadCoreData();
      if (state.selectedJobId) await loadSelectedJob(state.selectedJobId);
      return;
    }

    if (action === 'sync-ats') {
      await request(`/api/candidates/${id}/sync-ats`, { method: 'POST' });
      showToast('ATS sync triggered.');
      return;
    }

    if (action === 'approve-approval') {
      await request(`/api/approval-queue/${id}/approve`, { method: 'POST' });
      markApprovalLocally(id, 'approved');
      render();
      return;
    }

    if (action === 'skip-approval') {
      await request(`/api/approval-queue/${id}/skip`, { method: 'POST' });
      const target = state.approvals.find((item) => item.id === id);
      if (target) target.status = 'rejected';
      render();
      return;
    }

    if (action === 'edit-approval') {
      const approval = state.approvals.find((item) => item.id === id);
      const next = window.prompt('Edit message', approval?.message_text || '');
      if (next == null) return;
      const updated = await request(`/api/approval-queue/${id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_text: next }),
      });
      const target = state.approvals.find((item) => item.id === id);
      if (target) {
        target.message_text = updated.message_text;
        target.status = updated.status;
      }
      render();
      return;
    }

    if (action === 'toggle-runtime') {
      await request('/api/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: id }),
      });
      await loadCoreData();
      state.view = 'controls';
      render();
      return;
    }

    if (action === 'refresh-health') {
      state.health = await request('/api/health?refresh=true');
      render();
      return;
    }

    if (action === 'delete-config') {
      await request(`/api/config/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadCoreData();
      state.view = 'controls';
      render();
      return;
    }
  }

  document.addEventListener('click', async (event) => {
    const nav = event.target.closest('.nav-link');
    if (nav) {
      event.preventDefault();
      state.view = nav.dataset.view;
      window.location.hash = state.view;
      render();
      return;
    }

    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      if (actionEl.tagName === 'SELECT') {
        return;
      }
      event.preventDefault();
      try {
        await handleAction(
          actionEl.dataset.action,
          actionEl.dataset.id,
          actionEl.dataset.extra,
          actionEl,
        );
      } catch (error) {
        showToast(error.message, 'error');
      }
      return;
    }

    if (event.target.id === 'refresh-dashboard') {
      await loadCoreData();
      return;
    }

    if (event.target.id === 'launch-job') {
      state.view = 'jobs';
      state.showCreateJobForm = true;
      window.location.hash = 'jobs';
      render();
      scrollToId('job-create-form');
      return;
    }

    if (event.target.id === 'toggle-sidebar') {
      document.body.classList.toggle('sidebar-open');
    }
  });

  document.addEventListener('change', async (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    try {
      await handleAction(actionEl.dataset.action, actionEl.dataset.id, actionEl.dataset.extra, event.target);
    } catch (error) {
      showToast(error.message, 'error');
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
      await loadCoreData();
      await loadSelectedJob(result.job_id);
      state.view = 'jobs';
      state.showCreateJobForm = false;
      render();
      scrollToId('job-detail-anchor');
      return;
    }

    if (event.target.id === 'job-templates-form') {
      event.preventDefault();
      const jobId = event.target.dataset.jobId;
      const templates = Object.fromEntries(new FormData(event.target).entries());
      await request(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outreach_templates: templates }),
      });
      showToast('Templates saved.');
      await loadSelectedJob(jobId);
      return;
    }

    if (event.target.id === 'job-schedule-form') {
      event.preventDefault();
      const jobId = event.target.dataset.jobId;
      const payload = Object.fromEntries(new FormData(event.target).entries());
      const job = state.selectedJobDetail || {};
      const templates = parseTemplates(job.outreach_templates);
      templates.schedule_windows = {
        linkedin_invite: {
          send_from: payload.linkedin_invite_send_from || payload.send_from,
          send_until: payload.linkedin_invite_send_until || payload.send_until,
        },
        linkedin_dm: {
          send_from: payload.linkedin_dm_send_from || payload.send_from,
          send_until: payload.linkedin_dm_send_until || payload.send_until,
        },
        email: {
          send_from: payload.email_send_from || payload.send_from,
          send_until: payload.email_send_until || payload.send_until,
        },
      };

      await request(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timezone: payload.timezone,
          active_days: payload.active_days,
          send_from: payload.send_from,
          send_until: payload.send_until,
          outreach_templates: templates,
        }),
      });
      showToast('Sending settings saved.');
      await loadSelectedJob(jobId);
      await loadCoreData();
      state.view = 'jobs';
      render();
      return;
    }

    if (event.target.dataset.configForm === 'true') {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.target).entries());
      await request('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('Config saved.');
      await loadCoreData();
      state.view = 'controls';
      render();
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
      if (payload.job_id === state.selectedJobId) {
        state.selectedJobActivity = [payload, ...(state.selectedJobActivity || [])].slice(0, 200);
      }
      render();
    } catch {
      return;
    }
  };

  loadCoreData().catch((error) => {
    app.innerHTML = '<div class="surface">Failed to load dashboard: ' + esc(error.message) + '</div>';
  });
}());
