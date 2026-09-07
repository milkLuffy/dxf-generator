-- 工程區「轉包」狀態 —— 只有在 zones.status 被 CHECK 限制擋住時才需要執行
--
-- 症狀:在「BOM 工程列表 → 工程區」按「轉包」時跳出
--       工程區狀態存檔失敗(400)…violates check constraint
-- 原因:zones.status 上有一條只允許「未開始/進行中/已完成」的 CHECK,擋掉新的「轉包」。
-- 做法:把 status 上的 CHECK 拿掉(值由 App 端控管),不動任何資料。
-- 這支可以重複執行;沒有該限制時什麼都不會做。

do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.zones'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.zones drop constraint %I', c.conname);
    raise notice '已移除 zones 的 status 檢查限制:%', c.conname;
  end loop;
end $$;

-- 確認:應該看不到任何含 status 的 check
select conname, pg_get_constraintdef(oid) as def
  from pg_constraint
 where conrelid = 'public.zones'::regclass
   and contype = 'c';
