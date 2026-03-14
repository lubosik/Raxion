alter table jobs add column if not exists send_from text default '08:00';
alter table jobs add column if not exists send_until text default '18:00';
alter table jobs add column if not exists timezone text default 'Europe/London';
alter table jobs add column if not exists active_days text default 'Mon,Tue,Wed,Thu,Fri';
