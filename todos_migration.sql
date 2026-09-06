-- ============================================================
--  待辦事項 todos  (個人 / 團體)
--  在 Supabase SQL Editor 執行一次即可;可重複執行。
--
--  設計重點
--   1. 單一資料表 + scope 欄位分流(personal / team),不分兩張表。
--   2. 完成不刪除:status 改成 'done',並蓋上 done_at / done_by / done_by_name,
--      主頁只查 status='open'(所以會「消失」),歷史紀錄查 status='done'。
--   3. 個人待辦由 RLS 保證只有自己看得到 —— 連管理員也看不到。
--   4. 團體待辦「任何人勾完成即整條結案」,所以 update 開放給所有登入者。
--   5. 誰改了期限 / 誰重開 —— 由前端 sbFetch 攔截寫入的 audit_log 自動留痕,這裡不另存。
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.todos (
  id              uuid primary key default gen_random_uuid(),
  scope           text not null default 'personal',      -- personal | team
  title           text not null,
  note            text,
  due_date        date,                                   -- deadline(只到日)
  priority        text not null default '一般',           -- 一般 | 重要 | 緊急
  priority_rank   int  not null default 1,                -- 1/2/3,排序用
  status          text not null default 'open',           -- open | done | cancelled
  owner_id        uuid not null default auth.uid(),       -- personal:擁有者;team:建立者
  assignee_ids    uuid[] not null default '{}'::uuid[],   -- team 指派對象(profiles.id);空陣列=全體
  proj_num        text,                                   -- 選填,關聯 projects.proj_num
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  done_at         timestamptz,
  done_by         uuid,
  done_by_name    text,
  constraint todos_scope_chk    check (scope    in ('personal','team')),
  constraint todos_status_chk   check (status   in ('open','done','cancelled')),
  constraint todos_priority_chk check (priority in ('一般','重要','緊急'))
);

create index if not exists todos_status_idx   on public.todos(status);
create index if not exists todos_due_idx      on public.todos(due_date);
create index if not exists todos_owner_idx    on public.todos(owner_id);
create index if not exists todos_scope_idx    on public.todos(scope);
create index if not exists todos_assignee_idx on public.todos using gin(assignee_ids);

-- updated_at 自動更新
create or replace function public.todos_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists todos_touch_trg on public.todos;
create trigger todos_touch_trg before update on public.todos
  for each row execute function public.todos_touch();

-- ── 權限判斷小函式 ────────────────────────────────────────────
-- security definer:讀 profiles 時繞過 profiles 自己的 RLS,否則一般帳號查不到自己的 perms。
create or replace function public.todo_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- 能不能建立「團體待辦」:管理員,或帳號權限 perms->>'todo_team' = 'edit'
create or replace function public.todo_can_team() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_admin or (p.perms->>'todo_team') = 'edit'
                     from public.profiles p where p.id = auth.uid()), false);
$$;

-- ── RLS ──────────────────────────────────────────────────────
alter table public.todos enable row level security;

drop policy if exists todos_select on public.todos;
drop policy if exists todos_insert on public.todos;
drop policy if exists todos_update on public.todos;
drop policy if exists todos_delete on public.todos;

-- 讀:團體待辦人人看得到;個人待辦只有自己(管理員也看不到)
create policy todos_select on public.todos for select to authenticated
  using ( scope = 'team' or owner_id = auth.uid() );

-- 建立:只能以自己的名義建立;團體待辦另需 todo_team 權限
create policy todos_insert on public.todos for insert to authenticated
  with check ( owner_id = auth.uid() and ( scope = 'personal' or public.todo_can_team() ) );

-- 更新:個人待辦只有自己;團體待辦所有登入者都能改
--       (因為「任何一個人勾完成就結案」;內容編輯的限制由前端按建立者/管理員把關)
create policy todos_update on public.todos for update to authenticated
  using      ( owner_id = auth.uid() or scope = 'team' )
  with check ( owner_id = auth.uid() or scope = 'team' );

-- 刪除:只有建立者或管理員
create policy todos_delete on public.todos for delete to authenticated
  using ( owner_id = auth.uid() or public.todo_is_admin() );

grant select, insert, update, delete on public.todos to authenticated;

-- ── 指派對象清單 ─────────────────────────────────────────────
-- profiles 只有管理員讀得到,但「指派給誰」需要一般帳號也看得到人名。
-- 因此開一個只吐 id + 顯示名稱 + 部門的 view(不含 perms / is_admin / email 等欄位)。
-- 顯示名稱優先用「綁定的公司名冊姓名」,沒綁定才退回帳號自己的顯示名稱 / Google 帳號。
drop view if exists public.todo_users;
create view public.todo_users as
  select p.id,
         coalesce(nullif(s.name,''), nullif(p.name,''), p.account) as name,
         s.department as department
    from public.profiles p
    left join public.staff s on s.id = p.staff_id
   where coalesce(p.disabled, false) = false
     and coalesce(p.status, 'active') <> 'pending';

