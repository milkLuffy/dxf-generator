-- ═══════════════════════════════════════════════════════════════════
-- 保留料:新增「退還日期」欄位
--
-- 目的:目前保留料只有「是否退還(need_return)」這個是/否欄,
--       沒有地方登記「退了沒」。所以只要填了領取日期,整筆就被當成
--       完成而收起來——即使那筆還欠著沒退還。
--
--       加上退還日期後,完成的判定改成:
--         已領取 且 (不需退還 或 已退還) = 整筆完成
--       已領取但還沒退還的會留在清單裡,只是狀態顯示「已領取・待退還」。
--
-- 安全性:本檔只新增欄位、不動既有資料;欄位可留空(NULL)。
--         程式端會自動偵測欄位是否存在——沒跑這支 SQL 前,
--         「退還日期」欄不會出現也不會送出,行為與現在完全相同
--         (此時仍以「有領取日期」當完成,同現況)。
--
-- 執行方式:Supabase → SQL Editor → 貼上執行。可重複執行(IF NOT EXISTS)。
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE reserved_material ADD COLUMN IF NOT EXISTS return_date date;   -- 退還日期

COMMENT ON COLUMN reserved_material.return_date IS '退還日期(留空=尚未退還;僅在需退還時有意義)';

-- 驗證:應可看到新欄位
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name = 'reserved_material' AND column_name = 'return_date';
