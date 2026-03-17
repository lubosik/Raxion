import express from 'express';
import supabase from '../db/supabase.js';
import { processIncomingMessage } from '../services/replyHandler.js';
import { logActivity } from '../services/activityLogger.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';
import { getRuntimeConfigValue } from '../services/configService.js';

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
      const linkedinAccountId = getRuntimeConfigValue('UNIPILE_LINKEDIN_ACCOUNT_ID');
      if (payload.account_id && payload.account_id !== linkedinAccountId) return;
      const senderId = payload.sender?.attendee_provider_id || payload.sender?.provider_id || null;
      const ownUserId = payload.account_info?.user_id || null;
      if (senderId && ownUserId && senderId === ownUserId) return;
      await processIncomingMessage(normaliseMessagingPayload(payload)).catch((error) => {
        console.error('[webhooks.messages] processing failed', error);
      });
      return;
    }

    if (payload.event === 'mail_received') {
      const emailAccountId = getRuntimeConfigValue('UNIPILE_EMAIL_ACCOUNT_ID');
      if (payload.account_id && emailAccountId && payload.account_id !== emailAccountId) return;
      const fromEmail = payload.from_attendee?.identifier || null;
      const ownReplyEmail = getRuntimeConfigValue('REPLY_TO_EMAIL') || null;
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
    const providerId = payload.account_member_id || payload.attendee_provider_id || payload.provider_id || payload.user_provider_id || payload.user?.provider_id || payload.user?.attendee_provider_id || null;
    if (!providerId) {
      console.log('[WEBHOOK] new_relation: no provider ID - ignoring');
      return;
    }

    const { data: candidate } = await supabase
      .from('candidates')
      .select('*, jobs!inner(*)')
      .eq('linkedin_provider_id', providerId)
      .in('pipeline_stage', ['invite_sent', 'Shortlisted', 'Enriched'])
      .eq('jobs.status', 'ACTIVE')
      .limit(1)
      .maybeSingle();

    if (!candidate) {
      console.log(`[WEBHOOK] LinkedIn ID ${providerId} not found in any active pipeline - ignoring`);
      return;
    }

    if (!candidate.name || candidate.name.toLowerCase() === 'null') {
      console.log(`[WEBHOOK] Candidate ${candidate.id} has no valid name - ignoring`);
      return;
    }

    await supabase.from('candidates').update({
      pipeline_stage: 'invite_accepted',
      invite_accepted_at: new Date().toISOString(),
    }).eq('id', candidate.id);
    await logActivity(candidate.job_id, candidate.id, 'INVITE_ACCEPTED', `${candidate.name} accepted connection request`, payload);
    await sendTelegramMessage(getRecruiterChatId(), `🤝 Connection accepted: ${candidate.name} at ${candidate.current_company || 'unknown firm'} - queued for DM draft`).catch(() => null);
  });

  return router;
}
