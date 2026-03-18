import supabase from '../db/supabase.js';
import { callClaude } from '../integrations/claude.js';
import { checkLinkedInConnectionStatus, resolveLinkedInProviderId, sendConnectionRequest } from '../integrations/unipile.js';
import { getRuntimeConfigValue } from './configService.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { sleep, todayIsoDate } from '../lib_utils.js';
import { queueApproval, executeApprovedSends } from './approvalService.js';
import { logActivity, logActivityOncePerWindow } from './activityLogger.js';
import { processEnrichmentQueue } from './enrichmentService.js';
import { isValidCandidate, sourceCandidatesForJob, scoreUnscoredCandidates } from './candidateSourcing.js';
import { getRuntimeState } from './runtimeState.js';
import { getChannelWindow, isWithinSendingWindow } from './scheduleService.js';
import { buildTemplateAwarePrompt, parseTemplates } from './outreachTemplates.js';
import { normalizeJobRecord } from './dbCompat.js';
import { draftApplicantReply, fetchAndProcessApplicants, notifyTeamOfShortlist } from './inboundApplicantService.js';
import {
  enqueueJobsForExecution,
  processDistributedJobQueue,
  processJobsWithQueue,
  runSerializedOrchestratorCycle,
  supportsDistributedExecutionQueue,
} from './jobExecutionQueue.js';

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

async function notifyDraftFailure(job, candidate, channel, stage) {
  const activity = await logActivityOncePerWindow(
    job.id,
    candidate.id,
    'MESSAGE_DRAFT_ERROR',
    `Failed to draft ${channel} for ${candidate.name}`,
    {
      channel,
      stage,
      candidate_name: candidate.name,
      job_title: job.job_title,
      reason: 'Claude returned no draft response',
    },
    60,
  );

  if (!activity) {
    return;
  }

  await sendTelegramMessage(
    getRecruiterChatId(),
    `⚠️ Draft failed for ${candidate.name} on ${job.job_title} (${channel}). No approval was queued. Check Claude credits/runtime and retry.`,
  ).catch(() => null);
}

async function getUnsentApprovalKeySet(jobId, channel) {
  const { data: approvals } = await supabase
    .from('approval_queue')
    .select('candidate_id,stage')
    .eq('job_id', jobId)
    .eq('channel', channel)
    .in('status', ['pending', 'edited', 'approved']);

  return new Set((approvals || []).map((approval) => `${approval.candidate_id}:${approval.stage || ''}`));
}

function approvalKey(candidateId, stage) {
  return `${candidateId}:${stage || ''}`;
}

async function incrementDailyLimit(jobId, channel) {
  const limits = await ensureDailyLimits(jobId);
  if (!limits) return;

  const updates = {};
  if (channel === 'connection_request') updates.invites_sent = (limits.invites_sent || 0) + 1;
  if (channel === 'linkedin_dm') updates.dms_sent = (limits.dms_sent || 0) + 1;
  if (channel === 'email') updates.emails_sent = (limits.emails_sent || 0) + 1;

  if (Object.keys(updates).length) {
    await supabase.from('daily_limits').update(updates).eq('job_id', jobId).eq('date', todayIsoDate());
  }
}

async function getPipelineCandidateCount(jobId, stages) {
  const { count } = await supabase
    .from('candidates')
    .select('*', { count: 'exact', head: true })
    .eq('job_id', jobId)
    .in('pipeline_stage', stages);

  return count || 0;
}

