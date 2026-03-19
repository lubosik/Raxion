import supabase from '../db/supabase.js';
import { callClaude, extractDocumentData } from '../integrations/claude.js';
import { downloadAttachment, getChatMessages, getLinkedInProfile } from '../integrations/unipile.js';
import { searchWeb } from '../integrations/grok.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { syncCandidateToATS } from '../integrations/zohoRecruit.js';
import { isDuplicateApproval, queueApproval } from './approvalService.js';
import { logActivity } from './activityLogger.js';
import { ensureSignedMessage, getAgentGuidanceBlock, getSenderSignature } from './outreachTemplates.js';
import { normalizeConversationRecord, normalizeJobRecord, prepareConversationInsertPayload } from './dbCompat.js';
import {
  clearEndChatRecommendation,
  markConversationEnded,
  markEndChatRecommended,
} from './conversationState.js';

const messageDebounceMap = new Map();
const recentInboundMessageIds = new Map();
const DEBOUNCE_MS = 90 * 1000;
const RECENT_MESSAGE_TTL_MS = 10 * 60 * 1000;

function pruneRecentMessageIds() {
  const now = Date.now();
  for (const [messageId, expiresAt] of recentInboundMessageIds.entries()) {
    if (expiresAt <= now) {
      recentInboundMessageIds.delete(messageId);
    }
  }
}

function rememberRecentMessageId(messageId) {
  if (!messageId) return;
  pruneRecentMessageIds();
  recentInboundMessageIds.set(messageId, Date.now() + RECENT_MESSAGE_TTL_MS);
}

function hasRecentMessageId(messageId) {
  if (!messageId) return false;
  pruneRecentMessageIds();
  const expiresAt = recentInboundMessageIds.get(messageId);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    recentInboundMessageIds.delete(messageId);
    return false;
  }
  return true;
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
  const { data } = await supabase
    .from('conversations')
    .select('*')
    .eq('candidate_id', candidateId)
    .order('sent_at', { ascending: true });
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

function getInboundChannel(payload) {
  return payload.channel || payload.source_channel || 'linkedin_dm';
}

async function findCandidateForPayload(payload) {
  const chatId = payload.chat_id || payload.data?.chat_id || null;
  const senderProviderIds = extractSenderProviderIds(payload);
  const senderEmail = payload.from_attendee?.identifier || payload.sender_email || null;

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
  return candidate || null;
}

function scheduleBatchFlush(candidateId) {
  return setTimeout(() => {
    flushMessageBatch(candidateId).catch((error) => {
      console.error('[REPLY] flushMessageBatch failed', { candidateId, error: error.message });
    });
  }, DEBOUNCE_MS);
}

function addMessageToBatch(candidate, payload) {
  const candidateId = candidate.id;
  const messageId = extractMessageId(payload);
  const messageText = String(payload.text || payload.message_text || payload.data?.text || '').trim();
  const attachments = payload.attachments || payload.data?.attachments || [];
  const timestamp = payload.timestamp || new Date().toISOString();
  const channel = getInboundChannel(payload);
  const chatId = payload.chat_id || payload.data?.chat_id || candidate.unipile_chat_id || null;

  const entry = {
    content: messageText,
    attachments,
    received_at: timestamp,
    channel,
    chatId,
    messageId,
    raw: payload,
  };

  if (messageDebounceMap.has(candidateId)) {
    const existing = messageDebounceMap.get(candidateId);
    if (messageId && existing.messages.some((message) => message.messageId && message.messageId === messageId)) {
      return existing;
    }
    clearTimeout(existing.timer);
    existing.messages.push(entry);
    existing.timer = scheduleBatchFlush(candidateId);
    messageDebounceMap.set(candidateId, existing);
    console.log(`[REPLY] Added message to batch for ${candidate.name} (${existing.messages.length} queued)`);
    return existing;
  }

  const batch = {
    candidate,
    messages: [entry],
    timer: scheduleBatchFlush(candidateId),
  };
  messageDebounceMap.set(candidateId, batch);
  console.log(`[REPLY] Started message batch for ${candidate.name}`);
  return batch;
}

