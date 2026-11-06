create table settings(k text primary key, v text);
create table donations(id bigint generated always as identity primary key, mp_id text unique, amount numeric, name text, status text default 'pending', created timestamptz default now(), paid timestamptz);
create table media(id bigint generated always as identity primary key, file text, kind text, pos int default 0, is_main boolean default false);
create table updates(id bigint generated always as identity primary key, section text, title text, body text, created timestamptz default now());
alter table settings enable row level security; alter table donations enable row level security; alter table media enable row level security; alter table updates enable row level security;
insert into storage.buckets(id,name,public) values('media','media',true) on conflict do nothing;
