-- ============================================================================
-- projects 報驗需求欄位 Migration
-- ----------------------------------------------------------------------------
-- 用途：每個工程在報驗時的規則（自檢表模式、拍照張數、備註）。
--       這些規則過去只存在紙本表格上，現在改存 projects，報驗頁選完工程即顯示。
--
-- 設計說明：
--   * 協力商 → 沿用既有的 projects.company（鎮山／麗生），不另存
--   * 品管主辦 → 沿用既有的 projects.qc_manager，不另存
--   * 「同一工程做一份／封面分區分開」「申請日期=當天、檢驗日期=下一工作天」
--     全公司一致，寫在畫面上的固定說明，不入欄位
--
--   * NULL = 尚未建檔（畫面顯示灰色「未設定」，提醒去補）
--     '不限' = 已確認過業主沒有規定（畫面正常顯示「不限」）
--     兩者意義不同，請勿混用
--
-- 執行方式：到 Supabase → SQL Editor 貼上整段執行一次即可（可重複執行，安全）。
-- 執行後：欄位值一律留空，請到「BOM 工程列表 → 編輯工程 → 報驗需求」
--         或「報驗 → ① 選完工程後的需求卡 → ✎ 編輯」逐一填寫。
-- ============================================================================

alter table public.projects
  add column if not exists insp_photo_beam int,
  add column if not exists insp_photo_col  int,
  add column if not exists insp_sc_form    text,
  add column if not exists insp_sc_sign    text,
  add column if not exists insp_sc_color   text,
  add column if not exists insp_note       text;

comment on column public.projects.insp_photo_beam is '報驗需求：樑拍照張數（樑以批計）。NULL=未設定';
comment on column public.projects.insp_photo_col  is '報驗需求：柱拍照張數（柱以支計）。NULL=未設定';
comment on column public.projects.insp_sc_form    is '自檢表模式-自檢表：自檢表 / 製造圖蓋自檢章。NULL=未設定';
comment on column public.projects.insp_sc_sign    is '自檢表模式-是否手寫：便章 / 手寫。NULL=未設定';
comment on column public.projects.insp_sc_color   is '自檢表模式-字體顏色：黑色 / 藍色 / 不限。NULL=未設定';
comment on column public.projects.insp_note       is '報驗需求備註（自由文字）';

-- 確認結果：應列出上面 6 個欄位
select column_name, data_type
from information_schema.columns
where table_schema='public' and table_name='projects' and column_name like 'insp\_%'
order by column_name;
