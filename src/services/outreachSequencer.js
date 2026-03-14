import supabase from '../db/supabase.js';
import { callClaude } from '../integrations/claude.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { queueApproval } from './approvalService.js';
import { logActivity } from './activityLogger.js';
import { processEnrichmentQueue } from './enrichmentService.js';
import { sourceCandidatesForJob } from './candidateSourcing.js';

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function ensureDailyLimits(jobId) {
  const { data } = await supabase
    .from('daily_limits')
    .upsert({ job_id: jobId, date: todayIsoDate() }, { onConflict: 'job_id,date' })
    .select('*')
    .single();
  return data;
}

async function draftMessage(prompt) {
  return callClaude(prompt, 'You write concise, warm recruiter outreach. Return plain text only.').catch(() => null);
}

export async function sendPendingConnectionRequests(job) {
  const limits = await ensureDailyLimits(job.id);
  const remaining = Math.max(0, (job.linkedin_daily_limit || 28) - (limits?.invites_sent || 0));
  if (!remaining) return 0;

  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .eq('pipeline_stage', 'Shortlisted')
    .in('fit_grade', ['HOT', 'WARM'])
    .order('fit_score', { ascending: false })
    .limit(remaining);

  for (const candidate of candidates || []) {
    // eslint-disable-next-line no-await-in-loop
    const message = await draftMessage(`Write a LinkedIn connection request under 300 characters.\nCandidate: ${candidate.name}, ${candidate.current_title} at ${candidate.current_company}\nJob: ${job.job_title} at ${job.client_name}\nUse one specific hook from this profile: ${candidate.notes || candidate.tech_skills || candidate.current_company}.`);
    if (!message) continue;
    // eslint-disable-next-line no-await-in-loop
    await queueApproval({ candidateId: candidate.id, jobId: job.id, channel: 'connection_request', stage: 'invite_sent', messageText: message.slice(0, 300) });
  }

  return (candidates || []).length;
}

export async function sendPendingDMs(job) {
  const limits = await ensureDailyLimits(job.id);
  const remaining = Math.max(0, 50 - (limits?.dms_sent || 0));
  if (!remaining) return 0;

  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .eq('pipeline_stage', 'invite_accepted')
    .order('fit_score', { ascending: false })
    .limit(remaining);

  for (const candidate of candidates || []) {
    // eslint-disable-next-line no-await-in-loop
    const message = await draftMessage(`Write a personalized LinkedIn DM.\nCandidate: ${JSON.stringify(candidate)}\nJob: ${JSON.stringify(job)}\nReference something specific from their profile and mention salary if present.`);
    if (!message) continue;
    // eslint-disable-next-line no-await-in-loop
    await queueApproval({ candidateId: candidate.id, jobId: job.id, channel: 'linkedin_dm', stage: 'dm_sent', messageText: message });
  }

  return (candidates || []).length;
}

export async function sendPendingEmails(job) {
  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .eq('pipeline_stage', 'Enriched')
    .not('email', 'is', null)
    .order('fit_score', { ascending: false })
    .limit(25);

  for (const candidate of candidates || []) {
    // eslint-disable-next-line no-await-in-loop
    const message = await draftMessage(`Write a longer-form recruiting email.\nCandidate: ${JSON.stringify(candidate)}\nJob: ${JSON.stringify(job)}\nInclude role, client, salary, and why the role is interesting.`);
    if (!message) continue;
    // eslint-disable-next-line no-await-in-loop
    await queueApproval({ candidateId: candidate.id, jobId: job.id, channel: 'email', stage: 'email_sent', messageText: message });
  }

  return (candidates || []).length;
}

function nextFollowUpDate(count) {
  const days = count === 0 ? 3 : count === 1 ? 7 : 14;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export async function sendPendingFollowUps(job) {
  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .in('pipeline_stage', ['dm_sent', 'email_sent'])
    .lte('follow_up_due_at', new Date().toISOString());

  for (const candidate of candidates || []) {
    if ((candidate.follow_up_count || 0) >= 3) {
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('candidates').update({
        pipeline_stage: 'Withdrawn',
        notes: `${candidate.notes || ''}\n[NO_RESPONSE_AFTER_FOLLOWUPS]`.trim(),
      }).eq('id', candidate.id);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const message = await draftMessage(`Write a brief recruiter follow-up. Candidate has not replied yet.\nCandidate: ${JSON.stringify(candidate)}\nJob: ${JSON.stringify(job)}`);
    if (!message) continue;
    // eslint-disable-next-line no-await-in-loop
    await queueApproval({
      candidateId: candidate.id,
      jobId: job.id,
      channel: candidate.pipeline_stage === 'email_sent' ? 'email' : 'linkedin_dm',
      stage: candidate.pipeline_stage,
      messageText: message,
    });
    // eslint-disable-next-line no-await-in-loop
    await supabase.from('candidates').update({
      follow_up_count: (candidate.follow_up_count || 0) + 1,
      follow_up_due_at: nextFollowUpDate(candidate.follow_up_count || 0),
    }).eq('id', candidate.id);
  }

  return (candidates || []).length;
}

async function checkStuckStages(job) {
  const inviteThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const qualifiedThreshold = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: staleInvites }, { data: staleQualified }] = await Promise.all([
    supabase.from('candidates').select('*').eq('job_id', job.id).eq('pipeline_stage', 'invite_sent').lte('invite_sent_at', inviteThreshold),
    supabase.from('candidates').select('*').eq('job_id', job.id).eq('pipeline_stage', 'Qualified').lte('qualified_at', qualifiedThreshold).is('interview_booked_at', null),
  ]);

  for (const candidate of staleInvites || []) {
    // eslint-disable-next-line no-await-in-loop
    await logActivity(job.id, candidate.id, 'STUCK_STAGE_WARNING', `${candidate.name} has been in invite_sent for more than 7 days`, {});
  }

  for (const candidate of staleQualified || []) {
    // eslint-disable-next-line no-await-in-loop
    await sendTelegramMessage(getRecruiterChatId(), `⚠️ ${candidate.name} has been Qualified for more than 3 days with no interview booked for ${job.job_title}`).catch(() => null);
  }
}

export async function processJob(job) {
  await sendPendingConnectionRequests(job);
  await sendPendingDMs(job);
  await sendPendingEmails(job);
  await sendPendingFollowUps(job);
  await checkStuckStages(job);
}

export async function runOrchestratorCycle() {
  const { data: jobs } = await supabase.from('jobs').select('*').eq('status', 'ACTIVE');
  for (const job of jobs || []) {
    if (job.paused) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const { count: sourcedCount } = await supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('job_id', job.id).eq('pipeline_stage', 'Sourced');
      const cooldownMs = 24 * 60 * 60 * 1000;
      if ((sourcedCount || 0) < 10 && (!job.last_research_at || Date.now() - new Date(job.last_research_at).getTime() > cooldownMs)) {
        // eslint-disable-next-line no-await-in-loop
        await sourceCandidatesForJob(job);
        // eslint-disable-next-line no-await-in-loop
        await supabase.from('jobs').update({ last_research_at: new Date().toISOString() }).eq('id', job.id);
      }

      // eslint-disable-next-line no-await-in-loop
      await processEnrichmentQueue(job.id);
      // eslint-disable-next-line no-await-in-loop
      await processJob(job);
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await logActivity(job.id, null, 'ORCHESTRATOR_ERROR', error.message, {});
      console.error(`[outreachSequencer] orchestrator error for job ${job.id}`, error);
    }
  }

  return { processed: jobs?.length || 0 };
}