async function storeInboundMessages(candidate, jobId, messages) {
  const messageIds = uniqueNonEmpty(messages.map((message) => message.messageId));
  const existingIds = new Set();

  if (messageIds.length) {
    const { data: existing } = await supabase
      .from('conversations')
      .select('unipile_message_id')
      .in('unipile_message_id', messageIds);
    for (const row of existing || []) {
      if (row.unipile_message_id) existingIds.add(String(row.unipile_message_id));
    }
  }

  for (const message of messages) {
    if (message.messageId && existingIds.has(String(message.messageId))) continue;
    await supabase.from('conversations').insert(await prepareConversationInsertPayload({
      candidate_id: candidate.id,
      job_id: jobId,
      direction: 'inbound',
      channel: message.channel,
      message_text: message.content,
      unipile_message_id: message.messageId,
      sent_at: message.received_at,
      read: false,
    }));
  }
}

async function ingestCvFromMessages(candidate, messages) {
  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      const mime = attachment.mime_type || attachment.mimetype || '';
      if (!/pdf|document|octet-stream/i.test(mime)) continue;
      if (!message.messageId) continue;
      const buffer = await downloadAttachment(message.messageId, attachment.id || attachment.attachment_id);
      if (!buffer) continue;
      const parsedCv = await extractCv(buffer);
      if (!parsedCv) continue;

      const nextCandidate = {
        ...candidate,
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
        notes: `${candidate.notes || ''}\n[CV_RECEIVED]`.trim(),
      };

      await supabase.from('candidates').update({
        name: nextCandidate.name,
        email: nextCandidate.email,
        phone: nextCandidate.phone,
        current_title: nextCandidate.current_title,
        current_company: nextCandidate.current_company,
        years_experience: nextCandidate.years_experience,
        tech_skills: nextCandidate.tech_skills,
        education: nextCandidate.education,
        past_employers: nextCandidate.past_employers,
        cv_text: nextCandidate.cv_text,
        notes: nextCandidate.notes,
      }).eq('id', candidate.id);

      await syncCandidateToATS(nextCandidate);
      await logActivity(candidate.job_id, candidate.id, 'CV_RECEIVED', `${nextCandidate.name} CV received and parsed from inbound reply`, {
        message_id: message.messageId,
      });
      await sendTelegramMessage(getRecruiterChatId(), `📎 ${candidate.name} sent their CV - extracted and synced to ATS`).catch(() => null);
      return { parsedCv, cvText: parsedCv.cv_text || null, candidate: nextCandidate };
    }
  }

  return { parsedCv: null, cvText: null, candidate };
}

function buildConversationContext(history, candidateName) {
  return (history || [])
    .map((message) => `${message.direction === 'inbound' ? candidateName : 'Raxion'}: ${message.message_text}`)
    .join('\n');
}

function buildClassificationFallback() {
  return {
    intent: 'other',
    sentiment: 'neutral',
    key_points: 'Classification failed',
    concerns: '',
    qualified: null,
    qualification_notes: '',
    cv_ingested: false,
    cv_assessment: null,
    messages_to_send: [],
    next_action: 'continue_conversation',
    qualifying_question_to_ask: '',
    should_end_conversation: false,
    end_reason: '',
  };
}

async function fetchCandidateProfileIfNeeded(candidate) {
  if ((candidate.tech_skills || candidate.past_employers) || !candidate.linkedin_provider_id) {
    return null;
  }

  try {
    return await getLinkedInProfile(candidate.linkedin_provider_id);
  } catch (error) {
    console.warn(`[REPLY] Unipile profile fetch failed for ${candidate.name}: ${error.message}`);
    return null;
  }
}

