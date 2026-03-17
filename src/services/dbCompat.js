import supabase from '../db/supabase.js';

const columnSupportCache = new Map();

async function supportsColumn(table, column) {
  const cacheKey = `${table}.${column}`;
  if (columnSupportCache.has(cacheKey)) return columnSupportCache.get(cacheKey);

  const { error } = await supabase.from(table).select(column).limit(1);
  const supported = !error;
  columnSupportCache.set(cacheKey, supported);
  return supported;
}

async function supportedColumns(table, columns) {
  const pairs = await Promise.all(columns.map(async (column) => [column, await supportsColumn(table, column)]));
  return Object.fromEntries(pairs);
}

export function normalizeJobRecord(job) {
  if (!job) return job;
  const paused = typeof job.paused === 'boolean'
    ? job.paused
    : (job.status === 'PAUSED' || (job.paused_until && new Date(job.paused_until).getTime() > Date.now()));

  return {
    ...job,
    name: job.name || job.job_title || job.title || 'Untitled Job',
    job_title: job.job_title || job.title || job.name || 'Untitled Job',
    seniority_level: job.seniority_level || job.seniority || null,
    tech_stack_must: job.tech_stack_must || job.must_have_stack || null,
    full_job_description: job.full_job_description || job.raw_brief || job.candidate_profile || null,
    job_mode: job.job_mode || 'outbound',
    paused,
  };
}

export async function prepareJobPayload(input) {
  const columns = await supportedColumns('jobs', [
    'name',
    'job_title',
    'title',
    'client_name',
    'recruiter_name',
    'seniority_level',
    'seniority',
    'employment_type',
    'location',
    'remote_policy',
    'salary_min',
    'salary_max',
    'currency',
    'sector',
    'tech_stack_must',
    'must_have_stack',
    'tech_stack_nice',
    'candidate_profile',
    'full_job_description',
    'raw_brief',
    'status',
    'linkedin_daily_limit',
    'linkedin_job_posting_id',
    'linkedin_project_id',
    'last_applicant_fetch_at',
    'applicant_fetch_cursor',
    'zoho_job_opening_id',
    'job_mode',
    'calendly_link',
    'notify_email',
    'send_from',
    'send_until',
    'timezone',
    'active_days',
    'outreach_templates',
    'paused',
    'paused_until',
    'last_research_at',
  ]);

  const payload = {};
  const mapped = {
    name: input.name || input.job_title || input.title,
    job_title: input.job_title || input.title || input.name,
    title: input.title || input.job_title || input.name,
    client_name: input.client_name,
    recruiter_name: input.recruiter_name,
    seniority_level: input.seniority_level || input.seniority,
    seniority: input.seniority || input.seniority_level,
    employment_type: input.employment_type,
    location: input.location,
    remote_policy: input.remote_policy,
    salary_min: input.salary_min,
    salary_max: input.salary_max,
    currency: input.currency,
    sector: input.sector,
    tech_stack_must: input.tech_stack_must || input.must_have_stack,
    must_have_stack: input.must_have_stack || input.tech_stack_must,
    tech_stack_nice: input.tech_stack_nice,
    candidate_profile: input.candidate_profile || input.raw_brief || input.full_job_description,
    full_job_description: input.full_job_description || input.raw_brief || input.candidate_profile,
    raw_brief: input.raw_brief || input.full_job_description || input.candidate_profile,
    status: input.status,
    linkedin_daily_limit: input.linkedin_daily_limit,
    linkedin_job_posting_id: input.linkedin_job_posting_id,
    linkedin_project_id: input.linkedin_project_id,
    last_applicant_fetch_at: input.last_applicant_fetch_at,
    applicant_fetch_cursor: input.applicant_fetch_cursor,
    zoho_job_opening_id: input.zoho_job_opening_id,
    job_mode: input.job_mode,
    calendly_link: input.calendly_link,
    notify_email: input.notify_email,
    send_from: input.send_from || input.send_window_start,
    send_until: input.send_until || input.send_window_end,
    timezone: input.timezone,
    active_days: input.active_days,
    outreach_templates: input.outreach_templates,
    paused: input.paused,
    paused_until: input.paused_until,
    last_research_at: input.last_research_at,
  };

  for (const [column, value] of Object.entries(mapped)) {
    if (columns[column] && value !== undefined) payload[column] = value;
  }

  return payload;
}

