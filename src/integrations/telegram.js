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

  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API ${response.status}: ${body}`);
  }

  return response.json();
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

export async function sendCriticalAlert(message) {
  const recruiterChatId = getRecruiterChatIdValue();
  const botToken = getBotToken();
  if (!recruiterChatId || !botToken) return null;
  return sendTelegramMessage(recruiterChatId, `🚨 RAXION ALERT\n\n${message}`);
}

export function getRecruiterChatId() {
  return getRecruiterChatIdValue();
}