function getNumericRuntimeValue(key, fallback) {
  const raw = getRuntimeConfigValue(key, null);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function displayCandidateName(candidate) {
  const name = String(candidate?.name || '').trim();
  if (!name || ['linkedin member', 'null'].includes(name.toLowerCase())) {
    return 'unknown name';
  }
  return name;
}

function buildInviteLogDetail(candidate, error = null) {
  return {
    candidate_name: displayCandidateName(candidate),
    current_title: candidate.current_title || 'unknown title',
    current_company: candidate.current_company || 'unknown company',
    linkedin_url: candidate.linkedin_url || null,
    provider_id: candidate.linkedin_provider_id || null,
    error: error || null,
  };
}

async function archiveInvalidCandidate(candidate, job, reason) {
  await supabase.from('candidates').update({
    pipeline_stage: 'Archived',
    fit_grade: 'INVALID',
    notes: `Auto-archived: ${reason}`,
    enrichment_status: 'Skipped',
  }).eq('id', candidate.id);

  await logActivity(
    job.id,
    candidate.id,
    'CANDIDATE_ARCHIVED',
    `[${job.job_title}]: ${displayCandidateName(candidate)} auto-archived - ${reason}`,
    {
      ...buildInviteLogDetail(candidate),
      reason,
    },
  );
}

async function sendLinkedInConnectionRequest(candidate, job) {
  const validation = isValidCandidate(candidate);
  if (!validation.valid) {
    await archiveInvalidCandidate(candidate, job, validation.reason === 'no_name' ? 'no_valid_name' : 'no_valid_linkedin');
    return { success: false, reason: validation.reason === 'no_name' ? 'archived_no_name' : 'archived_no_linkedin' };
  }

  if (!candidate.linkedin_provider_id) {
    const resolvedProviderId = await resolveLinkedInProviderId(candidate.linkedin_url);
    if (!resolvedProviderId) {
      await archiveInvalidCandidate(candidate, job, 'provider_id_not_resolved');
      return { success: false, reason: 'archived_no_provider_id' };
    }

    await supabase.from('candidates').update({ linkedin_provider_id: resolvedProviderId }).eq('id', candidate.id);
    candidate.linkedin_provider_id = resolvedProviderId;
  }

  try {
    const connectionStatus = await checkLinkedInConnectionStatus(candidate.linkedin_provider_id);

    if (connectionStatus === 'connected') {
      await supabase.from('candidates').update({
        pipeline_stage: 'invite_accepted',
        invite_sent_at: candidate.invite_sent_at || new Date().toISOString(),
        invite_accepted_at: new Date().toISOString(),
        notes: [candidate.notes, 'Already connected on LinkedIn - skipped invite'].filter(Boolean).join(' | '),
      }).eq('id', candidate.id);

      await logActivity(
        job.id,
        candidate.id,
        'ALREADY_CONNECTED',
        `[${job.job_title}]: Already connected with ${displayCandidateName(candidate)} on LinkedIn - moved to DM stage`,
        buildInviteLogDetail(candidate),
      );
      return { success: true, reason: 'already_connected' };
    }

    if (connectionStatus === 'pending') {
      await logActivity(
        job.id,
        candidate.id,
        'INVITE_PENDING',
        `[${job.job_title}]: Connection request to ${displayCandidateName(candidate)} is still pending - no resend`,
        buildInviteLogDetail(candidate),
      );
      return { success: true, reason: 'invite_already_pending' };
    }

    if (connectionStatus === 'not_found') {
      await archiveInvalidCandidate(candidate, job, 'linkedin_profile_not_found');
      return { success: false, reason: 'archived_profile_not_found' };
    }
  } catch (error) {
    console.warn(`[INVITE] Could not check connection status for ${candidate.name}: ${error.message}`);
  }

  try {
    const result = await sendConnectionRequest(candidate.linkedin_provider_id);
    if (!result || result.error) {
      const errorMessage = String(result?.error || 'no result returned');
      const normalizedError = errorMessage.toLowerCase();

      if (normalizedError.includes('already_connected') || normalizedError.includes('already connected')) {
        await supabase.from('candidates').update({
          pipeline_stage: 'invite_accepted',
          invite_sent_at: candidate.invite_sent_at || new Date().toISOString(),
          invite_accepted_at: new Date().toISOString(),
        }).eq('id', candidate.id);

        await logActivity(
          job.id,
          candidate.id,
          'ALREADY_CONNECTED',
          `[${job.job_title}]: Already connected with ${displayCandidateName(candidate)} - moved to DM stage`,
          buildInviteLogDetail(candidate, errorMessage),
        );
        return { success: true, reason: 'already_connected' };
      }

      if (normalizedError.includes('pending') || normalizedError.includes('invitation_pending')) {
        await logActivity(
          job.id,
          candidate.id,
          'INVITE_PENDING',
          `[${job.job_title}]: Invite to ${displayCandidateName(candidate)} is already pending - no action needed`,
          buildInviteLogDetail(candidate, errorMessage),
        );
        return { success: true, reason: 'invite_already_pending' };
      }

      if (normalizedError.includes('profile_not_found') || normalizedError.includes('does not exist') || normalizedError.includes('invalid_profile')) {
        await archiveInvalidCandidate(candidate, job, 'linkedin_profile_not_found');
        return { success: false, reason: 'archived_profile_not_found' };
      }

      await logActivity(
        job.id,
        candidate.id,
        'INVITE_SEND_ERROR',
        `[${job.job_title}]: Failed to send invite to ${displayCandidateName(candidate)} (${candidate.current_title || 'unknown title'}) at ${candidate.current_company || 'unknown company'} - ${errorMessage}`,
        buildInviteLogDetail(candidate, errorMessage),
      );
      return { success: false, reason: errorMessage };
    }

    await supabase.from('candidates').update({
      pipeline_stage: 'invite_sent',
      invite_sent_at: new Date().toISOString(),
    }).eq('id', candidate.id);

    await logActivity(
      job.id,
      candidate.id,
      'INVITE_SENT',
      `[${job.job_title}]: Connection request sent to ${displayCandidateName(candidate)} (${candidate.current_title || 'unknown title'}) at ${candidate.current_company || 'unknown company'}`,
      buildInviteLogDetail(candidate),
    );

    return { success: true };
  } catch (error) {
    await logActivity(
      job.id,
      candidate.id,
      'INVITE_SEND_ERROR',
      `[${job.job_title}]: Exception sending invite to ${displayCandidateName(candidate)} (${candidate.current_title || 'unknown title'}) at ${candidate.current_company || 'unknown company'} - ${error.message}`,
      buildInviteLogDetail(candidate, error.message),
    );
    return { success: false, reason: error.message };
  }
}

async function sendAutonomousConnectionRequests(job) {
  const limits = await ensureDailyLimits(job.id);
  const remaining = Math.max(0, (job.linkedin_daily_limit || 28) - (limits?.invites_sent || 0));
  if (!remaining) return 0;

  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .eq('pipeline_stage', 'Shortlisted')
    .in('fit_grade', ['HOT', 'WARM'])
    .not('fit_grade', 'eq', 'INVALID')
    .order('fit_score', { ascending: false })
    .limit(remaining);

  let sentCount = 0;
  for (const candidate of candidates || []) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sendLinkedInConnectionRequest(candidate, job);
    if (result.success && result.reason !== 'already_connected' && result.reason !== 'invite_already_pending') {
      // eslint-disable-next-line no-await-in-loop
      await incrementDailyLimit(job.id, 'connection_request');
      sentCount += 1;
    }
  }

  return sentCount;
}

