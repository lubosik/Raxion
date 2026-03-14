import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import supabase from '../db/supabase.js';
import { activityStream, fetchJobMetrics, logActivity } from '../services/activityLogger.js';
import { sourceCandidatesForJob } from '../services/candidateSourcing.js';
import { postJobToLinkedIn, ingestJobApplicants, closeLinkedInJob } from '../services/jobPostingService.js';
import { approveQueuedMessage, editQueuedMessage, skipQueuedMessage } from '../services/approvalService.js';
import { deleteCandidateData } from '../services/gdprService.js';
import { syncCandidateToATS } from '../integrations/zohoRecruit.js';
import { generateInterviewBrief } from '../services/qualificationEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function htmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Raxion</title>
  <link rel="stylesheet" href="/dashboard/styles.css" />
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-title">Raxion</div><div class="brand-sub">Mission Control</div></div>
      <nav class="nav">
        <a class="nav-link active" href="#overview"><span class="nav-icon">◈</span><span>Overview</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#jobs"><span class="nav-icon">◻</span><span>Jobs</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#inbox"><span class="nav-icon">◎</span><span>Inbox</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#activity"><span class="nav-icon">◉</span><span>Activity</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#approvals"><span class="nav-icon">◷</span><span>Approvals</span><span class="nav-dot"></span></a>
      </nav>
      <div class="sidebar-footer"><div class="sidebar-status">Live</div></div>
    </aside>
    <main class="main">
      <div class="container">
        <header class="page-header">
          <div>
            <h1 class="page-title">Raxion</h1>
            <div class="page-subtitle label-caps">Autonomous Recruiting Ops</div>
          </div>
          <div class="button-row">
            <a class="btn btn-secondary" href="/api/stats">API Stats</a>
            <a class="btn btn-primary" href="#jobs">Open Jobs</a>
          </div>
        </header>
        <div id="app" class="section">Loading...</div>
      </div>
    </main>
  </div>
  <script>
    function esc(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function badge(value) {
      const status = String(value || 'neutral').replaceAll(' ', '_').toLowerCase();
      return '<span class="badge ' + status + '">' + esc(value || 'Unknown') + '</span>';
    }

    function time(value) {
      if (!value) return '—';
      return new Date(value).toLocaleString();
    }

    async function load() {
      const [stats, jobs, inbox, activity, approvals] = await Promise.all([
        fetch('/api/stats').then(r => r.json()),
        fetch('/api/jobs').then(r => r.json()),
        fetch('/api/inbox').then(r => r.json()),
        fetch('/api/activity').then(r => r.json()),
        fetch('/api/approval-queue').then(r => r.json())
      ]);
      const jobRows = jobs.length ? jobs.map(job => '<tr>' +
        '<td><strong>' + esc(job.job_title || job.name) + '</strong><div class="stat-note">' + esc(job.client_name || '') + '</div></td>' +
        '<td>' + badge(job.status) + '</td>' +
        '<td>' + (job.metrics?.candidates_sourced || 0) + '</td>' +
        '<td>' + (job.metrics?.candidates_in_outreach || 0) + '</td>' +
        '<td>' + (job.metrics?.replies || 0) + '</td>' +
        '<td>' + (job.metrics?.interviews_booked || 0) + '</td>' +
        '<td><div class="button-row"><a class="btn btn-secondary" href="/api/jobs/' + esc(job.id) + '">View</a></div></td>' +
      '</tr>').join('') : '<tr><td colspan="7">No jobs yet.</td></tr>';

      const inboxRows = inbox.length ? inbox.map(item => '<tr>' +
        '<td>' + esc(item.candidates?.name || 'Unknown') + '</td>' +
        '<td>' + esc(item.jobs?.job_title || 'Unknown') + '</td>' +
        '<td>' + esc((item.message_text || '').slice(0, 120)) + '</td>' +
        '<td>' + time(item.sent_at) + '</td>' +
        '<td>' + badge(item.channel) + '</td>' +
      '</tr>').join('') : '<tr><td colspan="5">No inbound messages.</td></tr>';

      const approvalRows = approvals.length ? approvals.map(item => '<tr>' +
        '<td>' + esc(item.channel) + '</td>' +
        '<td>' + esc(item.stage || '') + '</td>' +
        '<td>' + esc((item.message_text || '').slice(0, 160)) + '</td>' +
        '<td>' + time(item.created_at) + '</td>' +
        '<td><div class="button-row"><button class="btn btn-primary" onclick="approve(\\'' + esc(item.id) + '\\')">Approve</button><button class="btn btn-secondary" onclick="skip(\\'' + esc(item.id) + '\\')">Skip</button></div></td>' +
      '</tr>').join('') : '<tr><td colspan="5">No pending approvals.</td></tr>';

      const activityFeed = activity.length ? activity.map(item => '<div class="timeline-item">' +
        '<div class="timeline-meta">' + time(item.created_at) + '</div>' +
        '<div><strong>' + esc(item.event_type) + '</strong> · ' + esc(item.summary || '') + '</div>' +
      '</div>').join('') : '<div class="notice">No activity logged yet.</div>';

      document.getElementById('app').innerHTML = \`
        <section id="overview" class="section">
          <div class="grid grid-3">
            <div class="card kpi"><div class="label-caps">Active Jobs</div><div class="stat-value">\${stats.active_jobs}</div></div>
            <div class="card kpi"><div class="label-caps">Candidates in Outreach</div><div class="stat-value">\${stats.candidates_in_outreach}</div></div>
            <div class="card kpi"><div class="label-caps">Invites Sent</div><div class="stat-value">\${stats.invites_sent}</div></div>
            <div class="card kpi"><div class="label-caps">Replies</div><div class="stat-value">\${stats.replies}</div></div>
            <div class="card kpi"><div class="label-caps">Qualified</div><div class="stat-value">\${stats.qualified}</div></div>
            <div class="card kpi"><div class="label-caps">Interviews Booked</div><div class="stat-value">\${stats.interviews_booked}</div></div>
          </div>
        </section>
        <section id="jobs" class="section">
          <div class="table-card"><table><thead><tr><th>Job</th><th>Status</th><th>Sourced</th><th>Outreach</th><th>Replies</th><th>Interviews</th><th>Actions</th></tr></thead><tbody>\${jobRows}</tbody></table></div>
        </section>
        <section id="inbox" class="section">
          <div class="table-card"><table><thead><tr><th>Candidate</th><th>Job</th><th>Message</th><th>Time</th><th>Channel</th></tr></thead><tbody>\${inboxRows}</tbody></table></div>
        </section>
        <section id="activity" class="section">
          <div class="card"><div class="label-caps">Live Activity Feed</div><div id="activity-feed" class="timeline" style="margin-top:20px">\${activityFeed}</div></div>
        </section>
        <section id="approvals" class="section">
          <div class="table-card"><table><thead><tr><th>Channel</th><th>Stage</th><th>Message</th><th>Created</th><th>Actions</th></tr></thead><tbody>\${approvalRows}</tbody></table></div>
        </section>
      \`;
      const stream = new EventSource('/api/activity/stream');
      stream.onmessage = (event) => {
        const el = document.getElementById('activity-feed');
        if (!el) return;
        const item = JSON.parse(event.data);
        const div = document.createElement('div');
        div.className = 'timeline-item';
        div.innerHTML = '<div class="timeline-meta">' + time(item.created_at) + '</div><div><strong>' + esc(item.event_type) + '</strong> · ' + esc(item.summary || '') + '</div>';
        el.prepend(div);
      };
    }

    async function approve(id) {
      await fetch('/api/approval-queue/' + id + '/approve', { method: 'POST' });
      window.location.reload();
    }

    async function skip(id) {
      await fetch('/api/approval-queue/' + id + '/skip', { method: 'POST' });
      window.location.reload();
    }

    load();
  </script>
</body>
</html>`;
}

async function getJobWithMetrics(job) {
  return { ...job, metrics: await fetchJobMetrics(job.id) };
}

export function createDashboardServer() {
  const app = express();
  app.use('/dashboard', express.static(__dirname));

  app.get('/', async (req, res) => {
    res.status(200).send(htmlPage());
  });

  app.get('/api/stats', async (req, res) => {
    const [jobs, sourced, outreach, invites, accepted, replies, qualified, interviews, placements, approvals] = await Promise.all([
      supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'ACTIVE'),
      supabase.from('candidates').select('*', { count: 'exact', head: true }),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).in('pipeline_stage', ['invite_sent', 'invite_accepted', 'dm_sent', 'email_sent', 'Replied', 'Qualified']),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).not('invite_sent_at', 'is', null),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).not('invite_accepted_at', 'is', null),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).not('last_reply_at', 'is', null),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('pipeline_stage', 'Qualified'),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).not('interview_booked_at', 'is', null),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('pipeline_stage', 'Placed'),
      supabase.from('approval_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    ]);

    const acceptanceRate = (invites.count || 0) ? ((accepted.count || 0) / invites.count) * 100 : 0;
    res.json({
      active_jobs: jobs.count || 0,
      candidates_sourced: sourced.count || 0,
      candidates_in_outreach: outreach.count || 0,
      invites_sent: invites.count || 0,
      acceptance_rate: acceptanceRate,
      replies: replies.count || 0,
      qualified: qualified.count || 0,
      interviews_booked: interviews.count || 0,
      placements_made: placements.count || 0,
      approval_queue_count: approvals.count || 0,
    });
  });

  app.post('/api/jobs/create', async (req, res) => {
    const payload = {
      ...req.body,
      name: req.body.name || req.body.job_title,
      status: 'ACTIVE',
    };
    const { data: job, error } = await supabase.from('jobs').insert(payload).select('*').single();
    if (error) return res.status(400).json({ error: error.message });
    sourceCandidatesForJob(job).catch(() => null);
    res.json({ job_id: job.id });
  });

  app.get('/api/jobs', async (req, res) => {
    const { data: jobs } = await supabase.from('jobs').select('*').order('created_at', { ascending: false });
    const hydrated = await Promise.all((jobs || []).map(getJobWithMetrics));
    res.json(hydrated);
  });

  app.get('/api/jobs/:id', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    const { data: activity } = await supabase.from('activity_log').select('*').eq('job_id', req.params.id).order('created_at', { ascending: false }).limit(20);
    res.json({ ...job, metrics: await fetchJobMetrics(job.id), recent_activity: activity || [] });
  });

  app.patch('/api/jobs/:id', async (req, res) => {
    const { data, error } = await supabase.from('jobs').update(req.body).eq('id', req.params.id).select('*').single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  });

  app.post('/api/jobs/:id/pause', async (req, res) => res.json((await supabase.from('jobs').update({ paused: true, status: 'PAUSED' }).eq('id', req.params.id).select('*').single()).data));
  app.post('/api/jobs/:id/resume', async (req, res) => res.json((await supabase.from('jobs').update({ paused: false, status: 'ACTIVE' }).eq('id', req.params.id).select('*').single()).data));
  app.post('/api/jobs/:id/close', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    await closeLinkedInJob(job).catch(() => null);
    const { data } = await supabase.from('jobs').update({ status: 'CLOSED', paused: true, closed_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
    res.json(data);
  });
  app.post('/api/jobs/:id/post-to-linkedin', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    res.json(await postJobToLinkedIn(job));
  });
  app.post('/api/jobs/:id/ingest-applicants', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    res.json(await ingestJobApplicants(job));
  });
  app.delete('/api/jobs/:id', async (req, res) => {
    if (req.body.confirm !== true) return res.status(400).json({ error: 'confirmation required' });
    const { data: candidates } = await supabase.from('candidates').select('id').eq('job_id', req.params.id);
    for (const candidate of candidates || []) {
      // eslint-disable-next-line no-await-in-loop
      await deleteCandidateData(candidate.id, 'Job deleted', 'recruiter');
    }
    await supabase.from('jobs').delete().eq('id', req.params.id);
    await logActivity(req.params.id, null, 'GDPR_DELETE', 'Deleted job and related candidates', {});
    res.json({ success: true });
  });

  app.get('/api/jobs/:id/candidates', async (req, res) => {
    let query = supabase.from('candidates').select('*').eq('job_id', req.params.id).order('fit_score', { ascending: false });
    if (req.query.stage) query = query.eq('pipeline_stage', req.query.stage);
    if (req.query.grade) query = query.eq('fit_grade', req.query.grade);
    const { data } = await query.range(Number(req.query.offset || 0), Number(req.query.offset || 0) + Number(req.query.limit || 49));
    res.json(data || []);
  });

  app.get('/api/jobs/:id/activity', async (req, res) => {
    const { data } = await supabase.from('activity_log').select('*').eq('job_id', req.params.id).order('created_at', { ascending: false }).limit(100);
    res.json(data || []);
  });

  app.get('/api/jobs/:id/approval-queue', async (req, res) => {
    const { data } = await supabase.from('approval_queue').select('*').eq('job_id', req.params.id).eq('status', 'pending').order('created_at', { ascending: false });
    res.json(data || []);
  });

  app.get('/api/candidates/:id', async (req, res) => {
    const [{ data: candidate }, { data: conversations }, { data: activity }] = await Promise.all([
      supabase.from('candidates').select('*').eq('id', req.params.id).single(),
      supabase.from('conversations').select('*').eq('candidate_id', req.params.id).order('sent_at', { ascending: true }),
      supabase.from('activity_log').select('*').eq('candidate_id', req.params.id).order('created_at', { ascending: false }),
    ]);
    res.json({ ...candidate, conversation_history: conversations || [], activity_log: activity || [] });
  });

  app.post('/api/candidates/:id/stage', async (req, res) => {
    const { data } = await supabase.from('candidates').update({ pipeline_stage: req.body.stage }).eq('id', req.params.id).select('*').single();
    res.json(data);
  });

  app.post('/api/candidates/:id/placed', async (req, res) => {
    const { data: candidate } = await supabase.from('candidates').update({ pipeline_stage: 'Placed' }).eq('id', req.params.id).select('*').single();
    const { data: job } = await supabase.from('jobs').select('*').eq('id', candidate.job_id).single();
    await supabase.from('jobs').update({ committed_placements: (job.committed_placements || 0) + 1 }).eq('id', job.id);
    await logActivity(job.id, candidate.id, 'CANDIDATE_PLACED', `${candidate.name} placed at ${job.client_name}`, {});
    res.json(candidate);
  });

  app.post('/api/candidates/:id/sync-ats', async (req, res) => {
    const { data: candidate } = await supabase.from('candidates').select('*').eq('id', req.params.id).single();
    res.json(await syncCandidateToATS(candidate));
  });

  app.delete('/api/candidates/:id', async (req, res) => {
    res.json(await deleteCandidateData(req.params.id, req.body.reason, 'recruiter'));
  });

  app.post('/api/candidates/:id/approve/:approvalId', async (req, res) => {
    res.json(await approveQueuedMessage(req.params.approvalId));
  });

  app.post('/api/candidates/:id/interview-brief', async (req, res) => {
    const [{ data: candidate }, { data: job }, { data: conversations }] = await Promise.all([
      supabase.from('candidates').select('*').eq('id', req.params.id).single(),
      supabase.from('jobs').select('*').eq('id', req.body.job_id).single(),
      supabase.from('conversations').select('*').eq('candidate_id', req.params.id).order('sent_at', { ascending: true }),
    ]);
    res.json(await generateInterviewBrief(candidate, job, conversations || []));
  });

  app.get('/api/inbox', async (req, res) => {
    const { data } = await supabase.from('conversations').select('*, candidates(name, job_id), jobs(job_title, client_name)').eq('direction', 'inbound').order('sent_at', { ascending: false }).limit(100);
    res.json(data || []);
  });

  app.get('/api/activity', async (req, res) => {
    const { data } = await supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(100);
    res.json(data || []);
  });

  app.get('/api/approval-queue', async (req, res) => {
    const { data } = await supabase.from('approval_queue').select('*').eq('status', 'pending').order('created_at', { ascending: false });
    res.json(data || []);
  });

  app.post('/api/approval-queue/:id/approve', async (req, res) => res.json(await approveQueuedMessage(req.params.id)));
  app.post('/api/approval-queue/:id/edit', async (req, res) => res.json(await editQueuedMessage(req.params.id, req.body.message_text)));
  app.post('/api/approval-queue/:id/skip', async (req, res) => res.json(await skipQueuedMessage(req.params.id)));

  app.get('/api/activity/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const listener = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    activityStream.on('activity', listener);
    req.on('close', () => {
      activityStream.off('activity', listener);
    });
  });

  return app;
}
