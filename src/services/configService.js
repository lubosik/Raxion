import { getSetting, setSetting } from './settings.js';

const BOOT_ENV = { ...process.env };
const ENV_PREFIX = 'runtime_env:';

export const CONFIG_FIELDS = [
  { key: 'SUPABASE_URL', label: 'Supabase URL', secret: false, restartRequired: true, category: 'Supabase', inputType: 'text' },
  { key: 'SUPABASE_SERVICE_KEY', label: 'Supabase Service Key', secret: true, restartRequired: true, category: 'Supabase', inputType: 'password' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', secret: true, restartRequired: false, category: 'Claude', inputType: 'password' },
  { key: 'UNIPILE_DSN', label: 'Unipile DSN', secret: false, restartRequired: false, category: 'Unipile', inputType: 'text' },
  { key: 'UNIPILE_API_KEY', label: 'Unipile API Key', secret: true, restartRequired: false, category: 'Unipile', inputType: 'password' },
  { key: 'UNIPILE_LINKEDIN_ACCOUNT_ID', label: 'Unipile LinkedIn Account ID', secret: false, restartRequired: false, category: 'Unipile', inputType: 'text' },
  { key: 'UNIPILE_EMAIL_ACCOUNT_ID', label: 'Unipile Email Account ID', secret: false, restartRequired: false, category: 'Unipile', inputType: 'text' },
  { key: 'APIFY_API_KEY', label: 'Apify API Key', secret: true, restartRequired: false, category: 'Apify', inputType: 'password' },
  { key: 'APIFY_ACTOR_ID', label: 'Apify Actor ID', secret: false, restartRequired: false, category: 'Apify', inputType: 'text' },
  { key: 'ZOHO_CLIENT_ID', label: 'Zoho Client ID', secret: true, restartRequired: false, category: 'Zoho', inputType: 'password' },
  { key: 'ZOHO_CLIENT_SECRET', label: 'Zoho Client Secret', secret: true, restartRequired: false, category: 'Zoho', inputType: 'password' },
  { key: 'ZOHO_REFRESH_TOKEN', label: 'Zoho Refresh Token', secret: true, restartRequired: false, category: 'Zoho', inputType: 'password' },
  { key: 'ZOHO_ACCOUNTS_URL', label: 'Zoho Accounts URL', secret: false, restartRequired: false, category: 'Zoho', inputType: 'text' },
  { key: 'ZOHO_API_BASE', label: 'Zoho API Base', secret: false, restartRequired: false, category: 'Zoho', inputType: 'text' },
  { key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram Bot Token', secret: true, restartRequired: true, category: 'Telegram', inputType: 'password' },
  { key: 'TELEGRAM_CHAT_ID', label: 'Telegram Chat ID', secret: false, restartRequired: false, category: 'Telegram', inputType: 'text' },
  { key: 'SERVER_BASE_URL', label: 'Server Base URL', secret: false, restartRequired: false, category: 'Server', inputType: 'text' },
  { key: 'PORT', label: 'Port', secret: false, restartRequired: true, category: 'Server', inputType: 'number' },
  { key: 'SENDER_NAME', label: 'Sender Name', secret: false, restartRequired: false, category: 'Server', inputType: 'text' },
  { key: 'REPLY_TO_EMAIL', label: 'Reply-To Email', secret: false, restartRequired: false, category: 'Server', inputType: 'text' },
  { key: 'RAXION_SOURCING_PIPELINE_TARGET', label: 'Pipeline Target', secret: false, restartRequired: false, category: 'Orchestration', inputType: 'number', description: 'Top up sourcing when pre-outreach candidates fall below this count.' },
  { key: 'RAXION_SOURCING_SHORTLIST_TARGET', label: 'Shortlist Target', secret: false, restartRequired: false, category: 'Orchestration', inputType: 'number', description: 'Top up sourcing when shortlisted candidates fall below this count.' },
  { key: 'RAXION_SOURCING_COOLDOWN_HOURS', label: 'Sourcing Cooldown Hours', secret: false, restartRequired: false, category: 'Orchestration', inputType: 'number', description: 'Minimum hours between automatic sourcing runs for the same job.' },
  { key: 'RAXION_SOURCING_SEARCH_GUIDANCE', label: 'Search Guidance', secret: false, restartRequired: false, category: 'Orchestration', inputType: 'text', description: 'Optional extra instructions for candidate search generation, specific to this client or vertical.' },
  { key: 'RAXION_SCORING_GUIDANCE', label: 'Scoring Guidance', secret: false, restartRequired: false, category: 'Orchestration', inputType: 'text', description: 'Optional extra instructions for candidate scoring, specific to this client or vertical.' },
];

function settingKey(key) {
  return `${ENV_PREFIX}${key}`;
}

function fieldFor(key) {
  return CONFIG_FIELDS.find((field) => field.key === key);
}

export function getRuntimeConfigValue(key, fallback = null) {
  const value = process.env[key];
  return value == null || value === '' ? fallback : value;
}

export async function hydrateRuntimeConfig() {
  for (const field of CONFIG_FIELDS) {
    // eslint-disable-next-line no-await-in-loop
    const override = await getSetting(settingKey(field.key), null);
    if (override != null && override !== '') {
      process.env[field.key] = override;
    }
  }
}

export async function listRuntimeConfig() {
  const rows = [];
  for (const field of CONFIG_FIELDS) {
    // eslint-disable-next-line no-await-in-loop
    const override = await getSetting(settingKey(field.key), null);
    const currentValue = process.env[field.key] ?? '';
    rows.push({
      ...field,
      value: currentValue,
      has_value: currentValue !== '',
      overridden: override != null && override !== '',
    });
  }
  return rows;
}

export async function setRuntimeConfigValue(key, value) {
  const field = fieldFor(key);
  if (!field) throw new Error(`Unknown config key: ${key}`);
  await setSetting(settingKey(key), value);
  process.env[key] = value;
  return {
    ...field,
    value,
    has_value: value !== '',
    overridden: true,
  };
}

export async function deleteRuntimeConfigValue(key) {
  const field = fieldFor(key);
  if (!field) throw new Error(`Unknown config key: ${key}`);
  await setSetting(settingKey(key), '');
  if (BOOT_ENV[key] != null && BOOT_ENV[key] !== '') {
    process.env[key] = BOOT_ENV[key];
  } else {
    delete process.env[key];
  }
  return {
    ...field,
    value: process.env[key] || '',
    has_value: Boolean(process.env[key]),
    overridden: false,
  };
}