grant select on public.todo_users to authenticated;

-- 完成

-- ============================================================
--  v2:重複待辦(每天 / 每週 / 每月)
--
--  做法:規則本身存成一筆「範本」(is_template = true,不會出現在待辦清單),
--  時間一到由 todo_materialize_recurring() 長出當天那一筆真正的待辦
--  (parent_id 指回範本)。長出來的就是普通待辦 —— 勾完成、歷史紀錄、
--  指派、鈴鐺提醒全部沿用原本那一套,不必另外寫一套重複邏輯。
--
--  誰來長?沒有排程器,所以「任何人開啟頁面時」呼叫一次這個函式。
--  (parent_id, due_date) 有唯一索引,兩個人同時開也只會長出一筆。
-- ============================================================

alter table public.todos add column if not exists is_template     boolean not null default false;
alter table public.todos add column if not exists parent_id       uuid;
alter table public.todos add column if not exists repeat_unit     text not null default 'none';
alter table public.todos add column if not exists repeat_interval int  not null default 1;
alter table public.todos add column if not exists repeat_from     date;
alter table public.todos add column if not exists repeat_until    date;

do $$ begin
  alter table public.todos add constraint todos_repeat_unit_chk
    check (repeat_unit in ('none','day','week','month'));
exception when duplicate_object then null; end $$;

-- 刪掉規則時,已經長出來的待辦要留著(歷史紀錄不能跟著消失)→ set null,不是 cascade
do $$ begin
  alter table public.todos add constraint todos_parent_fk
    foreign key (parent_id) references public.todos(id) on delete set null;
exception when duplicate_object then null; end $$;

-- 同一條規則、同一天只會有一筆(擋掉多人同時開頁面的重複長出)
create unique index if not exists todos_occurrence_uidx on public.todos(parent_id, due_date);
create index if not exists todos_template_idx on public.todos(is_template) where is_template;

create or replace function public.todo_materialize_recurring()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  t        record;
  d        date;
  step     interval;
  guard    int;
  ddiff    int;
  mdiff    int;
  made     int  := 0;
  today    date := current_date;
  earliest date := current_date - 60;   -- 最多回補 60 天,避免舊規則一次灌出幾百筆
begin
  for t in
    select * from public.todos
     where is_template
       and repeat_unit <> 'none'
       and coalesce(status,'open') = 'open'
  loop
    if coalesce(t.repeat_interval,1) < 1 then continue; end if;
    step := case t.repeat_unit
              when 'day'   then (t.repeat_interval       || ' day')::interval
              when 'week'  then (t.repeat_interval * 7   || ' day')::interval
              when 'month' then (t.repeat_interval       || ' month')::interval
            end;
    if step is null then continue; end if;

    d := coalesce(t.repeat_from, t.due_date, t.created_at::date);

    -- 先快轉到回補窗口附近:否則「每天」的舊規則會在 guard 次數內走不到今天,永遠長不出來
    if d < earliest then
      if t.repeat_unit = 'day' then
        ddiff := (earliest - d) / t.repeat_interval;
        if ddiff > 0 then d := d + (ddiff * t.repeat_interval); end if;
      elsif t.repeat_unit = 'week' then
        ddiff := (earliest - d) / (t.repeat_interval * 7);
        if ddiff > 0 then d := d + (ddiff * t.repeat_interval * 7); end if;
      else
        mdiff := ((extract(year from earliest)::int - extract(year from d)::int) * 12
                + (extract(month from earliest)::int - extract(month from d)::int)) / t.repeat_interval;
        if mdiff > 0 then d := (d + ((mdiff * t.repeat_interval) || ' month')::interval)::date; end if;
      end if;
    end if;

    guard := 0;
    while d <= today and guard < 600 loop
      guard := guard + 1;
      exit when t.repeat_until is not null and d > t.repeat_until;
      if d >= earliest then
        insert into public.todos
          (scope, title, note, due_date, priority, priority_rank, status,
           owner_id, assignee_ids, proj_num, created_by_name, parent_id)
        values
          (t.scope, t.title, t.note, d, t.priority, t.priority_rank, 'open',
           t.owner_id, t.assignee_ids, t.proj_num, t.created_by_name, t.id)
        on conflict (parent_id, due_date) do nothing;
        if found then made := made + 1; end if;
      end if;
      d := (d + step)::date;
    end loop;
  end loop;
  return made;
end $$;

grant execute on function public.todo_materialize_recurring() to authenticated;

-- 完成
