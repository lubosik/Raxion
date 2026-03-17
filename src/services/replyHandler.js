import supabase from '../db/supabase.js';
import { callClaude, extractDocumentData } from '../integrations/claude.js';
import { downloadAttachment, getChatMessages } from '../integrations/unipile.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { syncCandidateToATS } from '../integrations/zohoRecruit.js';
import { queueApproval } from './approvalService.js';
import { logActivity } from './activityLogger.js';
import { ensureSignedMessage, getSenderSignature } from './outreachTemplates.js';
import { normalizeConversationRecord, normalizeJobRecord, prepareConversationInsertPayload } from './dbCompat.js';

async function classifyReply(candidate, job, conversationHistory, messageText) {
  return callClaude(
    `Classify this recruiting reply and return JSON.\nCandidate: ${JSON.stringify(candidate)}\nJob: ${JSON.stringify(job)}\nRecruiter identity: ${getSenderSignature(job)}\nConversation history: ${JSON.stringify(conversationHistory)}\nNew message: ${messageText}\nIf you provide suggested_reply, write it in the recruiter's voice, keep it consistent with the conversation history, and end it with the exact recruiter signature.\nReturn {"intent":"interested|not_interested|maybe_later|question|referral|booking_confirmed|other","sentiment":"positive|neutral|negative","key_points":"","concerns":"","qualified":true/false,"next_action":"send_booking_link|answer_question|escalate|archive|continue_conversation","suggested_reply":""}.`,
    'You are a recruiting conversation classifier. Return valid JSON only.',
    { expectJson: true },
  ).catch(() => ({
    intent: 'other',
    sentiment: 'neutral',
    key_points: 'Classification failed',
    concerns: '',
    qualified: false,
    next_action: 'escalate',
    suggested_reply: '',
  }));
}

async function extractCv(buffer) {
  return extractDocumentData(
    buffer.toString('base64'),
    'application/pdf',
    'Extract candidate data from this CV. Return JSON {"name":"","email":"","phone":"","current_title":"","current_company":"","years_experience":0,"tech_skills":"","education":"","past_employers":"","cv_text":""}.',
    'You extract structured CV data for recruiting systems. Return valid JSON only.',
    { expectJson: true, maxTokens: 1000 },
  ).catch(() => null);
}

async function getConversationHistory(candidateId) {
  const { data } = await supabase.from('conversations').select('*').eq('candidate_id', candidateId).order('sent_at', { ascending: true });
  return (data || []).map(normalizeConversationRecord);
}

