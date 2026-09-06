-- ============================================================
--  請假登記 leave_requests
--  在 Supabase SQL Editor 執行一次即可;可重複執行。
--
--  用途:讓大家「事先登記」要請的假,全公司都看得到誰哪天不在。
--  刻意的設計取捨:
--   1. 沒有核准流程 —— 登記制,不擋人請假。
--   2. 誰都可以幫誰登記(公司只有辦公室人員用系統),但只有登記人/本人/管理員能改或刪。
--   3. 不自動寫進薪資 —— 正式紀錄的唯一來源仍然是「出勤回報 att_report」,
--      這裡只在出勤回報頁跳出提示 + 一鍵帶入,由填表的人確認。
--      (特休台帳的「已休」是從 att_report 算的,兩邊各寫一份會出現兩套數字。)
--   4. 事由(reason)只有登記人/本人/管理員看得到:
--      → 底層資料表的 select policy 只開放給這三種人,
--      → 另開 leave_board 檢視表(不含 reason)給全公司看「誰哪天不在」。
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.leave_requests (
  id              uuid primary key default gen_random_uuid(),
  staff_id        int,                                   -- 公司名冊 staff.id
  staff_name      text not null,                         -- 要與 att_report.staff_name 對得上才能一鍵帶入
  leave_type      text not null,                         -- 特休 / 事假 / 病假 …(與出勤回報的下拉同一組)
  start_date      date not null,
  end_date        date not null,
  day_part        text not null default 'full',          -- full 全天 | am 上午 | pm 下午 | hours 自訂
  hours           numeric(5,2) not null default 8,       -- 每一天的時數
  reason          text,
  created_by      uuid not null default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint leave_daypart_chk check (day_part in ('full','am','pm','hours')),
  constraint leave_range_chk   check (end_date >= start_date)
);

create index if not exists leave_start_idx on public.leave_requests(start_date);
create index if not exists leave_end_idx   on public.leave_requests(end_date);
create index if not exists leave_staff_idx on public.leave_requests(staff_name);

create or replace function public.leave_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists leave_touch_trg on public.leave_requests;
create trigger leave_touch_trg before update on public.leave_requests
  for each row execute function public.leave_touch();

-- 目前登入者綁定的公司名冊 id(判斷「這筆是不是我自己的假」)
create or replace function public.my_staff_id() returns int
language sql stable security definer set search_path = public as $$
  select p.staff_id from public.profiles p where p.id = auth.uid();
$$;

-- 管理員判斷(與待辦共用;todos_migration.sql 已建過就會直接沿用)
create or replace function public.todo_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

alter table public.leave_requests enable row level security;

drop policy if exists leave_select on public.leave_requests;
drop policy if exists leave_insert on public.leave_requests;
drop policy if exists leave_update on public.leave_requests;
drop policy if exists leave_delete on public.leave_requests;

-- 底層表(含事由)只有:登記的人、本人、管理員
create policy leave_select on public.leave_requests for select to authenticated
  using ( created_by = auth.uid()
          or (staff_id is not null and staff_id = public.my_staff_id())
          or public.todo_is_admin() );

-- 誰都可以登記(可代登記),但一定掛自己的名字
create policy leave_insert on public.leave_requests for insert to authenticated
  with check ( created_by = auth.uid() );

create policy leave_update on public.leave_requests for update to authenticated
  using      ( created_by = auth.uid() or (staff_id is not null and staff_id = public.my_staff_id()) or public.todo_is_admin() )
  with check ( created_by = auth.uid() or (staff_id is not null and staff_id = public.my_staff_id()) or public.todo_is_admin() );

create policy leave_delete on public.leave_requests for delete to authenticated
  using ( created_by = auth.uid() or (staff_id is not null and staff_id = public.my_staff_id()) or public.todo_is_admin() );

grant select, insert, update, delete on public.leave_requests to authenticated;

-- ── 全公司看得到的請假看板(不含事由)────────────────────────
drop view if exists public.leave_board;
create view public.leave_board as
  select id, staff_id, staff_name, leave_type, start_date, end_date, day_part, hours,
         created_by, created_by_name, created_at,
         (reason is not null and btrim(reason) <> '') as has_reason
    from public.leave_requests;

grant select on public.leave_board to authenticated;

-- 完成
