create extension if not exists pgcrypto;

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  name text,
  status text default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED', 'CLOSED', 'FILLED')),
  job_title text,
  client_name text,
  recruiter_name text,
  seniority_level text,
  employment_type text,
  location text,
  remote_policy text,
  salary_min integer,
  salary_max integer,
  currency text,
  sector text,
  tech_stack_must text,
  tech_stack_nice text,
  years_experience_min integer,
  years_experience_max integer,
  visa_sponsorship boolean default false,
  candidate_profile text,
  full_job_description text,
  interview_stages text,
  calendly_link text,
  notify_email text,
  linkedin_daily_limit integer default 28,
  linkedin_job_posting_id text,
  target_placements integer default 1,
  committed_placements integer default 0,
  paused boolean default false,
  last_research_at timestamptz,
  created_at timestamptz default now(),
  closed_at timestamptz
);

alter table candidates add column if not exists job_id uuid references jobs(id) on delete cascade;
alter table candidates add column if not exists phone text;
alter table candidates add column if not exists linkedin_provider_id text;
alter table candidates add column if not exists unipile_chat_id text;
alter table candidates add column if not exists current_title text;
alter table candidates add column if not exists current_company text;
alter table candidates add column if not exists years_experience integer;
alter table candidates add column if not exists tech_skills text;
alter table candidates add column if not exists past_employers text;
alter table candidates add column if not exists education text;
alter table candidates add column if not exists visa_status text;
alter table candidates add column if not exists salary_expectation text;
alter table candidates add column if not exists notice_period text;
alter table candidates add column if not exists cv_text text;
alter table candidates add column if not exists fit_score integer;
alter table candidates add column if not exists fit_grade text;
alter table candidates add column if not exists fit_rationale text;
alter table candidates add column if not exists pipeline_stage text default 'Sourced';
alter table candidates add column if not exists enrichment_status text default 'Pending';
alter table candidates add column if not exists zoho_candidate_id text;
alter table candidates add column if not exists ats_synced boolean default false;
alter table candidates add column if not exists invite_sent_at timestamptz;
alter table candidates add column if not exists invite_accepted_at timestamptz;
alter table candidates add column if not exists dm_sent_at timestamptz;
alter table candidates add column if not exists last_reply_at timestamptz;
alter table candidates add column if not exists follow_up_count integer default 0;
alter table candidates add column if not exists follow_up_due_at timestamptz;
alter table candidates add column if not exists qualified_at timestamptz;
alter table candidates add column if not exists interview_booked_at timestamptz;
alter table candidates add column if not exists notes text;
alter table candidates add column if not exists source text default 'LinkedIn Search';

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidates(id) on delete cascade,
  job_id uuid references jobs(id) on delete cascade,
  direction text,
  channel text,
  message_text text,
  unipile_message_id text,
  sent_at timestamptz default now(),
  read boolean default false
);

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete cascade,
  candidate_id uuid references candidates(id) on delete set null,
  event_type text,
  summary text,
  detail jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists approval_queue (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidates(id) on delete cascade,
  job_id uuid references jobs(id) on delete cascade,
  message_text text,
  channel text,
  stage text,
  status text default 'pending',
  telegram_message_id text,
  created_at timestamptz default now()
);

alter table daily_limits add column if not exists job_id uuid references jobs(id) on delete cascade;
alter table daily_limits add column if not exists emails_sent integer default 0;

create unique index if not exists daily_limits_job_id_date_key on daily_limits(job_id, date);
create unique index if not exists candidates_job_provider_unique on candidates(job_id, linkedin_provider_id);

create table if not exists webhook_logs (
  id uuid primary key default gen_random_uuid(),
  event_type text,
  payload jsonb,
  received_at timestamptz default now()
);

create table if not exists gdpr_log (
  id uuid primary key default gen_random_uuid(),
  candidate_name text,
  candidate_email text,
  linkedin_url text,
  reason text,
  deleted_at timestamptz default now(),
  deleted_by text default 'system'
);

create index if not exists idx_jobs_status on jobs(status);
create index if not exists idx_jobs_paused on jobs(paused);
create index if not exists idx_candidates_job_id on candidates(job_id);
create index if not exists idx_candidates_pipeline_stage on candidates(pipeline_stage);
create index if not exists idx_candidates_enrichment_status on candidates(enrichment_status);
create index if not exists idx_conversations_candidate_id on conversations(candidate_id);
create index if not exists idx_activity_log_job_id on activity_log(job_id);
create index if not exists idx_activity_log_candidate_id on activity_log(candidate_id);
create index if not exists idx_activity_log_created_at on activity_log(created_at desc);
create index if not exists idx_approval_queue_status on approval_queue(status);
create index if not exists idx_webhook_logs_received_at on webhook_logs(received_at desc);
