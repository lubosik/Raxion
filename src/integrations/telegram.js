const botToken = process.env.TELEGRAM_BOT_TOKEN;
const recruiterChatId = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramRequest(method, payload) {
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

export async function sendTelegramMessage(chatId, message) {
  if (!chatId) {
    throw new Error('Missing Telegram chat id.');
  }

  return sendTelegramRequest('sendMessage', {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true,
    parse_mode: 'Markdown',
  });
}

export async function editTelegramMessage(chatId, messageId, message) {
  return sendTelegramRequest('editMessageText', {
    chat_id: chatId,
    message_id: Number(messageId),
    text: message,
    disable_web_page_preview: true,
    parse_mode: 'Markdown',
  });
}

export async function sendCriticalAlert(message) {
  if (!recruiterChatId || !botToken) return null;
  return sendTelegramMessage(recruiterChatId, `🚨 RAXION ALERT\n\n${message}`);
}

export function getRecruiterChatId() {
  return recruiterChatId;
}
