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
import { isWithinSendingWindow } from './scheduleService.js';
import { ensureSignedMessage } from './outreachTemplates.js';
import { isConversationEnded, markConversationEnded } from './conversationState.js';

const UNSENT_APPROVAL_STATUSES = ['pending', 'edited', 'approved'];

function getPendingApprovalPipelineStage(channel) {
  if (['linkedin_dm', 'email'].includes(channel)) return 'pending_approval';
  return null;
}

function getApprovedPipelineStage(channel, fallbackStage) {
  if (channel === 'linkedin_dm') return 'dm_approved';
  if (channel === 'email') return 'email_approved';
  return fallbackStage || null;
}

function getRejectedPipelineStage(approval, candidate) {
  if (approval.stage === 'dm_sent' && approval.channel === 'linkedin_dm') return 'invite_accepted';
  if (approval.stage === 'email_sent' && approval.channel === 'email') return 'Enriched';
  if (approval.stage === 'in_conversation') return 'reply_received';
  if (approval.stage === 'Applicant Reply Email') return candidate?.qualified_at ? 'Qualified' : 'Applied';
  if (approval.stage === 'Archived') return candidate?.last_reply_at ? 'reply_received' : candidate?.pipeline_stage || null;
  return candidate?.pipeline_stage === 'pending_approval' ? null : candidate?.pipeline_stage || null;
}

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
    '[your name]',
    '[sender name]',
    '[recruiter name]',
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
    normalizedApproval.status === 'sent'
      ? '✅ Sent via Unipile'
      : normalizedApproval.status === 'approved'
        ? '✅ Approved and queued for send'
        : normalizedApproval.status === 'rejected'
          ? '⏭ Skipped'
          : 'Use the buttons below to approve, edit, or skip.',
  ].join('\n');
}

function approvalReplyMarkup(approvalId, status, candidateId = null) {
  if (!['pending', 'edited'].includes(status)) {
    return { inline_keyboard: [] };
  }

  return {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `approval:approve:${approvalId}` },
      { text: 'Edit', callback_data: `approval:edit:${approvalId}` },
      { text: 'Skip', callback_data: `approval:skip:${approvalId}` },
    ], ...(candidateId ? [[
      { text: 'End Chat', callback_data: `candidate:endchat:${candidateId}` },
    ]] : [])],
  };
}

async function syncApprovalTelegramCard(approval) {
  const normalizedApproval = normalizeApprovalRecord(approval);
  if (!normalizedApproval?.telegram_message_id) return;

  const { candidate, job } = await getApprovalContext(normalizedApproval);
  if (!candidate || !job) return;

  await editTelegramMessage(
    getRecruiterChatId(),
    normalizedApproval.telegram_message_id,
    approvalMessage(candidate, job, normalizedApproval),
    { reply_markup: approvalReplyMarkup(normalizedApproval.id, normalizedApproval.status, candidate.id) },
  ).catch(() => null);
}

async function deliverApprovalTelegramCard(approval, candidate, job) {
  const normalizedApproval = normalizeApprovalRecord(approval);
  const telegramResponse = await sendTelegramMessage(
    getRecruiterChatId(),
    approvalMessage(candidate, job, normalizedApproval),
    { reply_markup: approvalReplyMarkup(normalizedApproval.id, normalizedApproval.status, candidate.id) },
  );

  if (telegramResponse?.result?.message_id) {
    await supabase.from('approval_queue').update(await prepareApprovalUpdatePayload({
      telegram_message_id: String(telegramResponse.result.message_id),
    })).eq('id', normalizedApproval.id);
  }

  return telegramResponse;
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
  if (isConversationEnded(candidate)) {
    throw new Error('Conversation has been ended for this candidate');
  }
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
    return sendEmail(
      candidate.email,
      candidate.name,
      normalizedApproval.subject || `${candidate.current_title || 'Opportunity'} at ${candidate.current_company || 'Raxion'}`,
      normalizedApproval.message_text,
    );
  }

  throw new Error(`Unsupported channel ${normalizedApproval.channel}`);
}

