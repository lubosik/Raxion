import { sleep } from '../lib_utils.js';
import { getRuntimeConfigValue } from '../services/configService.js';
import { getLiveCredential } from '../services/settings.js';

async function getBaseUrl() {
  const dsn = await getLiveCredential('UNIPILE_DSN');
  return dsn ? `https://${dsn}/api/v1` : null;
}

async function getApiKey() {
  return getLiveCredential('UNIPILE_API_KEY');
}

async function getLinkedinAccountId() {
  return getLiveCredential('UNIPILE_LINKEDIN_ACCOUNT_ID');
}

async function getEmailAccountId() {
  return getLiveCredential('UNIPILE_EMAIL_ACCOUNT_ID');
}

function normalizeServerBaseUrl(rawValue) {
  const value = String(rawValue || '').trim().replace(/\/+$/, '');
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

async function withQuery(path, params = {}) {
  const baseUrl = await getBaseUrl();
  if (!baseUrl) return null;
  const url = new URL(`${baseUrl}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === '') return;
    if (Array.isArray(value)) {
      value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .forEach((item) => url.searchParams.append(key, item));
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url;
}

async function request(path, {
  method = 'GET',
  body,
  headers = {},
  isMultipart = false,
  returnBuffer = false,
  query,
  allowErrorResponse = false,
} = {}) {
  const [baseUrl, apiKey] = await Promise.all([getBaseUrl(), getApiKey()]);
  if (!baseUrl || !apiKey) {
    console.error('[unipile] missing UNIPILE_DSN or UNIPILE_API_KEY');
    return null;
  }

  try {
    const url = await withQuery(path, query);
    const response = await fetch(url, {
      method,
      headers: {
        'X-API-KEY': apiKey,
        ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body == null ? undefined : (isMultipart ? body : JSON.stringify(body)),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      console.error('[unipile] request failed', { path, method, status: response.status, body: responseBody });
      if (allowErrorResponse) {
        return {
          error: responseBody || `HTTP ${response.status}`,
          status: response.status,
        };
      }
      return null;
    }

    if (returnBuffer) {
      return Buffer.from(await response.arrayBuffer());
    }

    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('application/json') ? response.json() : response.text();
  } catch (error) {
    console.error('[unipile] request error', { path, method, error: error.message });
    return null;
  }
}

async function listAllWebhooks() {
  const items = [];
  let cursor = null;

  do {
    // eslint-disable-next-line no-await-in-loop
    const response = await request('/webhooks', {
      query: { limit: 250, ...(cursor ? { cursor } : {}) },
    });
    const pageItems = response?.items || [];
    items.push(...pageItems);
    cursor = response?.cursor?.next || response?.cursor || null;
  } while (cursor);

  return items;
}

const SEARCH_PARAMETER_TYPES = {
  industry: 'INDUSTRY',
  location: 'LOCATION',
  company: 'COMPANY',
  past_company: 'COMPANY',
  school: 'SCHOOL',
  service: 'SERVICE',
  connections_of: 'CONNECTIONS',
  followers_of: 'PEOPLE',
};

function normalizeSearchValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

function isLikelyResolvedId(value) {
  return /^[A-Za-z0-9:_-]{6,}$/.test(String(value || ''));
}

async function resolveSearchFilterParam(type, rawValue) {
  const values = normalizeSearchValues(rawValue);
  if (!values.length) return undefined;
  if (values.every(isLikelyResolvedId)) return values;

  const resolved = [];
  for (const value of values) {
    // eslint-disable-next-line no-await-in-loop
    const matches = await getSearchParameters(type, value);
    const exact = (matches || []).find((item) => String(item.title || '').toLowerCase() === value.toLowerCase());
    const first = exact || matches?.[0];
    if (first?.id) resolved.push(first.id);
  }

  return resolved.length ? resolved : undefined;
}

async function resolveSearchParams(params = {}) {
  const payload = { ...params };

  for (const [key, type] of Object.entries(SEARCH_PARAMETER_TYPES)) {
    if (!(key in payload)) continue;
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveSearchFilterParam(type, payload[key]);
    if (resolved?.length) {
      payload[key] = resolved;
    } else {
      delete payload[key];
    }
  }

  if (payload.network_distance != null && !Array.isArray(payload.network_distance)) {
    payload.network_distance = [Number(payload.network_distance)].filter(Boolean);
  }

  return payload;
}

export async function searchLinkedInPeople(params = {}) {
  const linkedinAccountId = await getLinkedinAccountId();
  const resolvedParams = await resolveSearchParams(params);
  const result = await request('/linkedin/search', {
    method: 'POST',
    query: { account_id: linkedinAccountId },
    body: {
      api: 'classic',
      category: 'people',
      ...resolvedParams,
    },
  });
  return result?.items || result?.results || result?.profiles || result || [];
}

export async function getLinkedInProfile(providerId) {
  const linkedinAccountId = await getLinkedinAccountId();
  return request(`/users/${encodeURIComponent(providerId)}`, {
    query: {
      account_id: linkedinAccountId,
      linkedin_sections: ['*_preview', 'skills', 'experience'],
      notify: false,
    },
  });
}

export async function sendConnectionRequest(providerId, message) {
  const linkedinAccountId = await getLinkedinAccountId();
  const payload = {
    provider_id: providerId,
    account_id: linkedinAccountId,
  };
  if (message && String(message).trim()) {
    payload.message = String(message).slice(0, 300);
  }
  return request('/users/invite', {
    method: 'POST',
    body: payload,
    allowErrorResponse: true,
  });
}

function normalizeLinkedInUrl(url) {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

function extractLinkedInPublicIdentifier(linkedinUrl) {
  const match = String(linkedinUrl || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]).trim().toLowerCase() : null;
}

export async function resolveLinkedInProviderId(linkedinUrl) {
  const publicIdentifier = extractLinkedInPublicIdentifier(linkedinUrl);
  if (!publicIdentifier) return null;

  const keywords = publicIdentifier.replace(/[-_]+/g, ' ');
  const results = await searchLinkedInPeople({
    keywords,
    network_distance: [1, 2, 3],
  });

  const normalizedTargetUrl = normalizeLinkedInUrl(linkedinUrl);
  const exactMatch = (results || []).find((item) => {
    const itemUrl = item.profile_url || item.linkedin_url || (item.public_identifier ? `https://www.linkedin.com/in/${item.public_identifier}` : null);
    return normalizeLinkedInUrl(itemUrl) === normalizedTargetUrl;
  });
  if (exactMatch?.provider_id || exactMatch?.id) {
    return exactMatch.provider_id || exactMatch.id;
  }

  const identifierMatch = (results || []).find((item) => String(item.public_identifier || '').trim().toLowerCase() === publicIdentifier);
  return identifierMatch?.provider_id || identifierMatch?.id || null;
}