export function normalizeApprovalRecord(approval) {
  if (!approval) return approval;
  return {
    ...approval,
    message_text: approval.message_text || approval.body || approval.edited_body || '',
    stage: approval.stage || approval.message_type || null,
    telegram_message_id: approval.telegram_message_id || (approval.telegram_msg_id != null ? String(approval.telegram_msg_id) : null),
    subject: approval.subject || null,
  };
}

export async function prepareApprovalInsertPayload(input) {
  const columns = await supportedColumns('approval_queue', [
    'candidate_id',
    'job_id',
    'message_text',
    'body',
    'channel',
    'stage',
    'message_type',
    'status',
    'subject',
    'telegram_message_id',
  ]);

  const payload = {};
  if (columns.candidate_id) payload.candidate_id = input.candidate_id;
  if (columns.job_id) payload.job_id = input.job_id;
  if (columns.message_text) payload.message_text = input.message_text;
  if (columns.body) payload.body = input.message_text;
  if (columns.channel) payload.channel = input.channel;
  if (columns.stage) payload.stage = input.stage;
  if (columns.message_type) payload.message_type = input.message_type || input.channel;
  if (columns.status) payload.status = input.status || 'pending';
  if (columns.subject && input.subject !== undefined) payload.subject = input.subject;
  return payload;
}

export async function prepareApprovalUpdatePayload(input) {
  const columns = await supportedColumns('approval_queue', [
    'message_text',
    'body',
    'status',
    'telegram_message_id',
    'approved_at',
    'sent_at',
  ]);

  const payload = {};
  if (input.message_text !== undefined) {
    if (columns.message_text) payload.message_text = input.message_text;
    if (columns.body) payload.body = input.message_text;
  }
  if (input.status !== undefined && columns.status) payload.status = input.status;
  if (input.telegram_message_id !== undefined && columns.telegram_message_id) payload.telegram_message_id = input.telegram_message_id;
  if (input.approved_at !== undefined && columns.approved_at) payload.approved_at = input.approved_at;
  if (input.sent_at !== undefined && columns.sent_at) payload.sent_at = input.sent_at;
  return payload;
}

export function normalizeConversationRecord(conversation) {
  if (!conversation) return conversation;
  return {
    ...conversation,
    message_text: conversation.message_text || conversation.content || '',
    unipile_message_id: conversation.unipile_message_id || conversation.provider_id || null,
  };
}

export function normalizeCandidateRecord(candidate) {
  if (!candidate) return candidate;
  return {
    ...candidate,
    candidate_type: candidate.candidate_type || 'sourced',
    application_rating: candidate.application_rating || 'UNRATED',
    reply_sent: Boolean(candidate.reply_sent),
    team_pinged: Boolean(candidate.team_pinged),
    interview_scheduled: Boolean(candidate.interview_scheduled),
  };
}

export async function prepareConversationInsertPayload(input) {
  const columns = await supportedColumns('conversations', [
    'candidate_id',
    'job_id',
    'direction',
    'channel',
    'message_text',
    'content',
    'subject',
    'unipile_message_id',
    'provider_id',
    'sent_at',
    'read',
  ]);

  const payload = {};
  if (columns.candidate_id) payload.candidate_id = input.candidate_id;
  if (columns.job_id) payload.job_id = input.job_id;
  if (columns.direction) payload.direction = input.direction;
  if (columns.channel) payload.channel = input.channel;
  if (columns.message_text) payload.message_text = input.message_text;
  if (columns.content) payload.content = input.message_text;
  if (columns.subject && input.subject !== undefined) payload.subject = input.subject;
  if (columns.unipile_message_id) payload.unipile_message_id = input.unipile_message_id || null;
  if (columns.provider_id) payload.provider_id = input.unipile_message_id || null;
  if (columns.sent_at) payload.sent_at = input.sent_at;
  if (columns.read && input.read !== undefined) payload.read = input.read;
  return payload;
}
