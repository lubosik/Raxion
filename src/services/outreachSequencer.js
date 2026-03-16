import supabase from '../db/supabase.js';
import { callClaude } from '../integrations/claude.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { sleep, todayIsoDate } from '../lib_utils.js';
import { queueApproval, executeApprovedSends } from './approvalService.js';
import { logActivity, logActivityOncePerWindow } from './activityLogger.js';
import { processEnrichmentQueue } from './enrichmentService.js';
import { sourceCandidatesForJob, scoreUnscoredCandidates } from './candidateSourcing.js';
import { getRuntimeState } from './runtimeState.js';
import { isWithinSendingWindow } from './scheduleService.js';
import { buildTemplateAwarePrompt } from './outreachTemplates.js';

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

async function getPipelineCandidateCount(jobId, stages) {
  const { count } = await supabase
    .from('candidates')
    .select('*', { count: 'exact', head: true })
    .eq('job_id', jobId)
    .in('pipeline_stage', stages);

  return count || 0;
}

async function draftConnectionRequests(job) {
  const limits = await ensureDailyLimits(job.id);
  const pendingApprovals = await supabase
    .from('approval_queue')
    .select('*', { count: 'exact', head: true })
    .eq('job_id', job.id)
    .eq('channel', 'connection_request')
    .in('status', ['pending', 'edited', 'approved']);
  const queuedCount = pendingApprovals.count || 0;
  const remaining = Math.max(0, (job.linkedin_daily_limit || 28) - ((limits?.invites_sent || 0) + queuedCount));
  if (!remaining) return 0;

  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .eq('pipeline_stage', 'Shortlisted')
    .in('fit_grade', ['HOT', 'WARM'])
    .order('fit_score', { ascending: false })
    .limit(remaining);

  let draftedCount = 0;
  for (const candidate of candidates || []) {
    // eslint-disable-next-line no-await-in-loop
    const message = await draftMessage(buildTemplateAwarePrompt(job, 'connection_request', `Write a LinkedIn connection request under 300 characters.\nCandidate: ${candidate.name}, ${candidate.current_title} at ${candidate.current_company}\nJob: ${job.job_title} at ${job.client_name}\nUse one specific hook from this profile: ${candidate.notes || candidate.tech_skills || candidate.current_company}.`));
    if (!message) continue;
    // eslint-disable-next-line no-await-in-loop
    const approval = await queueApproval({
      candidateId: candidate.id,
      jobId: job.id,
      channel: 'connection_request',
      stage: 'invite_sent',
      messageText: message.slice(0, 300),
    });
    if (approval) draftedCount += 1;
  }

  return draftedCount;
}

async function draftFirstDMs(job) {
  const limits = await ensureDailyLimits(job.id);
  const pendingApprovals = await supabase
    .from('approval_queue')
    .select('*', { count: 'exact', head: true })
    .eq('job_id', job.id)
    .eq('channel', 'linkedin_dm')
    .in('status', ['pending', 'edited', 'approved']);
  const queuedCount = pendingApprovals.count || 0;
  const remaining = Math.max(0, 50 - ((limits?.dms_sent || 0) + queuedCount));
  if (!remaining) return 0;

  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .eq('pipeline_stage', 'invite_accepted')
    .order('fit_score', { ascending: false })
    .limit(remaining);

  let draftedCount = 0;
  for (const candidate of candidates || []) {
    // eslint-disable-next-line no-await-in-loop
    const message = await draftMessage(buildTemplateAwarePrompt(job, 'linkedin_dm', `Write a personalized LinkedIn DM.\nCandidate: ${JSON.stringify(candidate)}\nJob: ${JSON.stringify(job)}\nReference something specific from their profile and mention salary if present.`));
    if (!message) continue;
    // eslint-disable-next-line no-await-in-loop
    const approval = await queueApproval({
      candidateId: candidate.id,
      jobId: job.id,
      channel: 'linkedin_dm',
      stage: 'dm_sent',
      messageText: message,
    });
    if (approval) draftedCount += 1;
  }

  return draftedCount;
}

async function draftOutboundEmails(job) {
  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .eq('pipeline_stage', 'Enriched')
    .not('email', 'is', null)
    .order('fit_score', { ascending: false })
    .limit(25);

  let draftedCount = 0;
  for (const candidate of candidates || []) {
    // eslint-disable-next-line no-await-in-loop
    const message = await draftMessage(buildTemplateAwarePrompt(job, 'email', `Write a longer-form recruiting email.\nCandidate: ${JSON.stringify(candidate)}\nJob: ${JSON.stringify(job)}\nInclude role, client, salary, and why the role is interesting.`));
    if (!message) continue;
    // eslint-disable-next-line no-await-in-loop
    const approval = await queueApproval({
      candidateId: candidate.id,
      jobId: job.id,
      channel: 'email',
      stage: 'email_sent',
      messageText: message,
    });
    if (approval) draftedCount += 1;
  }

  return draftedCount;
}

