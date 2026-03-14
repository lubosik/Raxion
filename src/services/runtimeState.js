import { getSetting, setSetting } from './settings.js';

const DEFAULT_STATE = {
  raxionStatus: 'ACTIVE',
  outreachEnabled: true,
  followupEnabled: true,
  enrichmentEnabled: true,
  researchEnabled: true,
  linkedinEnabled: true,
  postsEnabled: false,
  outreachPausedUntil: null,
};

const SETTING_MAP = {
  raxionStatus: 'raxion_status',
  outreachEnabled: 'outreach_enabled',
  followupEnabled: 'followup_enabled',
  enrichmentEnabled: 'enrichment_enabled',
  researchEnabled: 'research_enabled',
  linkedinEnabled: 'linkedin_enabled',
  postsEnabled: 'posts_enabled',
  outreachPausedUntil: 'outreach_paused_until',
};

function parseValue(key, value) {
  if (value == null) return DEFAULT_STATE[key];
  if (typeof DEFAULT_STATE[key] === 'boolean') return value === 'true';
  return value;
}

export async function getRuntimeState() {
  const entries = await Promise.all(
    Object.entries(SETTING_MAP).map(async ([key, settingKey]) => [key, await getSetting(settingKey, null)]),
  );

  const state = Object.fromEntries(entries.map(([key, value]) => [key, parseValue(key, value)]));
  state.lastUpdated = new Date().toISOString();
  return state;
}

export async function setRuntimeStateValue(key, value) {
  if (!(key in SETTING_MAP)) {
    throw new Error(`Unknown runtime state key: ${key}`);
  }

  await setSetting(SETTING_MAP[key], value == null ? '' : value);
  return getRuntimeState();
}

export async function toggleRuntimeStateValue(key) {
  if (!(key in SETTING_MAP) || typeof DEFAULT_STATE[key] !== 'boolean') {
    throw new Error(`Key is not toggleable: ${key}`);
  }

  const state = await getRuntimeState();
  const next = !state[key];
  await setSetting(SETTING_MAP[key], next);
  return getRuntimeState();
}
