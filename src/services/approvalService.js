import supabase from '../db/supabase.js';
import { sendTelegramMessage, editTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { startLinkedInDM, sendLinkedInDM, sendEmail } from '../integrations/unipile.js';
import { todayIsoDate } from '../lib_utils.js';
import { logActivity } from './activityLogger.js';
import {
  normalizeApprovalRecord,
  normalizeJobRecord,
  prepareApprovalInsertPayload,
  prepareApprovalUpdatePayload,
  prepareConversationInsertPayload,
} from './dbCompat.js';

const UNSENT_APPROVAL_STATUSES = ['pending', 'edited', 'approved'];

export function validateDraftMessage(content, candidate) {
  if (!content || typeof content !== 'string' || content.trim() === '') {
    throw new Error('Message content is empty');
  }

  const forbidden = [
    "i can't write this",
    'missing from your request',
    'drop those in',
    "contact's name",
    'firm are both missing',
    'i need more information',
    'please provide the',
    'insufficient data',
    'cannot construct',
  ];

  const lower = content.toLowerCase();
  for (const phrase of forbidden) {
    if (lower.includes(phrase)) {
      throw new Error(`LLM error phrase detected in draft: "${phrase}"`);
    }
  }

  const firstName = candidate?.name?.split(' ')?.[0];
  if (!firstName || ['null', 'undefined'].includes(firstName.toLowerCase())) {
    throw new Error(`Candidate first name is null or invalid: ${candidate?.name}`);
  }

  return true;
}

function approvalMessage(candidate, job, approval) {
  const normalizedJob = normalizeJobRecord(job);
  const normalizedApproval = normalizeApprovalRecord(approval);
  return [
    `👤 *${candidate.name || 'Unknown'}* - ${candidate.current_title || 'Unknown title'} at ${candidate.current_company || 'Unknown company'}`,
    `💼 *JOB:* ${normalizedJob.job_title || normalizedJob.name} at ${normalizedJob.client_name || 'Unknown client'}`,
    `📊 Fit Score: ${candidate.fit_score || 0} - ${candidate.fit_grade || 'UNKNOWN'}`,
    `📍 Stage: ${normalizedApproval.channel} -> ${normalizedApproval.stage}`,
    `🎯 ${candidate.linkedin_url || 'No LinkedIn URL'}`,
    '',
    '--- MESSAGE ---',
    normalizedApproval.message_text || '',
    '---------------',
    '',
    `✅ /approve_${approval.id}`,
    `✏️ /edit_${approval.id} [new message]`,
    `⏭ /skip_${approval.id}`,
  ].join('\n');
}

async function getApprovalContext(approval) {
  const [{ data: candidate }, { data: job }] = await Promise.all([
    supabase.from('candidates').select('*').eq('id', approval.candidate_id).single(),
    supabase.from('jobs').select('*').eq('id', approval.job_id).single(),
  ]);

  return { candidate, job: normalizeJobRecord(job) };
}

async function findExistingApproval(candidateId, channel, stage) {
  const { data } = await supabase
    .from('approval_queue')
    .select('*')
    .eq('candidate_id', candidateId)
    .eq('channel', channel)
    .eq('stage', stage)
    .in('status', UNSENT_APPROVAL_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return normalizeApprovalRecord(data);
}

async function executeSend(approval, candidate) {
  const normalizedApproval = normalizeApprovalRecord(approval);
  validateDraftMessage(normalizedApproval.message_text, candidate);

  if (normalizedApproval.channel === 'linkedin_dm') {
    if (!candidate.linkedin_provider_id && !candidate.unipile_chat_id) {
      throw new Error('Missing LinkedIn identifiers for DM');
    }
    if (!candidate.unipile_chat_id) {
      return startLinkedInDM(candidate.linkedin_provider_id, normalizedApproval.message_text);
    }
    return sendLinkedInDM(candidate.unipile_chat_id, normalizedApproval.message_text);
  }

  if (normalizedApproval.channel === 'email') {
    if (!candidate.email) {
      throw new Error('Missing email address for email send');
    }
    return sendEmail(candidate.email, candidate.name, `${candidate.current_title || 'Opportunity'} at ${candidate.current_company || 'Raxion'}`, normalizedApproval.message_text);
  }

  throw new Error(`Unsupported channel ${normalizedApproval.channel}`);
}

async function applyStageAfterSend(approval, candidate, result) {
  const normalizedApproval = normalizeApprovalRecord(approval);
  const updates = {};
  const now = new Date().toISOString();

  if (normalizedApproval.channel === 'linkedin_dm') {
    updates.pipeline_stage = normalizedApproval.stage || 'dm_sent';
    updates.dm_sent_at = now;
    updates.unipile_chat_id = result?.chat_id || candidate.unipile_chat_id;
    updates.follow_up_due_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  } else if (normalizedApproval.channel === 'email') {
    updates.pipeline_stage = normalizedApproval.stage || 'email_sent';
    updates.follow_up_due_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  }

  if (Object.keys(updates).length) {
    await supabase.from('candidates').update(updates).eq('id', candidate.id);
  }

  await supabase.from('conversations').insert(await prepareConversationInsertPayload({
    candidate_id: candidate.id,
    job_id: normalizedApproval.job_id,
    direction: 'outbound',
    channel: normalizedApproval.channel,
    message_text: normalizedApproval.message_text,
    unipile_message_id: result?.message_id || null,
    sent_at: new Date().toISOString(),
    read: true,
  }));
}

async function incrementDailyLimit(approval) {
  const { data: limits } = await supabase.from('daily_limits').upsert({
    job_id: approval.job_id,
    date: todayIsoDate(),
  }, {
    onConflict: 'job_id,date',
  }).select('*').single();

  if (!limits) return;

  const updates = {};
  const normalizedApproval = normalizeApprovalRecord(approval);
  if (normalizedApproval.channel === 'linkedin_dm') updates.dms_sent = (limits.dms_sent || 0) + 1;
  if (normalizedApproval.channel === 'email') updates.emails_sent = (limits.emails_sent || 0) + 1;
  if (Object.keys(updates).length) {
    await supabase.from('daily_limits').update(updates).eq('job_id', approval.job_id).eq('date', todayIsoDate());
  }
}

export async function queueApproval({ candidateId, jobId, messageText, channel, stage }) {
  if (channel === 'connection_request') {
    await logActivity(jobId, candidateId, 'MESSAGE_SKIPPED', 'Connection requests are sent autonomously and never queued for approval', {
      channel,
      stage,
      autonomous: true,
    });
    return null;
  }

  const [{ data: candidate, error: candidateError }, { data: job, error: jobError }] = await Promise.all([
    supabase.from('candidates').select('*').eq('id', candidateId).single(),
    supabase.from('jobs').select('*').eq('id', jobId).single(),
  ]);
  if (candidateError || jobError || !candidate || !job) return null;

  try {
    validateDraftMessage(messageText, candidate);
  } catch (error) {
    await logActivity(jobId, candidateId, 'MESSAGE_VALIDATION_FAILED', `Draft blocked for ${channel}: ${error.message}`, {
      channel,
      stage,
    });
    return null;
  }

  const existing = await findExistingApproval(candidateId, channel, stage);
  if (existing) {
    if (existing.status !== 'approved' && existing.message_text !== messageText) {
      const { data: updated } = await supabase.from('approval_queue').update({
        message_text: messageText,
      }).eq('id', existing.id).select('*').single();

      if (updated?.telegram_message_id) {
        await editTelegramMessage(getRecruiterChatId(), updated.telegram_message_id, approvalMessage(candidate, job, updated)).catch(() => null);
      }

      await logActivity(jobId, candidateId, 'MESSAGE_DRAFT_UPDATED', `Updated queued ${channel} draft`, {
        approval_id: updated?.id || existing.id,
        stage,
      });
      return updated || existing;
    }
    return existing;
  }

  const { data: approval, error } = await supabase.from('approval_queue').insert(await prepareApprovalInsertPayload({
    candidate_id: candidateId,
    job_id: jobId,
    message_text: messageText,
    channel,
    stage,
    message_type: channel,
  })).select('*').single();
  if (error || !approval) return null;
  const normalizedApproval = normalizeApprovalRecord(approval);

  const telegramResponse = await sendTelegramMessage(getRecruiterChatId(), approvalMessage(candidate, job, approval)).catch(() => null);
  if (telegramResponse?.result?.message_id) {
    await supabase.from('approval_queue').update(await prepareApprovalUpdatePayload({
      telegram_message_id: String(telegramResponse.result.message_id),
    })).eq('id', approval.id);
  }

  await logActivity(jobId, candidateId, 'MESSAGE_DRAFTED', `Drafted ${channel} and queued for approval`, {
    approval_id: normalizedApproval.id,
    channel,
    stage,
  });
  return normalizedApproval;
}

export async function approveQueuedMessage(approvalId) {
  const { data: rawApproval } = await supabase.from('approval_queue').select('*').eq('id', approvalId).single();
  const approval = normalizeApprovalRecord(rawApproval);
  if (!approval || !['pending', 'edited'].includes(approval.status)) return null;

  const { candidate } = await getApprovalContext(approval);
  if (!candidate) return null;

  try {
    validateDraftMessage(approval.message_text, candidate);
  } catch (error) {
    await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_VALIDATION_FAILED', `Approval blocked: ${error.message}`, {
      approval_id: approvalId,
      channel: approval.channel,
    });
    return null;
  }

  const { data: updated } = await supabase.from('approval_queue').update(await prepareApprovalUpdatePayload({
    status: 'approved',
    approved_at: new Date().toISOString(),
  })).eq('id', approvalId).select('*').single();
  await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_APPROVED', `Recruiter approved ${approval.channel}`, {
    approval_id: approvalId,
    channel: approval.channel,
  });
  return normalizeApprovalRecord(updated) || approval;
}