export async function checkLinkedInConnectionStatus(providerId) {
  const [baseUrl, apiKey, linkedinAccountId] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getLinkedinAccountId(),
  ]);
  if (!baseUrl || !apiKey || !linkedinAccountId || !providerId) return 'unknown';

  const url = new URL(`${baseUrl}/users/${encodeURIComponent(providerId)}`);
  url.searchParams.set('account_id', linkedinAccountId);

  try {
    const response = await fetch(url, {
      headers: {
        'X-API-KEY': apiKey,
      },
    });

    if (!response.ok) {
      if (response.status === 404) return 'not_found';
      return 'unknown';
    }

    const profile = await response.json();
    if (profile?.distance === 1 || profile?.is_connected === true) return 'connected';
    if (profile?.invitation_sent === true || profile?.pending_invitation === true) return 'pending';
    return 'not_connected';
  } catch (error) {
    console.error('[unipile] connection status lookup failed', { providerId, error: error.message });
    return 'unknown';
  }
}

export async function startLinkedInDM(providerId, message) {
  const linkedinAccountId = await getLinkedinAccountId();
  return request('/chats', {
    method: 'POST',
    body: {
      account_id: linkedinAccountId,
      attendees_ids: [providerId],
      text: message,
    },
  });
}

export async function getChat(chatId) {
  const linkedinAccountId = await getLinkedinAccountId();
  return request(`/chats/${encodeURIComponent(chatId)}`, {
    query: { account_id: linkedinAccountId },
  });
}

export async function sendLinkedInDM(chatId, message) {
  const linkedinAccountId = await getLinkedinAccountId();
  return request(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: {
      text: message,
      account_id: linkedinAccountId,
    },
  });
}

export async function getChatMessages(chatId) {
  const result = await request(`/chats/${encodeURIComponent(chatId)}/messages`, {
    query: { limit: 50 },
  });
  return result?.items || result?.messages || result || [];
}

export async function downloadAttachment(messageId, attachmentId) {
  return request(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    returnBuffer: true,
  });
}

export async function sendEmail(toEmail, toName, subject, body, replyToMessageId = null) {
  const emailAccountId = await getEmailAccountId();
  const form = new FormData();
  form.set('account_id', emailAccountId || '');
  form.set('subject', subject || '');
  form.set('body', body || '');
  form.set('to', JSON.stringify([{ display_name: toName || toEmail, identifier: toEmail }]));
  if (replyToMessageId) form.set('reply_to', replyToMessageId);

  return request('/emails', {
    method: 'POST',
    body: form,
    isMultipart: true,
  });
}

export async function getEmail(emailId) {
  const emailAccountId = await getEmailAccountId();
  return request(`/emails/${encodeURIComponent(emailId)}`, {
    query: emailAccountId ? { account_id: emailAccountId } : undefined,
  });
}

