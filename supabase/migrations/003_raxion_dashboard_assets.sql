create table if not exists job_assets (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  name text not null,
  asset_type text not null check (asset_type in ('calendly', 'jd', 'video', 'image', 'link', 'other')),
  url text not null,
  description text,
  created_at timestamptz default now()
);

create index if not exists idx_job_assets_job_id on job_assets(job_id);
