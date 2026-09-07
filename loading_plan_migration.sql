-- ============================================================
--  月產量排程(LOADING 會議)
--  在 Supabase SQL Editor 執行一次即可;可重複執行。
--
--  設計重點
--   1. 吊裝期 / 交管料日是「工程區」的屬性(一個節區只吊裝一次)→ 直接加在 zones 上。
--      handover_date 留 NULL 代表「自動 = 吊裝期往前 5 個工作天」,
--      填了值就是人工指定(會議上常常會調整,不一定剛好五天)。自動/手動由 App 顯示。
--   2. 同一個工程區可能分 2~3 個月做完 → 每月排定量另外一張 loading_plan(ym + zone_id 唯一)。
--      「本月做多少」是計畫值(加入時預設帶整區 BOM 重量);實際完成一律由 daily_output 即時算,
--      不存這裡,免得兩邊對不起來。產量月採 26 日~次月 25 日。
--   3. 誰改了排程 → 由前端 sbFetch 攔截寫入的 audit_log 自動留痕,這裡不另存。
-- ============================================================

create extension if not exists pgcrypto;

-- ── 1. 工程區:吊裝期與交管料日 ────────────────────────────────
alter table public.zones add column if not exists erect_date    date;
alter table public.zones add column if not exists handover_date date;

comment on column public.zones.erect_date    is '吊裝期(工地吊裝日)';
comment on column public.zones.handover_date is '交管料日;NULL = 依吊裝期往前 5 個工作天自動推算';

create index if not exists zones_erect_date_idx    on public.zones(erect_date);
create index if not exists zones_handover_date_idx on public.zones(handover_date);

-- ── 2. 每月排定量 ────────────────────────────────────────────
-- zone_id 的型別直接跟著 zones.id 走(有的環境是 bigint、有的是 integer),
-- 寫死型別會讓外鍵建不起來,所以這裡動態取。
do $$
declare zid_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into zid_type
    from pg_attribute a
   where a.attrelid = 'public.zones'::regclass and a.attname = 'id' and a.attnum > 0;

  execute format($f$
    create table if not exists public.loading_plan (
      id              uuid primary key default gen_random_uuid(),
      ym              text not null,                       -- 'YYYY-MM' 產量月(該月 26 日~次月 25 日)
      zone_id         %s   not null references public.zones(id) on delete cascade,
      plan_tons       numeric,                             -- 本月排定噸數(空=以整區 BOM 重量計)
      plan_qty        integer,                             -- 本月排定支數(選填)
      note            text,
      created_by      uuid default auth.uid(),
      created_by_name text,
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now(),
      constraint loading_plan_ym_chk check (ym ~ '^[0-9]{4}-[0-9]{2}$'),
      constraint loading_plan_uniq unique (ym, zone_id)
    )$f$, zid_type);
end $$;

-- 這個月的狀況說明(沒達標的原因);後補的欄位,舊環境重跑本檔即可
alter table public.loading_plan add column if not exists issue text;
comment on column public.loading_plan.issue is '該月狀況說明/沒達標的原因(點工程編號-工程區填寫)';

create index if not exists loading_plan_ym_idx   on public.loading_plan(ym);
create index if not exists loading_plan_zone_idx on public.loading_plan(zone_id);

create or replace function public.loading_plan_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists loading_plan_touch_trg on public.loading_plan;
create trigger loading_plan_touch_trg before update on public.loading_plan
  for each row execute function public.loading_plan_touch();

-- ── 3. RLS:生產排程是公司共同資料,登入者都能看與改(誰改了看操作紀錄) ──
alter table public.loading_plan enable row level security;

drop policy if exists loading_plan_select on public.loading_plan;
drop policy if exists loading_plan_insert on public.loading_plan;
drop policy if exists loading_plan_update on public.loading_plan;
drop policy if exists loading_plan_delete on public.loading_plan;

create policy loading_plan_select on public.loading_plan for select to authenticated using ( true );
create policy loading_plan_insert on public.loading_plan for insert to authenticated with check ( true );
create policy loading_plan_update on public.loading_plan for update to authenticated using ( true ) with check ( true );
create policy loading_plan_delete on public.loading_plan for delete to authenticated using ( true );

grant select, insert, update, delete on public.loading_plan to authenticated;

-- ── 確認 ────────────────────────────────────────────────────
select column_name, data_type
  from information_schema.columns
 where table_schema='public' and table_name='zones' and column_name in ('erect_date','handover_date');

select column_name, data_type
  from information_schema.columns
 where table_schema='public' and table_name='loading_plan'
 order by ordinal_position;
