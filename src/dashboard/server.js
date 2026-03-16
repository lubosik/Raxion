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
import { getRuntimeState, toggleRuntimeStateValue } from '../services/runtimeState.js';
import { listRuntimeConfig, setRuntimeConfigValue, deleteRuntimeConfigValue } from '../services/configService.js';
import { getIntegrationHealth } from '../services/healthService.js';

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
        <a class="nav-link active" href="#overview" data-view="overview"><span class="nav-icon">◈</span><span>Overview</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#jobs" data-view="jobs"><span class="nav-icon">◻</span><span>Jobs</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#pipeline" data-view="pipeline"><span class="nav-icon">▦</span><span>Pipeline</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#archived" data-view="archived"><span class="nav-icon">▤</span><span>Archived</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#inbox" data-view="inbox"><span class="nav-icon">◎</span><span>Inbox</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#activity" data-view="activity"><span class="nav-icon">◉</span><span>Activity</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#approvals" data-view="approvals"><span class="nav-icon">◷</span><span>Approvals</span><span class="nav-dot"></span></a>
        <a class="nav-link" href="#controls" data-view="controls"><span class="nav-icon">▣</span><span>Controls</span><span class="nav-dot"></span></a>
      </nav>
      <div class="sidebar-footer"><div class="sidebar-status">Live</div></div>
    </aside>
    <main class="main">
      <div class="container">
        <header class="page-header">
          <button class="mobile-menu" id="toggle-sidebar" type="button">Menu</button>
          <div>
            <h1 class="page-title">Raxion</h1>
            <div class="page-subtitle label-caps">Autonomous Recruiting Ops</div>
          </div>
          <div class="button-row">
            <button class="btn btn-secondary" id="refresh-dashboard" type="button">Refresh</button>
            <button class="btn btn-primary" id="launch-job" type="button">Launch Job</button>
          </div>
        </header>
        <div id="app" class="section">Loading...</div>
      </div>
    </main>
  </div>
  <script src="/dashboard/app.js"></script>
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
    const [jobs, sourced, outreach, invites, accepted, replies, qualified, interviews, placements, approvals, emailsSent, emailReplies] = await Promise.all([
      supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'ACTIVE'),
      supabase.from('candidates').select('*', { count: 'exact', head: true }),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).in('pipeline_stage', ['invite_sent', 'invite_accepted', 'dm_sent', 'email_sent', 'Replied', 'Qualified', 'Interview Booked', 'Interview Scheduled', 'Offered', 'Placed']),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).not('invite_sent_at', 'is', null),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).not('invite_accepted_at', 'is', null),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).not('last_reply_at', 'is', null),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('pipeline_stage', 'Qualified'),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).not('interview_booked_at', 'is', null),
      supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('pipeline_stage', 'Placed'),
      supabase.from('approval_queue').select('*', { count: 'exact', head: true }).in('status', ['pending', 'edited']),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('direction', 'outbound').eq('channel', 'email'),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('direction', 'inbound').eq('channel', 'email'),
    ]);

    const acceptanceRate = (invites.count || 0) ? ((accepted.count || 0) / invites.count) * 100 : 0;
    const emailReplyRate = (emailsSent.count || 0) ? ((emailReplies.count || 0) / emailsSent.count) * 100 : 0;
    res.json({
      active_jobs: jobs.count || 0,
      candidates_sourced: sourced.count || 0,
      outreach_sent: outreach.count || 0,
      candidates_in_outreach: outreach.count || 0,
      invites_sent: invites.count || 0,
      invites_accepted: accepted.count || 0,
      acceptance_rate: acceptanceRate,
      emails_sent: emailsSent.count || 0,
      email_replies: emailReplies.count || 0,
      email_reply_rate: emailReplyRate,
      replies: replies.count || 0,
      qualified: qualified.count || 0,
      interviews_booked: interviews.count || 0,
      placements_made: placements.count || 0,
      approval_queue_count: approvals.count || 0,
    });
  });

  app.get('/api/state', async (req, res) => {
    res.json(await getRuntimeState());
  });

  app.post('/api/toggle', async (req, res) => {
    try {
      const state = await toggleRuntimeStateValue(req.body.key);
      res.json(state);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/health', async (req, res) => {
    const [{ count: webhookCount }, { count: queueCount }, state, integrationHealth] = await Promise.all([
      supabase.from('webhook_logs').select('*', { count: 'exact', head: true }),
      supabase.from('approval_queue').select('*', { count: 'exact', head: true }).in('status', ['pending', 'edited']),
      getRuntimeState(),
      getIntegrationHealth(req.query.refresh === 'true'),
    ]);

    res.json({
      status: 'ok',
      runtime_state: state,
      pending_approvals: queueCount || 0,
      webhook_events_logged: webhookCount || 0,
      server_time: new Date().toISOString(),
      integration_health: integrationHealth,
    });
  });

  app.get('/api/config', async (req, res) => {
    res.json(await listRuntimeConfig());
  });

  app.post('/api/config', async (req, res) => {
    try {
      const updated = await setRuntimeConfigValue(req.body.key, req.body.value || '');
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/api/config/:key', async (req, res) => {
    try {
      const updated = await deleteRuntimeConfigValue(req.params.key);
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
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
    const { data: assets } = await supabase.from('job_assets').select('*').eq('job_id', req.params.id).order('created_at', { ascending: false });
    res.json({ ...job, metrics: await fetchJobMetrics(job.id), recent_activity: activity || [], assets: assets || [] });
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
  app.post('/api/jobs/:id/source-now', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    sourceCandidatesForJob(job).catch((error) => {
      console.error('[dashboard] source-now failed', { jobId: job.id, error: error.message });
    });
    res.json({ started: true, job_id: job.id });
  });
  app.post('/api/jobs/:id/ingest-applicants', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    res.json(await ingestJobApplicants(job));
  });
  app.get('/api/jobs/:id/assets', async (req, res) => {
    const { data, error } = await supabase.from('job_assets').select('*').eq('job_id', req.params.id).order('created_at', { ascending: false });
    if (error) return res.status(200).json([]);
    res.json(data || []);
  });
  app.post('/api/jobs/:id/assets', async (req, res) => {
    const payload = {
      job_id: req.params.id,
      name: req.body.name,
      asset_type: req.body.asset_type,
      url: req.body.url,
      description: req.body.description || null,
    };
    const { data, error } = await supabase.from('job_assets').insert(payload).select('*').single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  });
  app.delete('/api/jobs/:id/assets/:assetId', async (req, res) => {
    const { error } = await supabase.from('job_assets').delete().eq('id', req.params.assetId).eq('job_id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
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
    let query = supabase.from('activity_log').select('*').eq('job_id', req.params.id).order('created_at', { ascending: false }).limit(200);
    if (req.query.eventType) query = query.eq('event_type', req.query.eventType);
    const { data } = await query;
    res.json(data || []);
  });

  app.get('/api/jobs/:id/approval-queue', async (req, res) => {
    const { data } = await supabase
      .from('approval_queue')
      .select('*, candidates(name, current_title, current_company, fit_score, fit_grade), jobs(job_title, client_name)')
      .eq('job_id', req.params.id)
      .in('status', ['pending', 'edited', 'approved'])
      .order('created_at', { ascending: false });
    res.json(data || []);
  });

  app.get('/api/candidates/:id', async (req, res) => {
    const [{ data: candidate }, { data: conversations }, { data: activity }, { data: approvals }] = await Promise.all([
      supabase.from('candidates').select('*').eq('id', req.params.id).single(),
      supabase.from('conversations').select('*').eq('candidate_id', req.params.id).order('sent_at', { ascending: true }),
      supabase.from('activity_log').select('*').eq('candidate_id', req.params.id).order('created_at', { ascending: false }),
      supabase.from('approval_queue').select('*').eq('candidate_id', req.params.id).in('status', ['pending', 'edited', 'approved']).order('created_at', { ascending: false }),
    ]);
    res.json({ ...candidate, conversation_history: conversations || [], activity_log: activity || [], approvals: approvals || [] });
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
    const { data } = await supabase
      .from('conversations')
      .select('*, candidates(id, name, current_company, job_id), jobs(job_title, client_name)')
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: false })
      .limit(200);
    res.json(data || []);
  });

  app.get('/api/activity', async (req, res) => {
    const { data } = await supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(100);
    res.json(data || []);
  });

  app.get('/api/approval-queue', async (req, res) => {
    const { data } = await supabase
      .from('approval_queue')
      .select('*, candidates(name, current_title, current_company, fit_score, fit_grade), jobs(job_title, client_name)')
      .in('status', ['pending', 'edited', 'approved'])
      .order('created_at', { ascending: false });
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
