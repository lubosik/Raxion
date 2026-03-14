import supabase from '../db/supabase.js';
import { sendTelegramMessage, editTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { sendConnectionRequest, startLinkedInDM, sendLinkedInDM, sendEmail } from '../integrations/unipile.js';
import { logActivity } from './activityLogger.js';

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

export async function queueApproval({ candidateId, jobId, messageText, channel, stage }) {
  const [{ data: candidate, error: candidateError }, { data: job, error: jobError }] = await Promise.all([
    supabase.from('candidates').select('*').eq('id', candidateId).single(),
    supabase.from('jobs').select('*').eq('id', jobId).single(),
  ]);
  if (candidateError || jobError) return null;

  const { data: approval, error } = await supabase.from('approval_queue').insert({
    candidate_id: candidateId,
    job_id: jobId,
    message_text: messageText,
    channel,
    stage,
  }).select('*').single();
  if (error) return null;

  const telegramResponse = await sendTelegramMessage(getRecruiterChatId(), approvalMessage(candidate, job, approval)).catch(() => null);
  if (telegramResponse?.result?.message_id) {
    await supabase.from('approval_queue').update({
      telegram_message_id: String(telegramResponse.result.message_id),
    }).eq('id', approval.id);
  }

  await logActivity(jobId, candidateId, 'APPROVAL_QUEUED', `Queued ${channel} message for approval`, { approval_id: approval.id, stage });
  return approval;
}

async function executeSend(approval, candidate) {
  if (approval.channel === 'connection_request') {
    return sendConnectionRequest(candidate.linkedin_provider_id, approval.message_text);
  }

  if (approval.channel === 'linkedin_dm') {
    if (!candidate.unipile_chat_id) {
      return startLinkedInDM(candidate.linkedin_provider_id, approval.message_text);
    }
    return sendLinkedInDM(candidate.unipile_chat_id, approval.message_text);
  }

  if (approval.channel === 'email') {
    return sendEmail(candidate.email, candidate.name, `${candidate.current_title || 'Opportunity'} at ${candidate.current_company || 'Raxion'}`, approval.message_text);
  }

  return null;
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

export async function approveQueuedMessage(approvalId) {
  const { data: approval } = await supabase.from('approval_queue').select('*').eq('id', approvalId).single();
  if (!approval || !['pending', 'edited'].includes(approval.status)) return null;

  const { data: candidate } = await supabase.from('candidates').select('*').eq('id', approval.candidate_id).single();
  if (!candidate) return null;

  const result = await executeSend(approval, candidate);
  if (!result) return null;

  await applyStageAfterSend(approval, candidate, result);
  await supabase.from('approval_queue').update({ status: 'approved' }).eq('id', approvalId);
  const today = new Date().toISOString().slice(0, 10);
  const { data: limits } = await supabase.from('daily_limits').upsert({ job_id: approval.job_id, date: today }, { onConflict: 'job_id,date' }).select('*').single();
  if (limits) {
    const updates = {};
    if (approval.channel === 'connection_request') updates.invites_sent = (limits.invites_sent || 0) + 1;
    if (approval.channel === 'linkedin_dm') updates.dms_sent = (limits.dms_sent || 0) + 1;
    if (approval.channel === 'email') updates.emails_sent = (limits.emails_sent || 0) + 1;
    if (Object.keys(updates).length) {
      await supabase.from('daily_limits').update(updates).eq('job_id', approval.job_id).eq('date', today);
    }
  }
  await logActivity(approval.job_id, approval.candidate_id, 'APPROVAL_APPROVED', `Approved and sent ${approval.channel}`, { approval_id: approvalId });
  return result;
}

export async function editQueuedMessage(approvalId, messageText) {
  const { data: approval } = await supabase.from('approval_queue').update({
    message_text: messageText,
    status: 'edited',
  }).eq('id', approvalId).select('*').single();
  if (!approval) return null;

  const [{ data: candidate }, { data: job }] = await Promise.all([
    supabase.from('candidates').select('*').eq('id', approval.candidate_id).single(),
    supabase.from('jobs').select('*').eq('id', approval.job_id).single(),
  ]);

  if (approval.telegram_message_id) {
    await editTelegramMessage(getRecruiterChatId(), approval.telegram_message_id, approvalMessage(candidate, job, approval)).catch(() => null);
  }

  await logActivity(approval.job_id, approval.candidate_id, 'APPROVAL_EDITED', `Edited queued ${approval.channel} message`, { approval_id: approvalId });
  return approval;
}

export async function skipQueuedMessage(approvalId) {
  const { data: approval } = await supabase.from('approval_queue').update({ status: 'rejected' }).eq('id', approvalId).select('*').single();
  if (!approval) return null;
  await logActivity(approval.job_id, approval.candidate_id, 'APPROVAL_SKIPPED', `Skipped queued ${approval.channel} message`, { approval_id: approvalId });
  return approval;
}
