create extension if not exists pgcrypto;

create table if not exists job_briefs (
  id uuid primary key default gen_random_uuid(),
  client_name text,
  role text not null,
  seniority text,
  location text,
  remote boolean default false,
  salary_min integer,
  salary_max integer,
  must_haves jsonb default '[]'::jsonb,
  nice_to_haves jsonb default '[]'::jsonb,
  deal_breakers jsonb default '[]'::jsonb,
  sector text,
  status text default 'active',
  recruiter_id text,
  raw_input text,
  created_at timestamptz default now()
);

create table if not exists candidates (
  id uuid primary key default gen_random_uuid(),
  job_brief_id uuid references job_briefs(id) on delete cascade,
  name text,
  headline text,
  location text,
  linkedin_url text,
  provider_id text,
  email text,
  score integer,
  score_reason text,
  status text default 'sourced',
  source text default 'linkedin',
  qualification_answers jsonb default '{}'::jsonb,
  qualification_verdict text,
  next_contact_date timestamptz,
  last_contacted_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists outreach_log (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidates(id) on delete cascade,
  job_brief_id uuid references job_briefs(id) on delete cascade,
  channel text,
  message_text text,
  sent_at timestamptz default now(),
  step_number integer,
  delivered boolean default true
);

create table if not exists reply_log (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidates(id) on delete cascade,
  message_text text,
  classified_intent text,
  confidence numeric,
  extracted_info text,
  response_sent text,
  responded_at timestamptz default now()
);

create table if not exists qualification_state (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidates(id) on delete cascade unique,
  stage integer default 1,
  answers jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);

create table if not exists daily_limits (
  id uuid primary key default gen_random_uuid(),
  account_id text,
  date date default current_date,
  invites_sent integer default 0,
  dms_sent integer default 0,
  profile_visits integer default 0,
  unique(account_id, date)
);

create table if not exists inbound_leads (
  id uuid primary key default gen_random_uuid(),
  source text,
  sender_name text,
  sender_linkedin_url text,
  sender_email text,
  message_preview text,
  full_message text,
  classification text,
  matched_job_brief_id uuid references job_briefs(id) on delete set null,
  match_score integer,
  alerted boolean default false,
  reviewed boolean default false,
  created_at timestamptz default now()
);

create table if not exists webhook_log (
  id uuid primary key default gen_random_uuid(),
  event_type text,
  payload jsonb,
  received_at timestamptz default now()
);

create table if not exists error_log (
  id uuid primary key default gen_random_uuid(),
  service text,
  error_message text,
  stack text,
  severity text default 'error',
  created_at timestamptz default now()
);

create table if not exists raxion_settings (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

insert into raxion_settings (key, value)
values
  ('sequencer_paused', 'false'),
  ('daily_invite_limit', '30'),
  ('daily_profile_visit_limit', '50')
on conflict (key) do nothing;

create index if not exists idx_candidates_job_brief_id on candidates(job_brief_id);
create index if not exists idx_candidates_status on candidates(status);
create index if not exists idx_outreach_log_candidate_id on outreach_log(candidate_id);
create index if not exists idx_reply_log_candidate_id on reply_log(candidate_id);
create index if not exists idx_inbound_leads_created_at on inbound_leads(created_at desc);
create index if not exists idx_job_briefs_status on job_briefs(status);