export async function executeApprovedSends(job) {
  const { data: approvals } = await supabase
    .from('approval_queue')
    .select('*')
    .eq('job_id', job.id)
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(25);

  let sentCount = 0;

  for (const approval of approvals || []) {
    const normalizedApproval = normalizeApprovalRecord(approval);
    if (normalizedApproval.channel === 'connection_request') {
      // Legacy queue items are ignored now that invites send autonomously.
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('approval_queue').update({ status: 'rejected' }).eq('id', approval.id);
      // eslint-disable-next-line no-await-in-loop
      await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_SKIPPED', 'Legacy connection request approval ignored', {
        approval_id: approval.id,
        channel: approval.channel,
        autonomous: true,
      });
      continue;
    }

      const { candidate } = await getApprovalContext(normalizedApproval);
    if (!candidate) {
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('approval_queue').update({ status: 'error' }).eq('id', approval.id);
      // eslint-disable-next-line no-await-in-loop
      await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_SEND_ERROR', 'Candidate missing for approved send', {
        approval_id: approval.id,
      });
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await executeSend(normalizedApproval, candidate);
      if (!result) {
        throw new Error('Unipile send returned no result');
      }
      // eslint-disable-next-line no-await-in-loop
      await applyStageAfterSend(normalizedApproval, candidate, result);
      // eslint-disable-next-line no-await-in-loop
      await incrementDailyLimit(normalizedApproval);
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('approval_queue').update(await prepareApprovalUpdatePayload({
        status: 'sent',
        sent_at: new Date().toISOString(),
      })).eq('id', approval.id);
      // eslint-disable-next-line no-await-in-loop
      await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_SENT', `Sent ${normalizedApproval.channel} via Unipile`, {
        approval_id: approval.id,
        channel: normalizedApproval.channel,
        sent_at: new Date().toISOString(),
      });
      sentCount += 1;
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('approval_queue').update({ status: 'error' }).eq('id', approval.id);
      // eslint-disable-next-line no-await-in-loop
      await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_SEND_ERROR', `Failed to send ${normalizedApproval.channel}: ${error.message}`, {
        approval_id: approval.id,
        channel: normalizedApproval.channel,
      });
    }
  }

  return sentCount;
}

