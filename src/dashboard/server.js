import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import supabase from '../db/supabase.js';
import { listLinkedInJobPostings } from '../integrations/unipile.js';
import { activityStream, fetchJobMetrics, logActivity } from '../services/activityLogger.js';
import { sourceCandidatesForJob } from '../services/candidateSourcing.js';
import { postJobToLinkedIn, ingestJobApplicants, closeLinkedInJob } from '../services/jobPostingService.js';
import {
  approveQueuedMessage,
  editQueuedMessage,
  skipQueuedMessage,
  rejectPendingApprovalsForCandidate,
} from '../services/approvalService.js';
import { deleteCandidateData } from '../services/gdprService.js';
import { syncCandidateToATS } from '../integrations/zohoRecruit.js';
import { generateInterviewBrief } from '../services/qualificationEngine.js';
import { getRuntimeState, toggleRuntimeStateValue } from '../services/runtimeState.js';
import { listRuntimeConfig, setRuntimeConfigValue, deleteRuntimeConfigValue } from '../services/configService.js';
import { getIntegrationHealth } from '../services/healthService.js';
import { getSetting, setSetting } from '../services/settings.js';
import { markConversationEnded } from '../services/conversationState.js';
import { getExecutionQueueSnapshot } from '../services/jobExecutionQueue.js';
import {
  normalizeApprovalRecord,
  normalizeCandidateRecord,
  normalizeConversationRecord,
  normalizeJobRecord,
  prepareJobPayload,
} from '../services/dbCompat.js';
import {
  addJobTeamMember,
  createLinkedInJobPostingForJob,
  draftApplicantReply,
  fetchAndProcessApplicants,
  handleInboundJobLaunch,
  listApplicantsForJob,
  listJobTeamMembers,
  removeJobTeamMember,
  replaceJobTeamMembers,
  scheduleInterviewInZoho,
} from '../services/inboundApplicantService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MISSION_CONTROL_USERNAME = 'lubosi@libdr.com';
const DEFAULT_MISSION_CONTROL_PASSWORD = 'G00dluck!';

let cachedMissionControlAuth;
let cachedMissionControlAuthAt = 0;

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
        <a class="nav-link" href="#train-agent" data-view="train-agent"><span class="nav-icon">✦</span><span>Train Agent</span><span class="nav-dot"></span></a>
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
  const normalized = normalizeJobRecord(job);
  return { ...normalized, metrics: await fetchJobMetrics(normalized.id) };
}

function secureCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function getMissionControlAuth() {
  if (cachedMissionControlAuth && Date.now() - cachedMissionControlAuthAt < 60_000) {
    return cachedMissionControlAuth;
  }

  const [username, password] = await Promise.all([
    getSetting('mission_control_username', process.env.MISSION_CONTROL_USERNAME || DEFAULT_MISSION_CONTROL_USERNAME),
    getSetting('mission_control_password', process.env.MISSION_CONTROL_PASSWORD || DEFAULT_MISSION_CONTROL_PASSWORD),
  ]);

  cachedMissionControlAuth = {
    username: username || DEFAULT_MISSION_CONTROL_USERNAME,
    password: password || DEFAULT_MISSION_CONTROL_PASSWORD,
  };
  cachedMissionControlAuthAt = Date.now();
  return cachedMissionControlAuth;
}

async function requireMissionControlAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="Raxion Mission Control"');
    return res.status(401).send('Authentication required');
  }

  let decoded = '';
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    res.set('WWW-Authenticate', 'Basic realm="Raxion Mission Control"');
    return res.status(401).send('Invalid authentication header');
  }

  const separatorIndex = decoded.indexOf(':');
  const providedUsername = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
  const providedPassword = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';
  const expected = await getMissionControlAuth();

  if (!secureCompare(providedUsername, expected.username) || !secureCompare(providedPassword, expected.password)) {
    res.set('WWW-Authenticate', 'Basic realm="Raxion Mission Control"');
    return res.status(401).send('Invalid credentials');
  }

  return next();
}