export async function downloadEmailAttachment(emailId, attachmentId) {
  const emailAccountId = await getEmailAccountId();
  return request(`/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    query: emailAccountId ? { account_id: emailAccountId } : undefined,
    returnBuffer: true,
  });
}

export async function createPost({ text, includeJobPosting, externalLink, asOrganization } = {}) {
  const linkedinAccountId = await getLinkedinAccountId();
  return request('/posts', {
    method: 'POST',
    body: {
      account_id: linkedinAccountId,
      text: text || '',
      ...(includeJobPosting ? { include_job_posting: includeJobPosting } : {}),
      ...(externalLink ? { external_link: externalLink } : {}),
      ...(asOrganization ? { as_organization: asOrganization } : {}),
    },
  });
}

export async function listLinkedInJobPostings() {
  const linkedinAccountId = await getLinkedinAccountId();
  const result = await request('/linkedin/jobs', {
    query: { account_id: linkedinAccountId, category: 'active' },
  });
  return result?.items || result?.jobs || result || [];
}

export async function createLinkedInJobPosting(jobData) {
  const linkedinAccountId = await getLinkedinAccountId();
  return request('/linkedin/jobs', {
    method: 'POST',
    body: {
      account_id: linkedinAccountId,
      ...jobData,
    },
  });
}

export async function publishLinkedInJobPosting(draftId) {
  const linkedinAccountId = await getLinkedinAccountId();
  return request(`/linkedin/jobs/${encodeURIComponent(draftId)}/publish`, {
    method: 'POST',
    body: {
      account_id: linkedinAccountId,
      mode: 'FREE',
      service: 'CLASSIC',
    },
  });
}

export async function closeLinkedInJobPosting(jobId) {
  const linkedinAccountId = await getLinkedinAccountId();
  return request(`/linkedin/jobs/${encodeURIComponent(jobId)}/close`, {
    method: 'POST',
    query: { account_id: linkedinAccountId },
  });
}

export async function getJobApplicants(linkedinJobId, filters = {}) {
  const linkedinAccountId = await getLinkedinAccountId();
  const result = await request(`/linkedin/jobs/${encodeURIComponent(linkedinJobId)}/applicants`, {
    query: { account_id: linkedinAccountId, ...filters },
  });
  return result?.items || result?.applicants || result || [];
}

export async function getJobApplicantsPage(linkedinJobId, filters = {}) {
  const linkedinAccountId = await getLinkedinAccountId();
  return request(`/linkedin/jobs/${encodeURIComponent(linkedinJobId)}/applicants`, {
    query: { account_id: linkedinAccountId, ...filters },
  });
}

export async function downloadApplicantResume(applicantId) {
  const linkedinAccountId = await getLinkedinAccountId();
  return request(`/linkedin/jobs/applicants/${encodeURIComponent(applicantId)}/resume`, {
    query: { account_id: linkedinAccountId },
    returnBuffer: true,
  });
}

export async function addApplicantToHiringProject(providerId, hiringProjectId, stage = 'UNCONTACTED') {
  if (!providerId || !hiringProjectId) return null;
  const linkedinAccountId = await getLinkedinAccountId();
  return request(`/linkedin/user/${encodeURIComponent(providerId)}`, {
    method: 'POST',
    body: {
      account_id: linkedinAccountId,
      api: 'recruiter',
      action: 'addCandidateToPipeline',
      hiring_project_id: hiringProjectId,
      stage,
    },
  });
}

export async function getSearchParameters(type, keywords) {
  const linkedinAccountId = await getLinkedinAccountId();
  const result = await request('/linkedin/search/parameters', {
    query: { type, keywords, account_id: linkedinAccountId },
  });
  return result?.items || result?.results || result || [];
}

export async function setupWebhooks() {
  const serverBaseUrl = normalizeServerBaseUrl(getRuntimeConfigValue('SERVER_BASE_URL'));
  const linkedinAccountId = await getLinkedinAccountId();
  if (!serverBaseUrl) {
    console.warn('[unipile] skipping webhook setup: SERVER_BASE_URL is not configured');
    return false;
  }

  const webhooks = await listAllWebhooks();
  const targets = [
    {
      name: 'Raxion Messaging',
      source: 'messaging',
      request_url: `${serverBaseUrl}/webhooks/unipile/messages`,
      format: 'json',
      enabled: true,
      account_ids: linkedinAccountId ? [linkedinAccountId] : undefined,
      events: ['message_received'],
      headers: [{ key: 'Content-Type', value: 'application/json' }],
    },
    {
      name: 'Raxion Relations',
      source: 'users',
      request_url: `${serverBaseUrl}/webhooks/unipile/relations`,
      format: 'json',
      enabled: true,
      account_ids: linkedinAccountId ? [linkedinAccountId] : undefined,
      events: ['new_relation'],
      headers: [{ key: 'Content-Type', value: 'application/json' }],
    },
  ];

  for (const target of targets) {
    const found = webhooks.find((item) => item.source === target.source && item.request_url === target.request_url);
    if (!found) {
      // eslint-disable-next-line no-await-in-loop
      const created = await request('/webhooks', {
        method: 'POST',
        body: target,
      });
      console.log('[unipile] webhook created', { source: target.source, request_url: target.request_url, webhook_id: created?.webhook_id || null });
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
  }

  return true;
}
