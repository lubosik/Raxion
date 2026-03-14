import crypto from 'node:crypto';
import express from 'express';
import supabase from '../db/supabase.js';
import { triggerConnectedCandidateStep } from '../services/outreachSequencer.js';
import { handleIncomingReply } from '../services/replyHandler.js';
import { continueQualification } from '../services/qualificationEngine.js';
import { processInboundMessage } from '../inboxMonitor.js';
import { logError } from '../lib_errors.js';

function verifySignature(rawBody, signature) {
  const secret = process.env.UNIPILE_WEBHOOK_SECRET;
  if (!secret) return true;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return signature === digest || signature === `sha256=${digest}`;
}

async function findCandidateFromPayload(payload) {
  const providerId = payload.provider_id || payload.sender?.provider_id || payload.data?.provider_id;
  const email = payload.sender?.email || payload.email || payload.data?.email;

  let query = supabase.from('candidates').select('*');
  if (providerId) {
    const { data } = await query.eq('provider_id', providerId).limit(1);
    if (data?.[0]) return data[0];
  }
  if (email) {
    const { data } = await supabase.from('candidates').select('*').eq('email', email).limit(1);
    if (data?.[0]) return data[0];
  }
  return null;
}

export function createUnipileWebhookRouter() {
  const router = express.Router();

  router.post('/webhooks/unipile', async (req, res) => {
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const signature = req.headers['x-unipile-signature'] || req.headers['x-signature'];

    try {
      if (!verifySignature(rawBody, signature)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const payload = req.body || {};
      const eventType = payload.event_type || payload.type || payload.event || 'unknown';
      await supabase.from('webhook_log').insert({ event_type: eventType, payload });

      if (eventType === 'invitation_accepted') {
        const candidate = await findCandidateFromPayload(payload);
        if (candidate) {
          await supabase.from('candidates').update({ status: 'connected' }).eq('id', candidate.id);
          await triggerConnectedCandidateStep(candidate.id);
        }
      } else if (eventType === 'new_message') {
        const candidate = await findCandidateFromPayload(payload);
        const text = payload.message_text || payload.text || payload.body || '';
        const conversationId = payload.conversation_id || payload.chat_id || payload.sender?.provider_id;
        if (candidate) {
          if (candidate.status === 'qualifying') {
            await continueQualification(candidate.id, conversationId, text);
          } else {
            await handleIncomingReply(candidate.id, text, conversationId);
          }
        } else {
          await processInboundMessage({
            source: payload.channel || 'unipile',
            sender_name: payload.sender?.name || payload.from?.name || null,
            sender_email: payload.sender?.email || payload.from?.email || null,
            sender_linkedin_url: payload.sender?.linkedin_url || null,
            provider_id: payload.sender?.provider_id || null,
            message_text: text,
          });
        }
      } else if (eventType === 'invitation_declined') {
        const candidate = await findCandidateFromPayload(payload);
        if (candidate) {
          await supabase.from('candidates').update({ status: 'invite_declined' }).eq('id', candidate.id);
          await supabase.from('outreach_log').insert({
            candidate_id: candidate.id,
            job_brief_id: candidate.job_brief_id,
            channel: 'linkedin_invite',
            message_text: 'invitation_declined',
            step_number: 1,
            delivered: true,
          });
        }
      }

      return res.json({ ok: true });
    } catch (error) {
      await logError('webhooks.unipile', error, 'error');
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}