function detectResearchNeeded(candidate, combinedContent) {
  const researchTriggers = [
    'your company',
    'what you do',
    'tell me more about',
    'what is',
    'how does',
    'salary',
    'market',
    'similar roles',
    'other companies',
    'competitors',
    'news',
    'recent',
    'funding',
    'growth',
    'remote',
    'location',
    'visa',
  ];

  const lower = String(combinedContent || '').toLowerCase();
  return Boolean(candidate.current_company) || researchTriggers.some((trigger) => lower.includes(trigger));
}

async function conductMidConversationResearch(candidate, combinedContent, job) {
  if (!detectResearchNeeded(candidate, combinedContent)) {
    return { researchContext: '', used: false };
  }

  const companyQuery = candidate.current_company
    ? `What does ${candidate.current_company} do? What industry are they in, how large are they, and is there any recent notable news? Keep it brief and factual.`
    : null;
  const questionQuery = `In the context of recruiting for ${job.job_title} in ${job.location || 'the target market'}: ${String(combinedContent || '').slice(0, 300)}. Provide 2-3 specific facts that help a recruiter answer accurately and naturally.`;

  const [companyResult, questionResult, profileResult] = await Promise.allSettled([
    companyQuery ? searchWeb(companyQuery) : Promise.resolve(null),
    searchWeb(questionQuery),
    fetchCandidateProfileIfNeeded(candidate),
  ]);

  const blocks = [];
  const companyContext = companyResult.status === 'fulfilled' ? companyResult.value : null;
  const questionContext = questionResult.status === 'fulfilled' ? questionResult.value : null;
  const profileContext = profileResult.status === 'fulfilled' ? profileResult.value : null;

  if (companyContext) blocks.push(`Company context:\n${companyContext}`);
  if (questionContext) blocks.push(`Question context:\n${questionContext}`);
  if (profileContext) {
    blocks.push(`LinkedIn profile context:\n${JSON.stringify({
      headline: profileContext.headline || profileContext.title || null,
      current_company: profileContext.current_company || profileContext.company || null,
      skills: profileContext.skills || null,
      experience: profileContext.experiences || profileContext.experience || null,
    })}`);
  }

  return {
    researchContext: blocks.join('\n\n'),
    used: blocks.length > 0,
  };
}

async function classifyReplyBatch(candidate, job, conversationHistory, combinedContent, messages, cvText, researchContext = '') {
  const qualificationBlock = job.qualified_criteria
    ? `QUALIFICATION CRITERIA:\n${job.qualified_criteria}`
    : 'QUALIFICATION CRITERIA:\nNone specified.';
  const agentGuidance = getAgentGuidanceBlock() || 'None';
  const cvContext = cvText ? `\n\nCV PROVIDED BY CANDIDATE:\n${cvText}` : '';
  const researchBlock = researchContext
    ? `\n\nREAL-TIME RESEARCH (weave in naturally, do not quote verbatim):\n${researchContext}`
    : '';
  const prompt = `You are classifying a candidate reply for the role: ${job.job_title} at ${job.client_name}.

${qualificationBlock}

Recruiter identity: ${getSenderSignature(job)}
Agent guidance:
${agentGuidance}

FULL CONVERSATION SO FAR:
${buildConversationContext(conversationHistory, candidate.name)}

LATEST MESSAGES FROM CANDIDATE (may be multiple sent in sequence):
${combinedContent}${cvContext}${researchBlock}

The candidate sent ${messages.length} message(s). Treat them as one coherent turn.

Return ONLY valid JSON:
{"intent":"interested|not_interested|asking_question|neutral|maybe_later|referral|booking_confirmed|providing_info|other","sentiment":"positive|neutral|negative","key_points":"","concerns":"","qualified":true|false|null,"qualification_notes":"","cv_ingested":true|false,"cv_assessment":"","messages_to_send":[{"reply_to_context":"","body":""}],"next_action":"ask_qualifying_question|push_for_booking|polite_decline|answer_question|acknowledge_cv|continue_conversation|archive","qualifying_question_to_ask":"","should_end_conversation":true|false,"end_reason":""}

Rules:
- If candidate sends multiple messages, treat them as one conversation turn.
- Answer multiple distinct questions in one reply where possible.
- Only create multiple replies if they genuinely need separate responses.
- If a CV was provided, acknowledge it and give brief feedback based on fit.
- Keep each reply conversational, first name only, no em dashes, sign off with the exact recruiter signature.
- Never repeat yourself across multiple replies in the same turn.`;

  return callClaude(
    prompt,
    'You are a recruiting conversation classifier. Follow the role-specific qualification criteria and return valid JSON only.',
    { expectJson: true, maxTokens: 1000 },
  ).catch(() => buildClassificationFallback());
}