export async function editQueuedMessage(approvalId, messageText) {
  const { data: rawExisting } = await supabase.from('approval_queue').select('*').eq('id', approvalId).single();
  const existing = normalizeApprovalRecord(rawExisting);
  if (!existing || !['pending', 'edited'].includes(existing.status)) return null;

  const { candidate, job } = await getApprovalContext(existing);
  if (!candidate || !job) return null;

  try {
    validateDraftMessage(messageText, candidate);
  } catch (error) {
    await logActivity(existing.job_id, existing.candidate_id, 'MESSAGE_VALIDATION_FAILED', `Edited draft blocked: ${error.message}`, {
      approval_id: approvalId,
      channel: existing.channel,
    });
    return null;
  }

  const { data: approval } = await supabase.from('approval_queue').update(await prepareApprovalUpdatePayload({
    message_text: messageText,
    status: 'edited',
  })).eq('id', approvalId).select('*').single();
  if (!approval) return null;
  const normalizedApproval = normalizeApprovalRecord(approval);

  if (normalizedApproval.telegram_message_id) {
    await editTelegramMessage(getRecruiterChatId(), normalizedApproval.telegram_message_id, approvalMessage(candidate, job, normalizedApproval)).catch(() => null);
  }

  await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_DRAFT_UPDATED', `Edited queued ${approval.channel} message`, { approval_id: approvalId });
  return normalizedApproval;
}

export async function skipQueuedMessage(approvalId) {
  const { data: approval } = await supabase.from('approval_queue').update(await prepareApprovalUpdatePayload({ status: 'rejected' })).eq('id', approvalId).select('*').single();
  if (!approval) return null;
  const normalizedApproval = normalizeApprovalRecord(approval);
  await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_SKIPPED', `Skipped queued ${normalizedApproval.channel} message`, { approval_id: approvalId });
  return normalizedApproval;
}
