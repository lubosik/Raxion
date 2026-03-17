import supabase from './db/supabase.js';
import { getChatMessages } from './integrations/unipile.js';
import { processIncomingMessage } from './services/replyHandler.js';
import { resendMissingTelegramApprovalCards } from './services/approvalService.js';
import { logActivity } from './services/activityLogger.js';

let monitorStarted = false;
let monitorTimer = null;
let monitorInFlight = false;

function normalizePolledMessage(message) {
  return {
    chat_id: message.chat_id || null,
    text: message.text || message.original || '',
    timestamp: message.timestamp || new Date().toISOString(),
    message_id: message.id || message.provider_id || null,
    provider_message_id: message.provider_id || null,
    sender_id: message.sender_id || null,
    sender: {
      attendee_provider_id: message.sender_id || null,
    },
    attendees: [{
      attendee_provider_id: message.sender_id || null,
    }],
    attachments: message.attachments || [],
    source_channel: 'linkedin_dm',
    poll_recovered: true,
  };
}

async function findMissingInboundMessages() {
  const { data: candidates } = await supabase
    .from('candidates')
    .select('id,job_id,name,unipile_chat_id')
    .not('unipile_chat_id', 'is', null);

  let recovered = 0;

  for (const candidate of candidates || []) {
    // eslint-disable-next-line no-await-in-loop
    const messages = await getChatMessages(candidate.unipile_chat_id);
    const inboundMessages = (messages || []).filter((message) => !message.is_sender);

    for (const message of inboundMessages) {
      const messageId = message.id || message.provider_id || null;
      if (!messageId) continue;

      // eslint-disable-next-line no-await-in-loop
      const { data: existing } = await supabase
        .from('conversations')
        .select('id')
        .eq('unipile_message_id', messageId)
        .limit(1)
        .maybeSingle();
      if (existing) continue;

      // eslint-disable-next-line no-await-in-loop
      await processIncomingMessage(normalizePolledMessage(message));
      // eslint-disable-next-line no-await-in-loop
      await logActivity(candidate.job_id, candidate.id, 'INBOUND_MESSAGE_RECOVERED', `${candidate.name} reply recovered by inbox monitor`, {
        chat_id: candidate.unipile_chat_id,
        unipile_message_id: messageId,
        timestamp: message.timestamp || null,
      });
      recovered += 1;
    }
  }

  return recovered;
}

export async function processInboundMessage() {
  const [recoveredReplies, resentApprovals] = await Promise.all([
    findMissingInboundMessages(),
    resendMissingTelegramApprovalCards(),
  ]);

  return { recoveredReplies, resentApprovals };
}

export function startInboxMonitor() {
  if (monitorStarted) return { started: true };
  monitorStarted = true;

  const runMonitor = async () => {
    if (monitorInFlight) return;
    monitorInFlight = true;
    try {
      const result = await processInboundMessage();
      if ((result?.recoveredReplies || 0) || (result?.resentApprovals || 0)) {
        console.log('[raxion] inbox monitor recovered activity', result);
      }
    } catch (error) {
      console.error('[raxion] inbox monitor failed', error);
    } finally {
      monitorInFlight = false;
    }
  };

  monitorTimer = setInterval(runMonitor, 60 * 1000);
  runMonitor().catch(() => null);
  console.log('[raxion] inbox monitor ready (polling fallback active)');
  return { started: monitorStarted, timer: monitorTimer };
}