async function applyStageAfterSend(approval, candidate, result) {
  const normalizedApproval = normalizeApprovalRecord(approval);
  const updates = {};
  const now = new Date().toISOString();

  if (normalizedApproval.stage === 'Archived') {
    Object.assign(updates, markConversationEnded(candidate, 'Conversation closed after final reply', { archive: true }));
    if (normalizedApproval.channel === 'linkedin_dm') {
      updates.dm_sent_at = now;
    }
  } else if (normalizedApproval.channel === 'linkedin_dm') {
    updates.pipeline_stage = normalizedApproval.stage || 'dm_sent';
    updates.dm_sent_at = now;
    updates.unipile_chat_id = result?.chat_id || candidate.unipile_chat_id;
    updates.follow_up_due_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  } else if (normalizedApproval.channel === 'email') {
    updates.pipeline_stage = normalizedApproval.stage === 'Applicant Reply Email'
      ? candidate.pipeline_stage || 'Qualified'
      : normalizedApproval.stage || 'email_sent';
    if (normalizedApproval.stage === 'Applicant Reply Email') {
      updates.reply_sent = true;
    }
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

export async function queueApproval({ candidateId, jobId, messageText, channel, stage, subject, messageType }) {
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
  const normalizedJob = normalizeJobRecord(job);
  if (isConversationEnded(candidate)) {
    await logActivity(jobId, candidateId, 'MESSAGE_SKIPPED', `Skipped ${channel} draft because conversation is ended`, {
      channel,
      stage,
      conversation_ended: true,
    });
    return null;
  }
  const finalMessageText = ['linkedin_dm', 'email'].includes(channel)
    ? ensureSignedMessage(normalizedJob, messageText)
    : messageText;

  try {
    validateDraftMessage(finalMessageText, candidate);
  } catch (error) {
    await logActivity(jobId, candidateId, 'MESSAGE_VALIDATION_FAILED', `Draft blocked for ${channel}: ${error.message}`, {
      channel,
      stage,
    });
    return null;
  }

  const existing = await findExistingApproval(candidateId, channel, stage);
  if (existing) {
    if (existing.status !== 'approved' && existing.message_text !== finalMessageText) {
      const { data: updated } = await supabase.from('approval_queue').update({
        message_text: finalMessageText,
      }).eq('id', existing.id).select('*').single();

      if (updated?.telegram_message_id) {
        await editTelegramMessage(getRecruiterChatId(), updated.telegram_message_id, approvalMessage(candidate, normalizedJob, updated)).catch(() => null);
      }

      await logActivity(jobId, candidateId, 'MESSAGE_DRAFT_UPDATED', `Updated queued ${channel} draft`, {
        approval_id: updated?.id || existing.id,
        stage,
      });
      const pendingApprovalStage = getPendingApprovalPipelineStage(channel);
      if (pendingApprovalStage) {
        await supabase.from('candidates').update({
          pipeline_stage: pendingApprovalStage,
        }).eq('id', candidateId);
      }
      return updated || existing;
    }
    return existing;
  }

  const { data: approval, error } = await supabase.from('approval_queue').insert(await prepareApprovalInsertPayload({
    candidate_id: candidateId,
    job_id: jobId,
    message_text: finalMessageText,
    channel,
    stage,
    subject,
    message_type: messageType || channel,
  })).select('*').single();
  if (error || !approval) return null;
  const normalizedApproval = normalizeApprovalRecord(approval);

  const pendingApprovalStage = getPendingApprovalPipelineStage(channel);
  if (pendingApprovalStage) {
    await supabase.from('candidates').update({
      pipeline_stage: pendingApprovalStage,
    }).eq('id', candidateId);
  }

  try {
    await deliverApprovalTelegramCard(normalizedApproval, candidate, normalizedJob);
  } catch (error) {
    await logActivity(jobId, candidateId, 'TELEGRAM_APPROVAL_NOTIFY_FAILED', `Telegram approval notification failed: ${error.message}`, {
      approval_id: normalizedApproval.id,
      channel,
      stage,
    });
  }

  await logActivity(jobId, candidateId, 'MESSAGE_DRAFTED', `Drafted ${channel} and queued for approval`, {
    approval_id: normalizedApproval.id,
    channel,
    stage,
  });
  return normalizedApproval;
}

export async function resendMissingTelegramApprovalCards(limit = 25) {
  const { data: approvals } = await supabase
    .from('approval_queue')
    .select('*')
    .in('status', ['pending', 'edited', 'approved'])
    .is('telegram_message_id', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  let resent = 0;

  for (const approval of approvals || []) {
    const normalizedApproval = normalizeApprovalRecord(approval);
    // eslint-disable-next-line no-await-in-loop
    const { candidate, job } = await getApprovalContext(normalizedApproval);
    if (!candidate || !job) continue;

    try {
      // eslint-disable-next-line no-await-in-loop
      await deliverApprovalTelegramCard(normalizedApproval, candidate, job);
      resent += 1;
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await logActivity(normalizedApproval.job_id, normalizedApproval.candidate_id, 'TELEGRAM_APPROVAL_NOTIFY_FAILED', `Telegram approval resend failed: ${error.message}`, {
        approval_id: normalizedApproval.id,
        channel: normalizedApproval.channel,
        resend: true,
      });
    }
  }

  return resent;
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

  const approvedPipelineStage = getApprovedPipelineStage(approval.channel, approval.stage);
  if (approvedPipelineStage) {
    await supabase.from('candidates').update({
      pipeline_stage: approvedPipelineStage,
    }).eq('id', approval.candidate_id);
  }

  await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_APPROVED', `Recruiter approved ${approval.channel}`, {
    approval_id: approvalId,
    channel: approval.channel,
  });
  const normalizedUpdated = normalizeApprovalRecord(updated) || approval;
  await syncApprovalTelegramCard(normalizedUpdated);

  const { job } = await getApprovalContext(normalizedUpdated);
  if (job) {
    await executeApprovedSends(job);
  }

  return normalizedUpdated;
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
    const scheduleChannel = normalizedApproval.channel === 'linkedin_dm'
      ? 'linkedin_dm'
      : normalizedApproval.channel === 'email'
        ? 'email'
        : 'default';

    if (!isWithinSendingWindow(job, new Date(), scheduleChannel)) {
      continue;
    }

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

    if (isConversationEnded(candidate)) {
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('approval_queue').update(await prepareApprovalUpdatePayload({
        status: 'rejected',
      })).eq('id', approval.id);
      // eslint-disable-next-line no-await-in-loop
      await syncApprovalTelegramCard({ ...normalizedApproval, status: 'rejected' });
      // eslint-disable-next-line no-await-in-loop
      await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_SKIPPED', 'Approved send skipped because conversation is ended', {
        approval_id: approval.id,
        channel: normalizedApproval.channel,
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
      await syncApprovalTelegramCard({ ...normalizedApproval, status: 'sent', sent_at: new Date().toISOString() });
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
    await editTelegramMessage(
      getRecruiterChatId(),
      normalizedApproval.telegram_message_id,
      approvalMessage(candidate, job, normalizedApproval),
      { reply_markup: approvalReplyMarkup(normalizedApproval.id, normalizedApproval.status, candidate.id) },
    ).catch(() => null);
  }

  await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_DRAFT_UPDATED', `Edited queued ${approval.channel} message`, { approval_id: approvalId });
  return normalizedApproval;
}

export async function skipQueuedMessage(approvalId) {
  const { data: rawExisting } = await supabase.from('approval_queue').select('*').eq('id', approvalId).single();
  const existing = normalizeApprovalRecord(rawExisting);
  if (!existing) return null;

  const { candidate } = await getApprovalContext(existing);
  const { data: approval } = await supabase.from('approval_queue').update(await prepareApprovalUpdatePayload({ status: 'rejected' })).eq('id', approvalId).select('*').single();
  if (!approval) return null;
  const normalizedApproval = normalizeApprovalRecord(approval);
  const rejectedPipelineStage = getRejectedPipelineStage(normalizedApproval, candidate);
  if (rejectedPipelineStage) {
    await supabase.from('candidates').update({
      pipeline_stage: rejectedPipelineStage,
    }).eq('id', normalizedApproval.candidate_id);
  }
  await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_SKIPPED', `Skipped queued ${normalizedApproval.channel} message`, { approval_id: approvalId });
  await syncApprovalTelegramCard(normalizedApproval);
  return normalizedApproval;
}

export async function rejectPendingApprovalsForCandidate(candidateId, reason = 'Conversation ended') {
  const { data: approvals } = await supabase
    .from('approval_queue')
    .select('*')
    .eq('candidate_id', candidateId)
    .in('status', ['pending', 'edited', 'approved']);

  let rejected = 0;
  for (const approval of approvals || []) {
    // eslint-disable-next-line no-await-in-loop
    const { data: updated } = await supabase.from('approval_queue').update(await prepareApprovalUpdatePayload({
      status: 'rejected',
    })).eq('id', approval.id).select('*').single();
    if (!updated) continue;
    rejected += 1;
    // eslint-disable-next-line no-await-in-loop
    await logActivity(updated.job_id, updated.candidate_id, 'MESSAGE_SKIPPED', `${reason}: rejected queued ${updated.channel} approval`, {
      approval_id: updated.id,
      channel: updated.channel,
    });
    // eslint-disable-next-line no-await-in-loop
    await syncApprovalTelegramCard(updated);
  }

  return rejected;
}
