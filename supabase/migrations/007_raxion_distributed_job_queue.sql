create table if not exists job_execution_queue (
  id uuid primary key default gen_random_uuid(),
  queue_type text not null default 'job_cycle',
  job_id uuid not null references jobs(id) on delete cascade,
  priority integer not null default 100,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'completed', 'failed')),
  reason text,
  payload jsonb not null default '{}'::jsonb,
  available_at timestamptz not null default now(),
  claimed_by text,
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_job_execution_queue_lookup
  on job_execution_queue(queue_type, status, available_at, priority, created_at);

create unique index if not exists idx_job_execution_queue_active_unique
  on job_execution_queue(job_id, queue_type)
  where status in ('pending', 'claimed');

create or replace function touch_job_execution_queue_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_job_execution_queue_updated_at on job_execution_queue;
create trigger trg_touch_job_execution_queue_updated_at
before update on job_execution_queue
for each row
execute function touch_job_execution_queue_updated_at();

create or replace function enqueue_job_execution(
  p_job_id uuid,
  p_queue_type text default 'job_cycle',
  p_reason text default null,
  p_priority integer default 100,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
as $$
declare
  v_existing_id uuid;
  v_inserted_id uuid;
begin
  select id
    into v_existing_id
  from job_execution_queue
  where job_id = p_job_id
    and queue_type = p_queue_type
    and status in ('pending', 'claimed')
  order by created_at asc
  limit 1;

  if v_existing_id is not null then
    return v_existing_id;
  end if;

  insert into job_execution_queue(job_id, queue_type, reason, priority, payload)
  values (p_job_id, p_queue_type, p_reason, p_priority, coalesce(p_payload, '{}'::jsonb))
  returning id into v_inserted_id;

  return v_inserted_id;
end;
$$;

create or replace function claim_job_execution_batch(
  p_worker_id text,
  p_queue_type text default 'job_cycle',
  p_limit integer default 1,
  p_stale_seconds integer default 1200
)
returns setof job_execution_queue
language plpgsql
as $$
begin
  return query
  with reclaim as (
    update job_execution_queue
       set status = 'pending',
           claimed_by = null,
           claimed_at = null,
           started_at = null,
           available_at = now(),
           updated_at = now()
     where queue_type = p_queue_type
       and status = 'claimed'
       and claimed_at < now() - make_interval(secs => p_stale_seconds)
     returning id
  ),
  candidates as (
    select id
      from job_execution_queue
     where queue_type = p_queue_type
       and status = 'pending'
       and available_at <= now()
     order by priority asc, created_at asc
     limit p_limit
     for update skip locked
  )
  update job_execution_queue q
     set status = 'claimed',
         claimed_by = p_worker_id,
         claimed_at = now(),
         started_at = coalesce(q.started_at, now()),
         attempts = q.attempts + 1,
         updated_at = now()
    from candidates
   where q.id = candidates.id
   returning q.*;
end;
$$;

create or replace function complete_job_execution(
  p_queue_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
as $$
begin
  update job_execution_queue
     set status = 'completed',
         completed_at = now(),
         claimed_by = p_worker_id,
         updated_at = now()
   where id = p_queue_id;

  return found;
end;
$$;

create or replace function fail_job_execution(
  p_queue_id uuid,
  p_worker_id text,
  p_error_message text default null,
  p_retry_delay_seconds integer default 120
)
returns boolean
language plpgsql
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
begin
  select attempts, max_attempts
    into v_attempts, v_max_attempts
  from job_execution_queue
  where id = p_queue_id
  limit 1;

  if v_attempts is null then
    return false;
  end if;

  if v_attempts >= v_max_attempts then
    update job_execution_queue
       set status = 'failed',
           error_message = p_error_message,
           claimed_by = p_worker_id,
           completed_at = now(),
           updated_at = now()
     where id = p_queue_id;
  else
    update job_execution_queue
       set status = 'pending',
           error_message = p_error_message,
           claimed_by = null,
           claimed_at = null,
           started_at = null,
           available_at = now() + make_interval(secs => greatest(1, p_retry_delay_seconds)),
           updated_at = now()
     where id = p_queue_id;
  end if;

  return true;
end;
$$;
