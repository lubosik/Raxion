import express from 'express';
import supabase from '../db/supabase.js';
import { processIncomingMessage } from '../services/replyHandler.js';
import { logActivity } from '../services/activityLogger.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';

export function createUnipileWebhookRouter() {
  const router = express.Router();

  function logWebhook(eventType, payload) {
    return supabase.from('webhook_logs').insert({
      event_type: eventType || 'unknown',
      payload,
    });
  }

  function normaliseMessagingPayload(payload) {
    return {
      ...payload,
      text: payload.message || payload.text || payload.body || '',
      sender: payload.sender,
      attachments: payload.attachments || [],
      source_channel: 'linkedin_dm',
    };
  }

  function normaliseEmailPayload(payload) {
    return {
      ...payload,
      text: payload.body_plain || payload.body || '',
      sender_email: payload.from_attendee?.identifier || null,
      attachments: payload.attachments || [],
      timestamp: payload.date || payload.timestamp,
      source_channel: 'email',
    };
  }

  router.post('/messages', async (req, res) => {
    const payload = req.body || {};
    res.status(200).json({ ok: true });

    try {
      await logWebhook(payload.event, payload);
    } catch (error) {
      console.error('[webhooks.messages] failed to log payload', error.message);
    }

    if (payload.event === 'message_received') {
      if (payload.account_id && payload.account_id !== process.env.UNIPILE_LINKEDIN_ACCOUNT_ID) return;
      const senderId = payload.sender?.attendee_provider_id || payload.sender?.provider_id || null;
      const ownUserId = payload.account_info?.user_id || null;
      if (senderId && ownUserId && senderId === ownUserId) return;
      await processIncomingMessage(normaliseMessagingPayload(payload)).catch((error) => {
        console.error('[webhooks.messages] processing failed', error);
      });
      return;
    }

    if (payload.event === 'mail_received') {
      if (payload.account_id && process.env.UNIPILE_EMAIL_ACCOUNT_ID && payload.account_id !== process.env.UNIPILE_EMAIL_ACCOUNT_ID) return;
      const fromEmail = payload.from_attendee?.identifier || null;
      const ownReplyEmail = process.env.REPLY_TO_EMAIL || null;
      if (ownReplyEmail && fromEmail && fromEmail.toLowerCase() === ownReplyEmail.toLowerCase()) return;
      await processIncomingMessage(normaliseEmailPayload(payload)).catch((error) => {
        console.error('[webhooks.email] processing failed', error);
      });
    }
  });

  router.post('/relations', async (req, res) => {
    const payload = req.body || {};
    res.status(200).json({ ok: true });

    try {
      await logWebhook(payload.event, payload);
    } catch (error) {
      console.error('[webhooks.relations] failed to log payload', error.message);
    }

    if (payload.event !== 'new_relation') return;
    const providerId = payload.user_provider_id || payload.user?.provider_id || payload.user?.attendee_provider_id || null;
    const { data: candidate, error } = await supabase.from('candidates').select('*').eq('linkedin_provider_id', providerId).single();
    if (error) return;
    if (!candidate) return;

    await supabase.from('candidates').update({
      pipeline_stage: 'invite_accepted',
      invite_accepted_at: new Date().toISOString(),
    }).eq('id', candidate.id);
    const { data: job } = await supabase.from('jobs').select('job_title').eq('id', candidate.job_id).single();
    await logActivity(candidate.job_id, candidate.id, 'INVITE_ACCEPTED', `${candidate.name} accepted your connection request`, payload);
    await sendTelegramMessage(getRecruiterChatId(), `🤝 ${candidate.name} accepted your connection request for ${job?.job_title || 'job ' + candidate.job_id}`).catch(() => null);
  });

  return router;
}
