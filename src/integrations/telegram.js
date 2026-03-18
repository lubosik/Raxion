import { getRuntimeConfigValue } from '../services/configService.js';

function getBotToken() {
  return getRuntimeConfigValue('TELEGRAM_BOT_TOKEN');
}

function getRecruiterChatIdValue() {
  return getRuntimeConfigValue('TELEGRAM_CHAT_ID');
}

async function sendTelegramRequest(method, payload) {
  const botToken = getBotToken();
  if (!botToken) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN.');
  }

  const send = async (requestPayload) => {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  };

  let result = await send(payload);
  if (!result.ok && payload.parse_mode && result.status === 400) {
    const fallbackPayload = { ...payload };
    if (typeof fallbackPayload.text === 'string') {
      fallbackPayload.text = fallbackPayload.text.replace(/[*_`]/g, '');
    }
    delete fallbackPayload.parse_mode;
    result = await send(fallbackPayload);
  }

  if (!result.ok) {
    throw new Error(`Telegram API ${result.status}: ${result.body}`);
  }

  return JSON.parse(result.body);
}

export async function sendTelegramMessage(chatId, message, options = {}) {
  if (!chatId) {
    throw new Error('Missing Telegram chat id.');
  }

  return sendTelegramRequest('sendMessage', {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true,
    parse_mode: 'Markdown',
    ...options,
  });
}

export async function editTelegramMessage(chatId, messageId, message, options = {}) {
  return sendTelegramRequest('editMessageText', {
    chat_id: chatId,
    message_id: Number(messageId),
    text: message,
    disable_web_page_preview: true,
    parse_mode: 'Markdown',
    ...options,
  });
}

export async function editTelegramReplyMarkup(chatId, messageId, replyMarkup) {
  return sendTelegramRequest('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: Number(messageId),
    reply_markup: replyMarkup,
  });
}

export async function sendCriticalAlert(message) {
  const recruiterChatId = getRecruiterChatIdValue();
  const botToken = getBotToken();
  if (!recruiterChatId || !botToken) return null;
  return sendTelegramMessage(recruiterChatId, `🚨 RAXION ALERT\n\n${message}`);
}

export function getRecruiterChatId() {
  return getRecruiterChatIdValue();
}
