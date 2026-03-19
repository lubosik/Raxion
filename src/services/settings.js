import supabase from '../db/supabase.js';
import { logError } from '../lib_errors.js';

const RUNTIME_ENV_PREFIX = 'runtime_env:';
const LIVE_CREDENTIAL_KEYS = [
  'UNIPILE_DSN',
  'UNIPILE_API_KEY',
  'UNIPILE_LINKEDIN_ACCOUNT_ID',
  'UNIPILE_EMAIL_ACCOUNT_ID',
];

let credentialCache = {};
let cacheExpiry = 0;

function liveCredentialKeys(key) {
  return [key, `${RUNTIME_ENV_PREFIX}${key}`];
}

export async function getSetting(key, fallback = null) {
  try {
    const { data } = await supabase.from('raxion_settings').select('value').eq('key', key).maybeSingle();
    return data?.value ?? fallback;
  } catch (error) {
    await logError('settings.getSetting', error, 'error');
    return fallback;
  }
}

export async function setSetting(key, value) {
  try {
    await supabase.from('raxion_settings').upsert({ key, value: String(value), updated_at: new Date().toISOString() });
  } catch (error) {
    await logError('settings.setSetting', error, 'error');
    throw error;
  }
}

export async function getLiveCredential(key) {
  if (!LIVE_CREDENTIAL_KEYS.includes(key)) {
    return process.env[key] || null;
  }

  const now = Date.now();
  if (now > cacheExpiry || credentialCache[key] == null) {
    try {
      const settingKeys = LIVE_CREDENTIAL_KEYS.flatMap((item) => liveCredentialKeys(item));
      const { data } = await supabase
        .from('raxion_settings')
        .select('key, value')
        .in('key', settingKeys);

      credentialCache = {};
      for (const row of data || []) {
        const rawKey = String(row.key || '').replace(RUNTIME_ENV_PREFIX, '');
        if (!row.value || credentialCache[rawKey]) continue;
        credentialCache[rawKey] = row.value;
      }
      cacheExpiry = now + (30 * 1000);
    } catch (error) {
      await logError('settings.getLiveCredential', error, 'warn');
      cacheExpiry = now + (5 * 1000);
    }
  }

  return credentialCache[key] || process.env[key] || null;
}

export async function setLiveCredential(key, value) {
  if (!LIVE_CREDENTIAL_KEYS.includes(key)) {
    throw new Error(`Unknown live credential key: ${key}`);
  }

  const stringValue = String(value ?? '');
  const updatedAt = new Date().toISOString();

  try {
    await supabase.from('raxion_settings').upsert(
      liveCredentialKeys(key).map((settingKey) => ({
        key: settingKey,
        value: stringValue,
        updated_at: updatedAt,
      })),
      { onConflict: 'key' },
    );
    process.env[key] = stringValue;
    invalidateCredentialCache();
  } catch (error) {
    await logError('settings.setLiveCredential', error, 'error');
    throw error;
  }
}

export function invalidateCredentialCache() {
  credentialCache = {};
  cacheExpiry = 0;
}
