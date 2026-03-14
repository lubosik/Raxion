alter table jobs add column if not exists outreach_templates jsonb default '{}'::jsonb;
