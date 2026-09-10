-- ============================================================
--  上線準備(工程區詳情頁「上線準備」＋水電靠模「已開單」)
--  在 Supabase SQL Editor 執行一次即可;可重複執行。
--  前置:loading_plan_migration.sql(zones.erect_date / handover_date)
--
--  日期鏈:吊裝期 → 交管料日(−5 工作天) → 預計上線日(−1 個月) → 準備期限(−2 週)
--   * online_date 留 NULL = 自動由交管料日往前推 1 個月;填了值就是人工指定(白板排的時段)。
--  六盞燈裡只有「圖面審核」與「削翼靠模已開單」需要人工勾選,其餘都由既有資料即時判斷,不存表。
-- ============================================================

-- ── 1. 工程區 ────────────────────────────────────────────────
alter table public.zones add column if not exists online_date   date;
alter table public.zones add column if not exists drawing_ok_at timestamptz;
alter table public.zones add column if not exists drawing_ok_by text;
alter table public.zones add column if not exists jig_util      boolean;
alter table public.zones add column if not exists jig_bevel     boolean;
alter table public.zones add column if not exists bevel_jig_at  timestamptz;
alter table public.zones add column if not exists bevel_jig_by  text;

comment on column public.zones.online_date   is '預計上線日;NULL = 交管料日往前推 1 個月自動計算';
comment on column public.zones.drawing_ok_at is '圖面審核 OK 的時間(NULL = 尚未審核)';
comment on column public.zones.drawing_ok_by is '圖面審核 OK 的人';
comment on column public.zones.jig_util      is '本區需要水電靠模;NULL = 自動(有水電重量/水電加工代號/有靠模產生紀錄)';
comment on column public.zones.jig_bevel     is '本區需要削翼靠模;NULL = 自動(該工程收圖登記有「削翼」)';
comment on column public.zones.bevel_jig_at  is '削翼靠模已開單的時間';
comment on column public.zones.bevel_jig_by  is '削翼靠模開單登記人';

create index if not exists zones_online_date_idx on public.zones(online_date);

-- ── 2. 水電靠模產生紀錄:已開單 ─────────────────────────────────
alter table public.gen_logs add column if not exists ordered_at timestamptz;
alter table public.gen_logs add column if not exists ordered_by text;

comment on column public.gen_logs.ordered_at is '已開單時間(NULL = 尚未開單)';
comment on column public.gen_logs.ordered_by is '勾選已開單的人';

-- 勾「已開單」是 UPDATE;原本 gen_logs 只有新增/刪除,補一條登入者可更新的規則
-- (誰勾的由前端寫入 ordered_by,另有 audit_log 留痕)。
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='public' and c.relname='gen_logs' and c.relrowsecurity) then
    execute 'drop policy if exists gen_logs_update_ordered on public.gen_logs';
    execute 'create policy gen_logs_update_ordered on public.gen_logs for update to authenticated using (true) with check (true)';
  end if;
end $$;
