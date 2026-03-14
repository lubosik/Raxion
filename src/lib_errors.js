import supabase from './db/supabase.js';
import { sendCriticalAlert } from './integrations/telegram.js';

export async function logError(service, error, severity = 'error') {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack || null : null;

  try {
    await supabase.from('error_log').insert({
      service,
      error_message: message,
      stack,
      severity,
    });
  } catch (dbError) {
    console.error('[error_log]', dbError);
  }

  if (severity === 'critical') {
    try {
      await sendCriticalAlert(`${service}: ${message}`);
    } catch (telegramError) {
      console.error('[critical_alert]', telegramError);
    }
  }

  console.error(`[${service}]`, error);
}

export function normalizeError(error, fallbackMessage = 'Unknown error') {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : fallbackMessage);
}