async function queueRepliesFromClassification(candidate, job, channel, classification, combinedContent) {
  const outboundChannel = channel === 'email' ? 'email' : 'linkedin_dm';
  const messageType = channel === 'email' ? 'email_reply' : 'linkedin_dm';
  const repliesToSend = Array.isArray(classification.messages_to_send)
    ? classification.messages_to_send.filter((message) => String(message?.body || '').trim())
    : [];

  if (!repliesToSend.length && classification.next_action === 'push_for_booking') {
    repliesToSend.push({
      reply_to_context: 'Booking follow-up',
      body: job?.calendly_link
        ? `Thanks for the reply. You can book a time here: ${job.calendly_link}`
        : 'Thanks for the reply. Happy to share more and line up a call if useful.',
    });
  }

  if (!repliesToSend.length && classification.next_action === 'ask_qualifying_question' && classification.qualifying_question_to_ask) {
    repliesToSend.push({
      reply_to_context: 'Qualification follow-up',
      body: classification.qualifying_question_to_ask,
    });
  }

  if (!repliesToSend.length) {
    return 0;
  }

  if (await isDuplicateApproval(candidate.id, messageType)) {
    await logActivity(job.id, candidate.id, 'DUPLICATE_SUPPRESSED', `[${job.job_title}]: Duplicate reply notification suppressed for ${candidate.name}`, {
      channel: outboundChannel,
      message_type: messageType,
      combined_content: combinedContent,
    });
    return 0;
  }

  let queuedCount = 0;
  for (let index = 0; index < repliesToSend.length; index += 1) {
    const reply = repliesToSend[index];
    const body = ensureSignedMessage(job, reply.body || '');
    const contextLabel = repliesToSend.length > 1
      ? `Reply ${index + 1}/${repliesToSend.length} - ${reply.reply_to_context || 'Follow-up'}`
      : (reply.reply_to_context || null);
    const stage = classification.next_action === 'archive' || classification.next_action === 'polite_decline'
      ? 'Archived'
      : 'in_conversation';

    const queued = await queueApproval({
      candidateId: candidate.id,
      jobId: candidate.job_id,
      channel: outboundChannel,
      stage,
      messageText: body,
      messageType,
      contextLabel,
      allowMultiple: repliesToSend.length > 1,
    });

    if (!queued) continue;
    queuedCount += 1;
    await logActivity(job.id, candidate.id, 'REPLY_QUEUED', `[${job.job_title}]: Reply drafted for ${candidate.name} (${candidate.current_title || 'unknown title'} at ${candidate.current_company || 'unknown company'})${contextLabel ? ` (${contextLabel})` : ''} - awaiting approval`, {
      approval_id: queued.id,
      channel: outboundChannel,
      message_type: messageType,
    });
  }

  return queuedCount;
}