function nextFollowUpDate(count) {
  const days = count === 0 ? 3 : count === 1 ? 7 : 14;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function draftFollowUps(job) {
  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .in('pipeline_stage', ['dm_sent', 'email_sent'])
    .lte('follow_up_due_at', new Date().toISOString());

  let draftedCount = 0;
  for (const candidate of candidates || []) {
    if ((candidate.follow_up_count || 0) >= 3) {
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('candidates').update({
        pipeline_stage: 'Archived',
        notes: `${candidate.notes || ''}\n[NO_RESPONSE_AFTER_FOLLOWUPS]`.trim(),
      }).eq('id', candidate.id);
      // eslint-disable-next-line no-await-in-loop
      await logActivity(job.id, candidate.id, 'CANDIDATE_ARCHIVED', `${candidate.name} archived after follow-up limit`, {
        follow_up_count: candidate.follow_up_count || 0,
      });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const message = await draftMessage(buildTemplateAwarePrompt(job, 'follow_up', `Write a brief recruiter follow-up. Candidate has not replied yet.\nCandidate: ${JSON.stringify(candidate)}\nJob: ${JSON.stringify(job)}`));
    if (!message) continue;

    // eslint-disable-next-line no-await-in-loop
    const approval = await queueApproval({
      candidateId: candidate.id,
      jobId: job.id,
      channel: candidate.pipeline_stage === 'email_sent' ? 'email' : 'linkedin_dm',
      stage: candidate.pipeline_stage,
      messageText: message,
    });

    if (approval) {
      draftedCount += 1;
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('candidates').update({
        follow_up_count: (candidate.follow_up_count || 0) + 1,
        follow_up_due_at: nextFollowUpDate(candidate.follow_up_count || 0),
      }).eq('id', candidate.id);
    }
  }

  return draftedCount;
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

export async function runJobCycle(job, runtimeState) {
  const withinWindow = isWithinSendingWindow(job);

  if (runtimeState.researchEnabled) {
    const candidateCount = await getPipelineCandidateCount(job.id, ['Sourced', 'Shortlisted', 'Enriched']);
    const cooldownMs = 24 * 60 * 60 * 1000;
    if (candidateCount < 10 && (!job.last_research_at || Date.now() - new Date(job.last_research_at).getTime() > cooldownMs)) {
      await logActivity(job.id, null, 'AUTO_SOURCING', `Pipeline light (${candidateCount}), triggering sourcing`, {});
      await sourceCandidatesForJob(job);
      await supabase.from('jobs').update({ last_research_at: new Date().toISOString() }).eq('id', job.id);
    }
  }

  await scoreUnscoredCandidates(job);

  if (runtimeState.enrichmentEnabled) {
    await processEnrichmentQueue(job.id);
  }

  if (runtimeState.linkedinEnabled && runtimeState.outreachEnabled) {
    await draftConnectionRequests(job);
    await draftFirstDMs(job);
  }

  if (runtimeState.outreachEnabled) {
    await draftOutboundEmails(job);
  }

  if (runtimeState.followupEnabled) {
    await draftFollowUps(job);
  }

  if (withinWindow) {
    await executeApprovedSends(job);
  } else {
    await logActivityOncePerWindow(job.id, null, 'OUTSIDE_SENDING_WINDOW', `Outside sending window for ${job.job_title}; sourcing, scoring, enrichment, and drafting continue`, {
      send_from: job.send_from || '08:00',
      send_until: job.send_until || '18:00',
      timezone: job.timezone || 'Europe/London',
      active_days: job.active_days || 'Mon,Tue,Wed,Thu,Fri',
    }, 60);
  }

  await checkStuckStages(job);
}

export async function runOrchestratorCycle() {
  const runtimeState = await getRuntimeState();
  if (runtimeState.raxionStatus !== 'ACTIVE' || runtimeState.outreachPausedUntil && new Date(runtimeState.outreachPausedUntil).getTime() > Date.now()) {
    return { processed: 0, skipped: true };
  }

  const { data: jobs } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'ACTIVE')
    .order('created_at', { ascending: true });

  let processed = 0;
  for (const job of jobs || []) {
    if (job.paused) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await runJobCycle(job, runtimeState);
      processed += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(2000);
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await logActivity(job.id, null, 'ORCHESTRATOR_ERROR', error.message, {});
      console.error(`[outreachSequencer] orchestrator error for job ${job.id}`, error);
    }
  }

  return { processed };
}
