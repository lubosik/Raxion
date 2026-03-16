import supabase from '../db/supabase.js';
import { sendTelegramMessage, editTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { sendConnectionRequest, startLinkedInDM, sendLinkedInDM, sendEmail } from '../integrations/unipile.js';
import { todayIsoDate } from '../lib_utils.js';
import { logActivity } from './activityLogger.js';

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
  return [
    `👤 *${candidate.name || 'Unknown'}* - ${candidate.current_title || 'Unknown title'} at ${candidate.current_company || 'Unknown company'}`,
    `💼 *JOB:* ${job.job_title || job.name} at ${job.client_name || 'Unknown client'}`,
    `📊 Fit Score: ${candidate.fit_score || 0} - ${candidate.fit_grade || 'UNKNOWN'}`,
    `📍 Stage: ${approval.channel} -> ${approval.stage}`,
    `🎯 ${candidate.linkedin_url || 'No LinkedIn URL'}`,
    '',
    '--- MESSAGE ---',
    approval.message_text || '',
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

  return { candidate, job };
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

  return data;
}

async function executeSend(approval, candidate) {
  validateDraftMessage(approval.message_text, candidate);

  if (approval.channel === 'connection_request') {
    if (!candidate.linkedin_provider_id) {
      throw new Error('Missing LinkedIn provider id for connection request');
    }
    return sendConnectionRequest(candidate.linkedin_provider_id, approval.message_text);
  }

  if (approval.channel === 'linkedin_dm') {
    if (!candidate.linkedin_provider_id && !candidate.unipile_chat_id) {
      throw new Error('Missing LinkedIn identifiers for DM');
    }
    if (!candidate.unipile_chat_id) {
      return startLinkedInDM(candidate.linkedin_provider_id, approval.message_text);
    }
    return sendLinkedInDM(candidate.unipile_chat_id, approval.message_text);
  }

  if (approval.channel === 'email') {
    if (!candidate.email) {
      throw new Error('Missing email address for email send');
    }
    return sendEmail(candidate.email, candidate.name, `${candidate.current_title || 'Opportunity'} at ${candidate.current_company || 'Raxion'}`, approval.message_text);
  }

  throw new Error(`Unsupported channel ${approval.channel}`);
}

async function applyStageAfterSend(approval, candidate, result) {
  const updates = {};
  const now = new Date().toISOString();

  if (approval.channel === 'connection_request') {
    updates.pipeline_stage = approval.stage || 'invite_sent';
    updates.invite_sent_at = now;
  } else if (approval.channel === 'linkedin_dm') {
    updates.pipeline_stage = approval.stage || 'dm_sent';
    updates.dm_sent_at = now;
    updates.unipile_chat_id = result?.chat_id || candidate.unipile_chat_id;
    updates.follow_up_due_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  } else if (approval.channel === 'email') {
    updates.pipeline_stage = approval.stage || 'email_sent';
    updates.follow_up_due_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  }

  if (Object.keys(updates).length) {
    await supabase.from('candidates').update(updates).eq('id', candidate.id);
  }

  if (approval.channel !== 'connection_request') {
    await supabase.from('conversations').insert({
      candidate_id: candidate.id,
      job_id: approval.job_id,
      direction: 'outbound',
      channel: approval.channel,
      message_text: approval.message_text,
      unipile_message_id: result?.message_id || null,
    });
  }
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
  if (approval.channel === 'connection_request') updates.invites_sent = (limits.invites_sent || 0) + 1;
  if (approval.channel === 'linkedin_dm') updates.dms_sent = (limits.dms_sent || 0) + 1;
  if (approval.channel === 'email') updates.emails_sent = (limits.emails_sent || 0) + 1;
  if (Object.keys(updates).length) {
    await supabase.from('daily_limits').update(updates).eq('job_id', approval.job_id).eq('date', todayIsoDate());
  }
}

export async function queueApproval({ candidateId, jobId, messageText, channel, stage }) {
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

  const { data: approval, error } = await supabase.from('approval_queue').insert({
    candidate_id: candidateId,
    job_id: jobId,
    message_text: messageText,
    channel,
    stage,
  }).select('*').single();
  if (error || !approval) return null;

  const telegramResponse = await sendTelegramMessage(getRecruiterChatId(), approvalMessage(candidate, job, approval)).catch(() => null);
  if (telegramResponse?.result?.message_id) {
    await supabase.from('approval_queue').update({
      telegram_message_id: String(telegramResponse.result.message_id),
    }).eq('id', approval.id);
  }

  await logActivity(jobId, candidateId, 'MESSAGE_DRAFTED', `Drafted ${channel} and queued for approval`, {
    approval_id: approval.id,
    channel,
    stage,
  });
  return approval;
}

export async function approveQueuedMessage(approvalId) {
  const { data: approval } = await supabase.from('approval_queue').select('*').eq('id', approvalId).single();
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

  const { data: updated } = await supabase.from('approval_queue').update({ status: 'approved' }).eq('id', approvalId).select('*').single();
  await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_APPROVED', `Recruiter approved ${approval.channel}`, {
    approval_id: approvalId,
    channel: approval.channel,
  });
  return updated || approval;
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
    const { candidate } = await getApprovalContext(approval);
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
      const result = await executeSend(approval, candidate);
      if (!result) {
        throw new Error('Unipile send returned no result');
      }
      // eslint-disable-next-line no-await-in-loop
      await applyStageAfterSend(approval, candidate, result);
      // eslint-disable-next-line no-await-in-loop
      await incrementDailyLimit(approval);
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('approval_queue').update({ status: 'sent' }).eq('id', approval.id);
      // eslint-disable-next-line no-await-in-loop
      await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_SENT', `Sent ${approval.channel} via Unipile`, {
        approval_id: approval.id,
        channel: approval.channel,
        sent_at: new Date().toISOString(),
      });
      sentCount += 1;
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('approval_queue').update({ status: 'error' }).eq('id', approval.id);
      // eslint-disable-next-line no-await-in-loop
      await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_SEND_ERROR', `Failed to send ${approval.channel}: ${error.message}`, {
        approval_id: approval.id,
        channel: approval.channel,
      });
    }
  }

  return sentCount;
}

export async function editQueuedMessage(approvalId, messageText) {
  const { data: existing } = await supabase.from('approval_queue').select('*').eq('id', approvalId).single();
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

  const { data: approval } = await supabase.from('approval_queue').update({
    message_text: messageText,
    status: 'edited',
  }).eq('id', approvalId).select('*').single();
  if (!approval) return null;

  if (approval.telegram_message_id) {
    await editTelegramMessage(getRecruiterChatId(), approval.telegram_message_id, approvalMessage(candidate, job, approval)).catch(() => null);
  }

  await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_DRAFT_UPDATED', `Edited queued ${approval.channel} message`, { approval_id: approvalId });
  return approval;
}

export async function skipQueuedMessage(approvalId) {
  const { data: approval } = await supabase.from('approval_queue').update({ status: 'rejected' }).eq('id', approvalId).select('*').single();
  if (!approval) return null;
  await logActivity(approval.job_id, approval.candidate_id, 'MESSAGE_SKIPPED', `Skipped queued ${approval.channel} message`, { approval_id: approvalId });
  return approval;
}
