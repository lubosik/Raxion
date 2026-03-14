import supabase from '../db/supabase.js';
import { logError } from '../lib_errors.js';

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