async function processBatchedMessages(candidate, messages) {
  const { data: rawJob } = await supabase.from('jobs').select('*').eq('id', candidate.job_id).single();
  const job = normalizeJobRecord(rawJob);
  if (!job) return null;

  const combinedContent = messages
    .map((message) => message.content)
    .filter(Boolean)
    .join('\n\n')
    .trim();
  const channel = messages[0]?.channel || 'linkedin_dm';

  await storeInboundMessages(candidate, job.id, messages);

  const nextPipelineStage = ['Interview Booked', 'Interview Scheduled', 'Offered', 'Placed'].includes(candidate.pipeline_stage)
    ? candidate.pipeline_stage
    : 'reply_received';
  await supabase.from('candidates').update({
    last_reply_at: new Date().toISOString(),
    pipeline_stage: nextPipelineStage,
  }).eq('id', candidate.id);

  const cvResult = await ingestCvFromMessages(candidate, messages);
  const currentCandidate = cvResult.candidate || candidate;

  const [conversationHistory, remoteConversationHistory] = await Promise.all([
    getConversationHistory(candidate.id),
    getRemoteConversationHistory(messages[0]?.chatId || candidate.unipile_chat_id),
  ]);
  const fullConversationHistory = conversationHistory.length ? conversationHistory : remoteConversationHistory;
  const { researchContext, used: researchUsed } = await conductMidConversationResearch(currentCandidate, combinedContent, job);
  const classification = await classifyReplyBatch(
    currentCandidate,
    job,
    fullConversationHistory,
    combinedContent,
    messages,
    cvResult.cvText,
    researchContext,
  );

  const archiveReason = classification.end_reason || classification.concerns || 'Archived after reply classification';
  const shouldQueueArchiveReply = classification.next_action === 'archive'
    && Array.isArray(classification.messages_to_send)
    && classification.messages_to_send.some((message) => String(message?.body || '').trim());

  if (classification.intent === 'booking_confirmed') {
    await supabase.from('candidates').update({
      pipeline_stage: 'Interview Booked',
      interview_booked_at: new Date().toISOString(),
      ...markConversationEnded(currentCandidate, classification.end_reason || 'Meeting booked', { archive: false }),
    }).eq('id', candidate.id);
    await logActivity(candidate.job_id, candidate.id, 'CHAT_ENDED', `${currentCandidate.name} conversation ended after booking confirmation`, {
      reason: classification.end_reason || 'Meeting booked',
      automatic: true,
    });
  } else if (classification.next_action === 'archive' && !shouldQueueArchiveReply) {
    await supabase.from('candidates').update(markConversationEnded(
      currentCandidate,
      archiveReason,
      { archive: true },
    )).eq('id', candidate.id);
    await logActivity(candidate.job_id, candidate.id, 'CHAT_ENDED', `${currentCandidate.name} conversation ended and archived`, {
      reason: archiveReason,
      automatic: true,
    });
  } else if (classification.next_action === 'archive' && shouldQueueArchiveReply) {
    await supabase.from('candidates').update({
      pipeline_stage: 'reply_received',
      follow_up_due_at: null,
      ...clearEndChatRecommendation(currentCandidate),
    }).eq('id', candidate.id);
    await logActivity(candidate.job_id, candidate.id, 'CHAT_END_RECOMMENDED', `${currentCandidate.name} close-out reply queued before archive`, {
      reason: archiveReason,
      intent: classification.intent,
      final_reply_pending: true,
    });
  } else if (classification.should_end_conversation) {
    const recommendation = classification.end_reason || classification.key_points || classification.concerns || 'Conversation appears complete';
    await supabase.from('candidates').update(markEndChatRecommended(currentCandidate, recommendation)).eq('id', candidate.id);
    await logActivity(candidate.job_id, candidate.id, 'CHAT_END_RECOMMENDED', `${currentCandidate.name} conversation looks ready to end`, {
      reason: recommendation,
      intent: classification.intent,
    });
    await sendTelegramMessage(getRecruiterChatId(), `🧭 End chat recommended for ${currentCandidate.name}: ${recommendation}`).catch(() => null);
  } else {
    await supabase.from('candidates').update(clearEndChatRecommendation(currentCandidate)).eq('id', candidate.id);
  }

  if (classification.qualified && classification.intent !== 'booking_confirmed') {
    await supabase.from('candidates').update({
      pipeline_stage: 'Qualified',
      qualified_at: new Date().toISOString(),
    }).eq('id', candidate.id);
    await logActivity(candidate.job_id, candidate.id, 'CANDIDATE_QUALIFIED', `${currentCandidate.name} qualified from reply`, {
      intent: classification.intent,
      next_action: classification.next_action,
      qualification_notes: classification.qualification_notes,
    });
    await sendTelegramMessage(
      getRecruiterChatId(),
      `⭐ ${currentCandidate.name} is QUALIFIED for ${job.job_title}\n\nNotes: ${classification.qualification_notes || 'Qualified from reply.'}${cvResult.cvText ? '\n📄 CV received and assessed' : ''}`,
    ).catch(() => null);
  }

  const queuedReplies = await queueRepliesFromClassification(currentCandidate, job, channel, classification, combinedContent);
  if (!queuedReplies) {
    await logActivity(candidate.job_id, candidate.id, 'REPLY_NO_ACTION', `[${job.job_title}]: ${currentCandidate.name} replied - no response needed (${classification.intent})`, {
      intent: classification.intent,
      message_count: messages.length,
    });
  }

  if (researchUsed) {
    await logActivity(candidate.job_id, candidate.id, 'MID_CONVERSATION_RESEARCH', `[${job.job_title}]: Research conducted for reply to ${currentCandidate.name} (${currentCandidate.current_title || 'unknown title'} at ${currentCandidate.current_company || 'unknown company'})`, {
      research_used: true,
      candidate_company: currentCandidate.current_company || null,
    });
  }

  await logActivity(candidate.job_id, candidate.id, 'REPLY_RECEIVED', `[${job.job_title}]: ${currentCandidate.name} replied on ${channel} (${currentCandidate.current_title || 'unknown title'} at ${currentCandidate.current_company || 'unknown company'})`, {
    classification,
    combined_content: combinedContent,
    message_count: messages.length,
    conversation_messages: fullConversationHistory.length,
    research_used: researchUsed,
  });

  return classification;
}

