-- ─────────────────────────────────────────────────────────────
-- 計價表雲端儲存 (pricing_sheets)
--
-- 在 Supabase SQL Editor 執行一次即可。
-- 未執行前,計價頁按「儲存」會明確跳出提示,並暫時只存在本機瀏覽器。
--
-- 背景:計價表原本只存在瀏覽器 localStorage,換電腦、換瀏覽器、清除瀏覽資料
--       或本機空間滿時,整張表都會消失(且舊版儲存失敗還會顯示「已儲存」)。
--       這張表讓計價表跟其他資料一樣存在雲端。
--
-- 一張列 = 一個工程的一組計價表。sheet_key 例:
--   beam|pick|beam|6D            → 單獨選 6DG.6DB 的大小樑表
--   beam|pick|beam|6D,beam|7D    → 同時選 6D、7D 兩組時的合併表
--   col|pick|col|6              /  misc|pick|<zone_id>
-- ─────────────────────────────────────────────────────────────

-- 註:projects.id 若不是整數(例如 uuid),把下面的 project_id 型別一併改掉即可。
create table if not exists public.pricing_sheets (
  id           bigint generated always as identity primary key,
  project_id   bigint not null,
  sheet_key    text   not null,
  data         jsonb  not null default '{}'::jsonb,
  updated_by   uuid,
  updated_name text,
  updated_at   timestamptz not null default now(),
  constraint pricing_sheets_uniq unique (project_id, sheet_key)
);

create index if not exists pricing_sheets_project_idx on public.pricing_sheets (project_id);

-- 工程刪除時一併清掉計價表。projects.id 型別若與 bigint 不相容(例如 uuid),
-- 這段會自動略過,不影響上面的建表;要的話再依實際型別自行補上。
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pricing_sheets_project_fk'
  ) then
    begin
      alter table public.pricing_sheets
        add constraint pricing_sheets_project_fk
        foreign key (project_id) references public.projects(id) on delete cascade;
    exception when others then
      raise notice '略過 pricing_sheets 的外鍵 (projects.id 型別不相容): %', sqlerrm;
    end;
  end if;
end $$;

-- RLS:登入後即可讀寫(計價頁本身已限管理員可見)。
-- 若要再收緊成「只有特定角色可寫」,改 using / with check 的條件即可。
alter table public.pricing_sheets enable row level security;

drop policy if exists pricing_sheets_read  on public.pricing_sheets;
drop policy if exists pricing_sheets_write on public.pricing_sheets;

create policy pricing_sheets_read on public.pricing_sheets
  for select to authenticated using (true);

create policy pricing_sheets_write on public.pricing_sheets
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.pricing_sheets to authenticated;
