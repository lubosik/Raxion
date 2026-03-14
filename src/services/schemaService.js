import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import supabase from '../db/supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function tableExists(tableName) {
  const { error } = await supabase.from(tableName).select('*', { head: true, count: 'exact' }).limit(1);
  return !error;
}

export async function ensureSchemaReady() {
  const requiredTables = ['jobs', 'conversations', 'activity_log', 'approval_queue', 'webhook_logs', 'gdpr_log'];
  const missing = [];

  for (const tableName of requiredTables) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await tableExists(tableName);
    if (!exists) missing.push(tableName);
  }

  if (!missing.length) {
    console.log('[schema] required tables detected');
    return { ready: true, missing: [] };
  }

  const migrationPath = path.resolve(__dirname, '../../supabase/migrations/002_raxion_extensions.sql');
  const migrationSql = await fs.readFile(migrationPath, 'utf8');
  console.warn('[schema] missing tables detected:', missing.join(', '));
  console.warn('[schema] apply this migration in Supabase before full production use:', migrationPath);
  return { ready: false, missing, migrationSql };
}