async function getRemoteConversationHistory(chatId) {
  if (!chatId) return [];
  const messages = await getChatMessages(chatId);
  return (messages || []).map((message) => ({
    direction: message.is_sender ? 'outbound' : 'inbound',
    channel: 'linkedin_dm',
    message_text: message.text || message.original || '',
    sent_at: message.timestamp || null,
  }));
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function extractSenderProviderIds(payload) {
  return uniqueNonEmpty([
    payload.sender?.attendee_provider_id,
    payload.sender?.provider_id,
    payload.attendee_provider_id,
    payload.sender_id,
    ...(payload.attendees || []).map((attendee) => attendee?.attendee_provider_id || attendee?.provider_id),
  ]);
}

function extractMessageId(payload) {
  return payload.message_id || payload.data?.message_id || payload.provider_message_id || payload.id || payload.provider_id || null;
}

export async function processIncomingMessage(webhookPayload) {
  const chatId = webhookPayload.chat_id || webhookPayload.data?.chat_id || null;
  const senderProviderIds = extractSenderProviderIds(webhookPayload);
  const senderEmail = webhookPayload.from_attendee?.identifier || webhookPayload.sender_email || null;
  const messageText = webhookPayload.text || webhookPayload.message_text || webhookPayload.data?.text || '';
  const attachments = webhookPayload.attachments || webhookPayload.data?.attachments || [];
  const timestamp = webhookPayload.timestamp || new Date().toISOString();
  const messageId = extractMessageId(webhookPayload);
  const channel = webhookPayload.channel || webhookPayload.source_channel || 'linkedin_dm';

  if (!messageText.trim() && !attachments.length) {
    return null;
  }

  if (messageId) {
    const { data: existingConversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('unipile_message_id', messageId)
      .limit(1)
      .maybeSingle();
    if (existingConversation) {
      return null;
    }
  }

  let candidateQuery = supabase
    .from('candidates')
    .select('*')
    .limit(1);

  if (chatId || senderProviderIds.length || senderEmail) {
    const filters = [];
    if (chatId) filters.push(`unipile_chat_id.eq.${chatId}`);
    for (const senderProviderId of senderProviderIds) {
      filters.push(`linkedin_provider_id.eq.${senderProviderId}`);
    }
    if (senderEmail) filters.push(`email.eq.${senderEmail}`);
    if (filters.length) {
      candidateQuery = candidateQuery.or(filters.join(','));
    }
  }

  const { data: candidate } = await candidateQuery.maybeSingle();

  if (!candidate) {
    console.warn('[replyHandler] unknown incoming message', { chatId, senderProviderIds, senderEmail, messageId });
    return null;
  }

  const { data: rawJob } = await supabase.from('jobs').select('*').eq('id', candidate.job_id).single();
  const job = normalizeJobRecord(rawJob);
  const [conversationHistory, remoteConversationHistory] = await Promise.all([
    getConversationHistory(candidate.id),
    getRemoteConversationHistory(chatId || candidate.unipile_chat_id),
  ]);
  const fullConversationHistory = remoteConversationHistory.length ? remoteConversationHistory : conversationHistory;

  await supabase.from('conversations').insert(await prepareConversationInsertPayload({
    candidate_id: candidate.id,
    job_id: candidate.job_id,
    direction: 'inbound',
    channel,
    message_text: messageText,
    unipile_message_id: messageId,
    sent_at: timestamp,
    read: false,
  }));

  await supabase.from('candidates').update({
    last_reply_at: new Date().toISOString(),
    pipeline_stage: ['Qualified', 'Interview Booked', 'Interview Scheduled', 'Offered', 'Placed'].includes(candidate.pipeline_stage) ? candidate.pipeline_stage : 'Replied',
  }).eq('id', candidate.id);

  for (const attachment of attachments) {
    const mime = attachment.mime_type || attachment.mimetype || '';
    if (!/pdf|document|octet-stream/i.test(mime)) continue;
    // eslint-disable-next-line no-await-in-loop
    const buffer = await downloadAttachment(messageId, attachment.id || attachment.attachment_id);
    if (!buffer) continue;
    // eslint-disable-next-line no-await-in-loop
    const parsedCv = await extractCv(buffer);
    if (!parsedCv) continue;

    const nextNotes = `${candidate.notes || ''}\n[CV_RECEIVED]`.trim();
    // eslint-disable-next-line no-await-in-loop
    await supabase.from('candidates').update({
      name: parsedCv.name || candidate.name,
      email: parsedCv.email || candidate.email,
      phone: parsedCv.phone || candidate.phone,
      current_title: parsedCv.current_title || candidate.current_title,
      current_company: parsedCv.current_company || candidate.current_company,
      years_experience: parsedCv.years_experience || candidate.years_experience,
      tech_skills: parsedCv.tech_skills || candidate.tech_skills,
      education: parsedCv.education || candidate.education,
      past_employers: parsedCv.past_employers || candidate.past_employers,
      cv_text: parsedCv.cv_text || null,
      notes: nextNotes,
    }).eq('id', candidate.id);
    // eslint-disable-next-line no-await-in-loop
    await syncCandidateToATS({ ...candidate, ...parsedCv, cv_text: parsedCv.cv_text });
    // eslint-disable-next-line no-await-in-loop
    await sendTelegramMessage(getRecruiterChatId(), `📎 ${candidate.name} sent their CV - extracted and synced to ATS`).catch(() => null);
  }

  const classification = await classifyReply(candidate, job, fullConversationHistory, messageText);

  if (classification.qualified) {
    await supabase.from('candidates').update({
      pipeline_stage: 'Qualified',
      qualified_at: new Date().toISOString(),
    }).eq('id', candidate.id);
    await logActivity(candidate.job_id, candidate.id, 'CANDIDATE_QUALIFIED', `${candidate.name} qualified from reply`, {
      intent: classification.intent,
      reason: classification.reason,
      next_action: classification.next_action,
    });
    await sendTelegramMessage(getRecruiterChatId(), `⭐ ${candidate.name} is QUALIFIED for ${job.job_title} - booking message queued for your approval`).catch(() => null);
  }

  if (classification.next_action === 'send_booking_link' && job?.calendly_link) {
    await queueApproval({
      candidateId: candidate.id,
      jobId: candidate.job_id,
      channel: 'linkedin_dm',
      stage: 'Qualified',
      messageText: ensureSignedMessage(job, `Thanks for the reply. You can book a time here: ${job.calendly_link}`),
    });
  } else if (classification.next_action === 'answer_question' || classification.next_action === 'continue_conversation') {
    await queueApproval({
      candidateId: candidate.id,
      jobId: candidate.job_id,
      channel: 'linkedin_dm',
      stage: candidate.pipeline_stage,
      messageText: ensureSignedMessage(job, classification.suggested_reply),
    });
  } else if (classification.next_action === 'archive') {
    await supabase.from('candidates').update({
      pipeline_stage: 'Archived',
      notes: `${candidate.notes || ''}\n${classification.concerns || 'Archived after reply classification'}`.trim(),
    }).eq('id', candidate.id);
    await logActivity(candidate.job_id, candidate.id, 'CANDIDATE_ARCHIVED', `${candidate.name} archived after reply`, {
      intent: classification.intent,
      concerns: classification.concerns,
    });
  } else if (classification.next_action === 'escalate') {
    await sendTelegramMessage(getRecruiterChatId(), `💬 ${candidate.name} replied and needs manual recruiter handling for ${job.job_title}`).catch(() => null);
  }

  await logActivity(candidate.job_id, candidate.id, 'REPLY_RECEIVED', `${candidate.name} replied on LinkedIn`, {
    classification,
    message_text: messageText,
    conversation_messages: fullConversationHistory.length,
  });

  await sendTelegramMessage(getRecruiterChatId(), `💬 ${candidate.name} replied to your ${channel} - staging for qualification`).catch(() => null);
  return classification;
}
