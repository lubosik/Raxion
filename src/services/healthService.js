import supabase from '../db/supabase.js';
import { getRuntimeConfigValue } from './configService.js';
import { getAccessToken } from '../integrations/zohoRecruit.js';
import { getLiveCredential } from './settings.js';

let cachedHealth = null;
let cachedAt = 0;
const CACHE_MS = 60 * 1000;

function okStatus(name, detail = 'Connected') {
  return { name, status: 'ok', detail };
}

function warnStatus(name, detail) {
  return { name, status: 'warn', detail };
}

function errorStatus(name, detail) {
  return { name, status: 'error', detail };
}

async function checkSupabase() {
  try {
    const { error } = await supabase.from('raxion_settings').select('key').limit(1);
    return error ? errorStatus('Supabase', error.message) : okStatus('Supabase', 'Database reachable');
  } catch (error) {
    return errorStatus('Supabase', error.message);
  }
}

async function checkTelegram() {
  const token = getRuntimeConfigValue('TELEGRAM_BOT_TOKEN');
  const chatId = getRuntimeConfigValue('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return warnStatus('Telegram', 'Missing bot token or chat id');

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (!response.ok) return errorStatus('Telegram', `API ${response.status}`);
    const payload = await response.json();
    return payload.ok ? okStatus('Telegram', `Bot ${payload.result?.username || 'connected'}`) : errorStatus('Telegram', 'Token rejected');
  } catch (error) {
    return errorStatus('Telegram', error.message);
  }
}

async function checkClaude() {
  const apiKey = getRuntimeConfigValue('ANTHROPIC_API_KEY');
  if (!apiKey) return warnStatus('Claude', 'Missing API key');
  return okStatus('Claude', 'API key configured');
}

export async function testUnipileConnection(credentials = {}) {
  const dsn = credentials.UNIPILE_DSN || await getLiveCredential('UNIPILE_DSN');
  const apiKey = credentials.UNIPILE_API_KEY || await getLiveCredential('UNIPILE_API_KEY');
  if (!dsn || !apiKey) return warnStatus('Unipile', 'Missing DSN or API key');

  try {
    const response = await fetch(`https://${dsn}/api/v1/webhooks?limit=1`, {
      headers: { 'X-API-KEY': apiKey },
    });
    return response.ok ? okStatus('Unipile', 'API reachable') : errorStatus('Unipile', `API ${response.status}`);
  } catch (error) {
    return errorStatus('Unipile', error.message);
  }
}

async function checkUnipile() {
  return testUnipileConnection();
}

async function checkApify() {
  const actorId = getRuntimeConfigValue('APIFY_ACTOR_ID');
  const apiKey = getRuntimeConfigValue('APIFY_API_KEY');
  if (!actorId || !apiKey) return warnStatus('Apify', 'Missing actor id or API key');

  try {
    const response = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return response.ok ? okStatus('Apify', 'Actor reachable') : errorStatus('Apify', `API ${response.status}`);
  } catch (error) {
    return errorStatus('Apify', error.message);
  }
}

async function checkZoho() {
  const clientId = getRuntimeConfigValue('ZOHO_CLIENT_ID');
  const clientSecret = getRuntimeConfigValue('ZOHO_CLIENT_SECRET');
  const refreshToken = getRuntimeConfigValue('ZOHO_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) return warnStatus('Zoho', 'Missing OAuth credentials');

  try {
    const token = await getAccessToken();
    return token ? okStatus('Zoho', 'Access token refresh succeeded') : errorStatus('Zoho', 'Token refresh failed');
  } catch (error) {
    return errorStatus('Zoho', error.message);
  }
}

export async function getIntegrationHealth(forceRefresh = false) {
  if (!forceRefresh && cachedHealth && (Date.now() - cachedAt) < CACHE_MS) {
    return cachedHealth;
  }

  const statuses = await Promise.all([
    checkSupabase(),
    checkTelegram(),
    checkClaude(),
    checkUnipile(),
    checkApify(),
    checkZoho(),
  ]);

  cachedHealth = {
    statuses,
    checked_at: new Date().toISOString(),
  };
  cachedAt = Date.now();
  return cachedHealth;
}