async function draftFirstDMs(job) {
  const limits = await ensureDailyLimits(job.id);
  const unsentApprovalKeys = await getUnsentApprovalKeySet(job.id, 'linkedin_dm');
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
    .neq('fit_grade', 'INVALID')
    .order('fit_score', { ascending: false })
    .limit(remaining);

  let draftedCount = 0;
  for (const candidate of candidates || []) {
    if (unsentApprovalKeys.has(approvalKey(candidate.id, 'dm_sent'))) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const message = await draftMessage(buildTemplateAwarePrompt(job, 'linkedin_dm', `Write a personalized LinkedIn DM.\nCandidate: ${JSON.stringify(candidate)}\nJob: ${JSON.stringify(job)}\nReference something specific from their profile and mention salary if present.`));
    if (!message) {
      // eslint-disable-next-line no-await-in-loop
      await notifyDraftFailure(job, candidate, 'linkedin_dm', 'dm_sent');
      continue;
    }
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
  const unsentApprovalKeys = await getUnsentApprovalKeySet(job.id, 'email');
  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .eq('pipeline_stage', 'Enriched')
    .neq('fit_grade', 'INVALID')
    .not('email', 'is', null)
    .order('fit_score', { ascending: false })
    .limit(25);

  let draftedCount = 0;
  for (const candidate of candidates || []) {
    if (unsentApprovalKeys.has(approvalKey(candidate.id, 'email_sent'))) {
      continue;
    }
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
  const dmApprovalKeys = await getUnsentApprovalKeySet(job.id, 'linkedin_dm');
  const emailApprovalKeys = await getUnsentApprovalKeySet(job.id, 'email');
  const { data: candidates } = await supabase
    .from('candidates')
    .select('*')
    .eq('job_id', job.id)
    .in('pipeline_stage', ['dm_sent', 'email_sent'])
    .lte('follow_up_due_at', new Date().toISOString());

  let draftedCount = 0;
  for (const candidate of candidates || []) {
    const followUpChannel = candidate.pipeline_stage === 'email_sent' ? 'email' : 'linkedin_dm';
    const approvalKeys = followUpChannel === 'email' ? emailApprovalKeys : dmApprovalKeys;
    if (approvalKeys.has(approvalKey(candidate.id, candidate.pipeline_stage))) {
      continue;
    }

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
      channel: followUpChannel,
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
    supabase.from('candidates').select('*').eq('job_id', job.id).lte('qualified_at', qualifiedThreshold).is('interview_booked_at', null).not('qualified_at', 'is', null),
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
  const normalizedJob = normalizeJobRecord(job);
  if (['inbound', 'both'].includes(normalizedJob.job_mode || 'outbound')) {
    const lastFetch = normalizedJob.last_applicant_fetch_at;
    const hoursSinceLastFetch = lastFetch
      ? (Date.now() - new Date(lastFetch).getTime()) / (1000 * 60 * 60)
      : 999;

    if (hoursSinceLastFetch >= 23) {
      await fetchAndProcessApplicants(normalizedJob);
    }

    const { data: newShortlisted } = await supabase
      .from('candidates')
      .select('*')
      .eq('job_id', normalizedJob.id)
      .eq('candidate_type', 'applicant')
      .eq('team_pinged', false)
      .in('fit_grade', ['HOT', 'WARM'])
      .gte('fit_score', 50);

    if (newShortlisted?.length) {
      await notifyTeamOfShortlist(normalizedJob, newShortlisted);
    }

    const { data: replyable } = await supabase
      .from('candidates')
      .select('*')
      .eq('job_id', normalizedJob.id)
      .eq('candidate_type', 'applicant')
      .eq('reply_sent', false)
      .not('email', 'is', null)
      .in('fit_grade', ['HOT', 'WARM'])
      .limit(5);

    for (const candidate of replyable || []) {
      // eslint-disable-next-line no-await-in-loop
      await draftApplicantReply(candidate, normalizedJob);
    }
  }

  if (!['outbound', 'both'].includes(normalizedJob.job_mode || 'outbound')) {
    return;
  }

  const withinDefaultWindow = isWithinSendingWindow(normalizedJob);
  const withinInviteWindow = isWithinSendingWindow(normalizedJob, new Date(), 'linkedin_invite');

  if (runtimeState.researchEnabled) {
    const pipelineTarget = getNumericRuntimeValue('RAXION_SOURCING_PIPELINE_TARGET', 25);
    const shortlistTarget = getNumericRuntimeValue('RAXION_SOURCING_SHORTLIST_TARGET', 5);
    const cooldownHours = getNumericRuntimeValue('RAXION_SOURCING_COOLDOWN_HOURS', 6);
    const pipelineCount = await getPipelineCandidateCount(normalizedJob.id, ['Sourced', 'Shortlisted', 'Enriched']);
    const shortlistedCount = await getPipelineCandidateCount(normalizedJob.id, ['Shortlisted']);
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const shouldTopUp = pipelineCount < pipelineTarget || shortlistedCount < shortlistTarget;

    if (shouldTopUp && (!normalizedJob.last_research_at || Date.now() - new Date(normalizedJob.last_research_at).getTime() > cooldownMs)) {
      await logActivity(normalizedJob.id, null, 'AUTO_SOURCING', `Pipeline top-up triggered (pre-outreach: ${pipelineCount}/${pipelineTarget}, shortlisted: ${shortlistedCount}/${shortlistTarget}, cooldown: ${cooldownHours}h)`, {});
      await sourceCandidatesForJob(normalizedJob);
      await supabase.from('jobs').update({ last_research_at: new Date().toISOString() }).eq('id', normalizedJob.id);
    }
  }

  await scoreUnscoredCandidates(normalizedJob);

  if (runtimeState.enrichmentEnabled) {
    await processEnrichmentQueue(normalizedJob.id);
  }

  if (withinInviteWindow && runtimeState.linkedinEnabled && runtimeState.outreachEnabled) {
    await sendAutonomousConnectionRequests(normalizedJob);
  }

  if (runtimeState.linkedinEnabled && runtimeState.outreachEnabled) {
    await draftFirstDMs(normalizedJob);
  }

  if (runtimeState.outreachEnabled) {
    await draftOutboundEmails(normalizedJob);
  }

  if (runtimeState.followupEnabled) {
    await draftFollowUps(normalizedJob);
  }

  if (withinDefaultWindow || isWithinSendingWindow(normalizedJob, new Date(), 'linkedin_dm') || isWithinSendingWindow(normalizedJob, new Date(), 'email')) {
    await executeApprovedSends(normalizedJob);
  } else {
    const defaultWindow = getChannelWindow(normalizedJob, 'default');
    const templates = parseTemplates(normalizedJob.outreach_templates);
    await logActivityOncePerWindow(normalizedJob.id, null, 'OUTSIDE_SENDING_WINDOW', `Outside sending window for ${normalizedJob.job_title}; sourcing, scoring, enrichment, and drafting continue`, {
      send_from: defaultWindow.send_from,
      send_until: defaultWindow.send_until,
      timezone: defaultWindow.timezone,
      active_days: defaultWindow.active_days,
      schedule_windows: templates.schedule_windows || {},
    }, 60);
  }

  await checkStuckStages(normalizedJob);
}

async function executeLocalOrchestratorCycle() {
  const runtimeState = await getRuntimeState();
  if (runtimeState.raxionStatus !== 'ACTIVE' || runtimeState.outreachPausedUntil && new Date(runtimeState.outreachPausedUntil).getTime() > Date.now()) {
    return { processed: 0, skipped: true };
  }

  const { data: jobs } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'ACTIVE')
    .order('created_at', { ascending: true });

  const runnableJobs = (jobs || []).map(normalizeJobRecord).filter((job) => !job.paused);
  const result = await processJobsWithQueue(runnableJobs, async (job) => {
    try {
      await runJobCycle(job, runtimeState);
      await sleep(2000);
    } catch (error) {
      await logActivity(job.id, null, 'ORCHESTRATOR_ERROR', error.message, {});
      console.error(`[outreachSequencer] orchestrator error for job ${job.id}`, error);
      throw error;
    }
  });

  return result;
}

async function executeDistributedOrchestratorCycle(reason) {
  const runtimeState = await getRuntimeState();
  if (runtimeState.raxionStatus !== 'ACTIVE' || runtimeState.outreachPausedUntil && new Date(runtimeState.outreachPausedUntil).getTime() > Date.now()) {
    return { processed: 0, skipped: true };
  }

  const { data: jobs } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'ACTIVE')
    .order('created_at', { ascending: true });

  const runnableJobs = (jobs || []).map(normalizeJobRecord).filter((job) => !job.paused);
  await enqueueJobsForExecution(runnableJobs, reason);

  return processDistributedJobQueue(async (queueItem) => {
    const { data: rawJob } = await supabase.from('jobs').select('*').eq('id', queueItem.job_id).single();
    const job = normalizeJobRecord(rawJob);
    if (!job || job.paused || job.status !== 'ACTIVE') return;

    try {
      await runJobCycle(job, runtimeState);
      await sleep(2000);
    } catch (error) {
      await logActivity(job.id, null, 'ORCHESTRATOR_ERROR', error.message, {});
      console.error(`[outreachSequencer] distributed orchestrator error for job ${job.id}`, error);
      throw error;
    }
  });
}

export async function runOrchestratorCycle(reason = 'scheduled') {
  if (await supportsDistributedExecutionQueue()) {
    return executeDistributedOrchestratorCycle(reason);
  }
  return runSerializedOrchestratorCycle(reason, executeLocalOrchestratorCycle);
}