export function createDashboardServer() {
  const app = express();
  app.use(express.json());
  app.use(requireMissionControlAuth);
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
    const [{ count: webhookCount }, { count: queueCount }, state, integrationHealth, executionQueue] = await Promise.all([
      supabase.from('webhook_logs').select('*', { count: 'exact', head: true }),
      supabase.from('approval_queue').select('*', { count: 'exact', head: true }).in('status', ['pending', 'edited']),
      getRuntimeState(),
      getIntegrationHealth(req.query.refresh === 'true'),
      getExecutionQueueSnapshot(),
    ]);

    res.json({
      status: 'ok',
      runtime_state: state,
      pending_approvals: queueCount || 0,
      webhook_events_logged: webhookCount || 0,
      server_time: new Date().toISOString(),
      integration_health: integrationHealth,
      execution_queue: executionQueue,
    });
  });

  app.get('/api/config', async (req, res) => {
    res.json(await listRuntimeConfig());
  });

  app.get('/api/linkedin/job-postings', async (req, res) => {
    try {
      const postings = await listLinkedInJobPostings();
      res.json((postings || []).map((posting) => ({
        id: posting.job_id || posting.id || null,
        title: posting.title || posting.job_title?.text || posting.job_title || posting.name || 'Untitled posting',
        company: posting.company?.name || posting.company_name || null,
        location: posting.location?.name || posting.location || null,
        status: posting.status || posting.state || null,
        raw: posting,
      })).filter((posting) => posting.id));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/onboarding', async (req, res) => {
    const config = await listRuntimeConfig();
    const keys = [
      'RAXION_AGENT_BRAND_NAME',
      'SENDER_NAME',
      'REPLY_TO_EMAIL',
      'RAXION_AGENT_COMPANY_CONTEXT',
      'RAXION_AGENT_VOICE_GUIDANCE',
      'RAXION_AGENT_REPLY_GUIDANCE',
      'RAXION_SOURCING_SEARCH_GUIDANCE',
      'RAXION_SCORING_GUIDANCE',
    ];
    const fields = Object.fromEntries(
      config
        .filter((field) => keys.includes(field.key))
        .map((field) => [field.key, field.value || '']),
    );
    const [completed, completedAt] = await Promise.all([
      getSetting('agent_training_completed', 'false'),
      getSetting('agent_training_completed_at', ''),
    ]);
    res.json({
      completed: completed === 'true',
      completed_at: completedAt || null,
      fields,
    });
  });

  app.post('/api/onboarding', async (req, res) => {
    const payload = req.body || {};
    const allowedKeys = [
      'RAXION_AGENT_BRAND_NAME',
      'SENDER_NAME',
      'REPLY_TO_EMAIL',
      'RAXION_AGENT_COMPANY_CONTEXT',
      'RAXION_AGENT_VOICE_GUIDANCE',
      'RAXION_AGENT_REPLY_GUIDANCE',
      'RAXION_SOURCING_SEARCH_GUIDANCE',
      'RAXION_SCORING_GUIDANCE',
    ];

    for (const key of allowedKeys) {
      // eslint-disable-next-line no-await-in-loop
      await setRuntimeConfigValue(key, payload[key] || '');
    }

    const completedAt = new Date().toISOString();
    await Promise.all([
      setSetting('agent_training_completed', 'true'),
      setSetting('agent_training_completed_at', completedAt),
    ]);

    await logActivity(null, null, 'AGENT_TRAINING_UPDATED', 'Agent training guidance updated from Mission Control', {
      keys: allowedKeys.filter((key) => String(payload[key] || '').trim()),
      completed_at: completedAt,
    });

    res.json({
      success: true,
      completed: true,
      completed_at: completedAt,
    });
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
    const { data: job, error } = await supabase.from('jobs').insert(await prepareJobPayload(payload)).select('*').single();
    if (error) return res.status(400).json({ error: error.message });
    const normalized = normalizeJobRecord(job);
    if (Array.isArray(req.body.team_members)) {
      await replaceJobTeamMembers(normalized.id, req.body.team_members);
    }
    handleInboundJobLaunch({ ...normalized, ...req.body }).catch((launchError) => {
      console.error('[dashboard] inbound launch failed', { jobId: normalized.id, error: launchError.message });
    });
    if (['outbound', 'both'].includes(req.body.job_mode || 'outbound')) {
      sourceCandidatesForJob(normalized).catch(() => null);
    }
    res.json({ job_id: normalized.id });
  });

  app.get('/api/jobs', async (req, res) => {
    const { data: jobs } = await supabase.from('jobs').select('*').order('created_at', { ascending: false });
    const hydrated = await Promise.all((jobs || []).map(getJobWithMetrics));
    res.json(hydrated);
  });

  app.get('/api/jobs/:id', async (req, res) => {
    const [{ data: job }, { data: activity }, { data: assets }, teamMembers] = await Promise.all([
      supabase.from('jobs').select('*').eq('id', req.params.id).single(),
      supabase.from('activity_log').select('*').eq('job_id', req.params.id).order('created_at', { ascending: false }).limit(20),
      supabase.from('job_assets').select('*').eq('job_id', req.params.id).order('created_at', { ascending: false }),
      listJobTeamMembers(req.params.id),
    ]);
    const normalized = normalizeJobRecord(job);
    res.json({ ...normalized, metrics: await fetchJobMetrics(normalized.id), recent_activity: activity || [], assets: assets || [], team_members: teamMembers || [] });
  });

  app.patch('/api/jobs/:id', async (req, res) => {
    const { data, error } = await supabase.from('jobs').update(await prepareJobPayload(req.body)).eq('id', req.params.id).select('*').single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(normalizeJobRecord(data));
  });

  app.post('/api/jobs/:id/pause', async (req, res) => res.json(normalizeJobRecord((await supabase.from('jobs').update(await prepareJobPayload({ paused: true, paused_until: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), status: 'PAUSED' })).eq('id', req.params.id).select('*').single()).data)));
  app.post('/api/jobs/:id/resume', async (req, res) => res.json(normalizeJobRecord((await supabase.from('jobs').update(await prepareJobPayload({ paused: false, paused_until: null, status: 'ACTIVE' })).eq('id', req.params.id).select('*').single()).data)));
  app.post('/api/jobs/:id/close', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    await closeLinkedInJob(normalizeJobRecord(job)).catch(() => null);
    const { data } = await supabase.from('jobs').update(await prepareJobPayload({ status: 'CLOSED', paused: true, paused_until: null, closed_at: new Date().toISOString() })).eq('id', req.params.id).select('*').single();
    res.json(normalizeJobRecord(data));
  });
  app.post('/api/jobs/:id/post-to-linkedin', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    res.json(await postJobToLinkedIn(normalizeJobRecord(job)));
  });
  app.post('/api/jobs/:id/create-linkedin-posting', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(await createLinkedInJobPostingForJob(normalizeJobRecord(job)));
  });
  app.post('/api/jobs/:id/source-now', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const normalized = normalizeJobRecord(job);
    sourceCandidatesForJob(normalized).catch((error) => {
      console.error('[dashboard] source-now failed', { jobId: job.id, error: error.message });
    });
    res.json({ started: true, job_id: normalized.id });
  });
  app.post('/api/jobs/:id/ingest-applicants', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    res.json(await ingestJobApplicants(job));
  });
  app.post('/api/jobs/:id/fetch-applicants', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(await fetchAndProcessApplicants(normalizeJobRecord(job)));
  });
  app.post('/api/jobs/:id/close-linkedin-posting', async (req, res) => {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(await closeLinkedInJob(normalizeJobRecord(job)));
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
    res.json((data || []).map(normalizeCandidateRecord));
  });
  app.get('/api/jobs/:id/applicants', async (req, res) => {
    res.json((await listApplicantsForJob(req.params.id)).map(normalizeCandidateRecord));
  });
  app.get('/api/jobs/:id/team', async (req, res) => {
    res.json(await listJobTeamMembers(req.params.id));
  });
  app.post('/api/jobs/:id/team', async (req, res) => {
    res.json(await addJobTeamMember(req.params.id, req.body || {}));
  });
  app.delete('/api/jobs/:id/team/:memberId', async (req, res) => {
    await removeJobTeamMember(req.params.id, req.params.memberId);
    res.json({ success: true });
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
      .select('*, candidates(name, current_title, current_company, fit_score, fit_grade), jobs(*)')
      .eq('job_id', req.params.id)
      .in('status', ['pending', 'edited', 'approved'])
      .order('created_at', { ascending: false });
    res.json((data || []).map((row) => ({ ...normalizeApprovalRecord(row), jobs: normalizeJobRecord(row.jobs) })));
  });

  app.get('/api/candidates/:id', async (req, res) => {
    const [{ data: candidate }, { data: conversations }, { data: activity }, { data: approvals }] = await Promise.all([
      supabase.from('candidates').select('*').eq('id', req.params.id).single(),
      supabase.from('conversations').select('*').eq('candidate_id', req.params.id).order('sent_at', { ascending: true }),
      supabase.from('activity_log').select('*').eq('candidate_id', req.params.id).order('created_at', { ascending: false }),
      supabase.from('approval_queue').select('*').eq('candidate_id', req.params.id).in('status', ['pending', 'edited', 'approved']).order('created_at', { ascending: false }),
    ]);
    res.json({ ...normalizeCandidateRecord(candidate), conversation_history: (conversations || []).map(normalizeConversationRecord), activity_log: activity || [], approvals: (approvals || []).map(normalizeApprovalRecord) });
  });

  app.post('/api/candidates/:id/stage', async (req, res) => {
    const { data: existing } = await supabase.from('candidates').select('*').eq('id', req.params.id).single();
    const updates = req.body.stage === 'Archived'
      ? markConversationEnded(existing, req.body.reason || 'Archived manually', { archive: true })
      : { pipeline_stage: req.body.stage };
    const { data } = await supabase.from('candidates').update(updates).eq('id', req.params.id).select('*').single();
    if (req.body.stage === 'Archived') {
      await rejectPendingApprovalsForCandidate(req.params.id, 'Candidate archived');
      await logActivity(data.job_id, data.id, 'CHAT_ENDED', `${data.name} conversation ended manually`, {
        reason: req.body.reason || 'Archived manually',
        source: 'mission_control',
      });
    }
    res.json(data);
  });

  app.post('/api/candidates/:id/end-chat', async (req, res) => {
    const { data: candidate } = await supabase.from('candidates').select('*').eq('id', req.params.id).single();
    const reason = req.body.reason || 'Ended manually from Mission Control';
    const { data } = await supabase
      .from('candidates')
      .update(markConversationEnded(candidate, reason, { archive: true }))
      .eq('id', req.params.id)
      .select('*')
      .single();
    await rejectPendingApprovalsForCandidate(req.params.id, 'Conversation ended');
    await logActivity(data.job_id, data.id, 'CHAT_ENDED', `${data.name} conversation ended manually`, {
      reason,
      source: 'mission_control',
    });
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
  app.post('/api/jobs/:jobId/candidates/:candidateId/schedule-interview', async (req, res) => {
    const [{ data: candidate }, { data: job }] = await Promise.all([
      supabase.from('candidates').select('*').eq('id', req.params.candidateId).eq('job_id', req.params.jobId).single(),
      supabase.from('jobs').select('*').eq('id', req.params.jobId).single(),
    ]);
    if (!candidate || !job) return res.status(404).json({ error: 'Candidate or job not found' });
    const interviewId = await scheduleInterviewInZoho(candidate, normalizeJobRecord(job), req.body.proposed_time || null, req.body.notes || '');
    if (!interviewId) return res.status(400).json({ error: 'Interview scheduling failed' });
    res.json({ success: true, zoho_interview_id: interviewId });
  });
  app.post('/api/jobs/:jobId/candidates/:candidateId/draft-applicant-reply', async (req, res) => {
    const [{ data: candidate }, { data: job }] = await Promise.all([
      supabase.from('candidates').select('*').eq('id', req.params.candidateId).eq('job_id', req.params.jobId).single(),
      supabase.from('jobs').select('*').eq('id', req.params.jobId).single(),
    ]);
    if (!candidate || !job) return res.status(404).json({ error: 'Candidate or job not found' });
    const approval = await draftApplicantReply(candidate, normalizeJobRecord(job));
    if (!approval) return res.status(400).json({ error: 'No applicant reply was queued' });
    res.json(approval);
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
      .select('*, candidates(id, name, current_company, job_id), jobs(*)')
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: false })
      .limit(200);
    res.json((data || []).map((row) => ({ ...normalizeConversationRecord(row), jobs: normalizeJobRecord(row.jobs) })));
  });

  app.get('/api/activity', async (req, res) => {
    const { data } = await supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(100);
    res.json(data || []);
  });

  app.get('/api/approval-queue', async (req, res) => {
    const { data } = await supabase
      .from('approval_queue')
      .select('*, candidates(name, current_title, current_company, fit_score, fit_grade), jobs(*)')
      .in('status', ['pending', 'edited', 'approved'])
      .order('created_at', { ascending: false });
    res.json((data || []).map((row) => ({ ...normalizeApprovalRecord(row), jobs: normalizeJobRecord(row.jobs) })));
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
