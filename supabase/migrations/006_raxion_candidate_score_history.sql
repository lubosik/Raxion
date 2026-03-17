alter table candidates add column if not exists latest_fit_score integer;
alter table candidates add column if not exists latest_fit_grade text;
alter table candidates add column if not exists latest_fit_rationale text;
alter table candidates add column if not exists latest_scored_at timestamptz;
alter table candidates add column if not exists best_scored_at timestamptz;

update candidates
set
  latest_fit_score = coalesce(latest_fit_score, fit_score),
  latest_fit_grade = coalesce(latest_fit_grade, fit_grade),
  latest_fit_rationale = coalesce(latest_fit_rationale, fit_rationale),
  latest_scored_at = coalesce(latest_scored_at, created_at),
  best_scored_at = coalesce(best_scored_at, created_at)
where fit_score is not null
  and (
    latest_fit_score is null
    or latest_fit_grade is null
    or latest_fit_rationale is null
    or latest_scored_at is null
    or best_scored_at is null
  );
