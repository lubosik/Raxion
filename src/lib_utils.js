export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function truncate(text, length = 100) {
  if (!text) return '';
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function timeAgo(input) {
  const date = input instanceof Date ? input : new Date(input);
  const diffSeconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  const units = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];

  for (const [label, amount] of units) {
    if (diffSeconds >= amount) {
      return `${Math.floor(diffSeconds / amount)}${label} ago`;
    }
  }

  return 'just now';
}

export function formatDateTime(input) {
  if (!input) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(input));
}

export function formatNumber(value) {
  return new Intl.NumberFormat('en-GB').format(Number(value || 0));
}

export function formatPercent(value) {
  return `${Math.round(Number(value || 0))}%`;
}

export function safeJsonParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function buildLinkedInSearchQuery(jobBrief) {
  return [
    jobBrief.role,
    jobBrief.seniority,
    jobBrief.location,
    jobBrief.remote ? 'remote' : '',
    ...(jobBrief.must_haves || []),
    jobBrief.sector,
  ]
    .filter(Boolean)
    .join(' | ');
}
