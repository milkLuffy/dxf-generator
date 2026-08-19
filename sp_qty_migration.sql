-- ═══════════════════════════════════════════════════════════════════
-- SP 狀態表:新增「應備 / 已備」支數欄位
--
-- 目的:目前 SP 狀態表只有狀態(清點中/完成/送工地),沒有數量,
--       所以看板進度只能算「幾個 CP編號完成」,無法反映「20 支到了 12 支」。
--       加上這兩欄後,工程區小卡的進度條會自動改用真實支數計算。
--
-- 安全性:本檔只新增欄位、不動既有資料;欄位可留空(NULL),
--         留空的列不計入支數進度,行為與現在完全相同。
--         程式端會自動偵測欄位是否存在——沒跑這支 SQL 前,
--         「應備/已備」兩欄不會出現,系統一切照舊。
--
-- 執行方式:Supabase → SQL Editor → 貼上執行。可重複執行(IF NOT EXISTS)。
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE sp_track ADD COLUMN IF NOT EXISTS qty_need numeric;   -- 應備支數
ALTER TABLE sp_track ADD COLUMN IF NOT EXISTS qty_done numeric;   -- 已備支數

COMMENT ON COLUMN sp_track.qty_need IS '應備支數(留空=不計入支數進度)';
COMMENT ON COLUMN sp_track.qty_done IS '已備支數';

-- 驗證:應可看到兩個新欄位
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name = 'sp_track' AND column_name IN ('qty_need','qty_done');
