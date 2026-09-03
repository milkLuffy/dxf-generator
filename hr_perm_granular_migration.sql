-- ════════════════════════════════════════════════════════════════════════════
-- hr_perm_granular_migration.sql   (2026-09-02)
--
-- 用途:讓帳號權限的「可視員工 = ✔ 指定名單（自己勾）」在**資料庫端**也擋得住。
--       沒有這支,指定名單只有前端畫面在擋,懂技術的人仍可直接打 API 讀到別人的薪資。
--
-- 安全性:這支**只新增**一個函式與三條 restrictive policy,
--         **不修改、不刪除**任何既有的函式(is_hr / hr_scope / dept_class)或既有政策。
--         restrictive policy 是與既有政策「AND」起來的 → 只會更嚴,不會更鬆。
--         沒有設定名單的帳號(全部 / 只辦公人員 / 只現場外勞)完全不受影響。
--
-- 執行:Supabase → SQL Editor 貼上整份執行。可重複執行(idempotent)。
-- 還原:見檔案最後的「還原」區塊。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 判斷目前登入者看不看得到某位員工 ──────────────────────────────────────
-- profiles.perms 內若有 payroll_staff 陣列(例:{"payroll_staff":[3,7,12]}),
-- 代表這個帳號只能看名單內的員工;沒有這個鍵就一律放行,交給既有的 hr_scope() 政策判斷。
create or replace function public.hr_can_see_staff(sid bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select case
    -- 沒有對應員工的資料列(staff_id 為空)不由這支把關
    when sid is null then true
    -- 管理員看全部
    when coalesce((select p.is_admin from profiles p where p.id = auth.uid()), false) then true
    -- 有指定名單 → 只有名單內的員工看得到
    when exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and jsonb_typeof(p.perms -> 'payroll_staff') = 'array'
    ) then exists (
      select 1
      from profiles p,
           lateral jsonb_array_elements_text(p.perms -> 'payroll_staff') as x(v)
      where p.id = auth.uid()
        and x.v = sid::text
    )
    -- 沒有名單 → 沿用既有的 all / office / field 政策,這裡放行
    else true
  end
$fn$;

comment on function public.hr_can_see_staff(bigint) is
  '帳號權限「可視員工=指定名單」的資料庫端把關;perms.payroll_staff 為陣列時只放行名單內的 staff_id。';

-- ── 2. 三張含 staff_id 的薪資表各加一條 restrictive policy ──────────────────
-- restrictive = 與既有政策 AND;既有的 is_hr() / hr_scope() 判斷完全保留。
do $do$
declare
  t text;
begin
  foreach t in array array['employee_pay', 'payslip', 'leave_ledger'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists hr_staff_list_restrict on public.%I', t);
      execute format(
        'create policy hr_staff_list_restrict on public.%I
           as restrictive for all to public
           using (public.hr_can_see_staff(staff_id))
           with check (public.hr_can_see_staff(staff_id))', t);
      raise notice '已套用 restrictive policy:%', t;
    else
      raise notice '找不到資料表,略過:%', t;
    end if;
  end loop;
end
$do$;

notify pgrst, 'reload schema';

-- ── 3. 驗證(可選,自己貼來跑)────────────────────────────────────────────────
-- 看政策裝好了沒:
--   select tablename, policyname, permissive from pg_policies
--    where policyname = 'hr_staff_list_restrict';
-- 看某個帳號的名單:
--   select account, perms -> 'payroll_staff' from profiles where account = 'xxx@gmail.com';

-- ── 4. 還原(想拿掉逐一勾選的資料庫把關時執行)──────────────────────────────
--   drop policy if exists hr_staff_list_restrict on public.employee_pay;
--   drop policy if exists hr_staff_list_restrict on public.payslip;
--   drop policy if exists hr_staff_list_restrict on public.leave_ledger;
--   drop function if exists public.hr_can_see_staff(bigint);
--   notify pgrst, 'reload schema';