async function flushMessageBatch(candidateId) {
  const batch = messageDebounceMap.get(candidateId);
  messageDebounceMap.delete(candidateId);
  if (!batch?.messages?.length) return null;

  console.log(`[REPLY] Processing ${batch.messages.length} batched message(s) from ${batch.candidate.name}`);
  return processBatchedMessages(batch.candidate, batch.messages);
}

export async function processIncomingMessage(webhookPayload) {
  const messageText = String(webhookPayload.text || webhookPayload.message_text || webhookPayload.data?.text || '').trim();
  const attachments = webhookPayload.attachments || webhookPayload.data?.attachments || [];
  const messageId = extractMessageId(webhookPayload);

  if (!messageText && !attachments.length) {
    return null;
  }

  if (messageId) {
    if (hasRecentMessageId(messageId)) {
      return null;
    }
    const { data: existingConversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('unipile_message_id', messageId)
      .limit(1)
      .maybeSingle();
    if (existingConversation) {
      rememberRecentMessageId(messageId);
      return null;
    }
  }

  const candidate = await findCandidateForPayload(webhookPayload);
  if (!candidate) {
    console.warn('[replyHandler] unknown incoming message', {
      chatId: webhookPayload.chat_id || webhookPayload.data?.chat_id || null,
      senderProviderIds: extractSenderProviderIds(webhookPayload),
      senderEmail: webhookPayload.from_attendee?.identifier || webhookPayload.sender_email || null,
      messageId,
    });
    return null;
  }

  rememberRecentMessageId(messageId);
  addMessageToBatch(candidate, webhookPayload);
  return { batched: true, candidateId: candidate.id };
}
