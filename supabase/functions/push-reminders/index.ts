// 手機推播提醒(pg_cron 每 30 分鐘呼叫一次;每台裝置在自己設定的時間收每日提醒,預設 08:00)
//  ・待辦:今天到期、明天到期、已逾期 → 個人待辦推給本人;團體待辦推給被指派的人(沒指派＝全體)
//  ・交管料日:3 個工作天內或已逾期(14 個工作天內)的工程區 → 推給有訂閱「交管料」的人
//  ・通知管理發佈的通知(含農曆每月循環):輪到的日子推給有訂閱「公司通知」的人
//  ・上線準備紅燈:網頁端算好的快照(push_ready_snapshot) → 推給有訂閱「上線準備」的人
//  ・報驗完成(待出貨):台灣時間 13:00 推今天上午報驗、08:00 推前一天下午報驗,依柱位整理 → 訂閱「ship」的人
//    (也可帶 {mode:'ship', half:'am'|'pm', date:'YYYY-MM-DD'} 手動觸發)
//  ・每日提醒時間:push_subscriptions.remind_time(HH:MM,30 分鐘一格,空=08:00);daily_sent_on 記錄今天送過,排程重跑也不重複
// 另外支援:
//  ・{mode:'test'}    登入者自己按「傳送測試通知」
//  ・{mode:'approval', kind:'account'|'device'}
//    新帳號註冊、新裝置登記的當事人自己呼叫,即時推給所有管理員(手機關著也收得到)。
//    伺服器會再確認真的有那一筆待審核才送,所以不能拿來洗管理員的手機。
import { sendWebPush } from './webpush.js';
import { lunarOccurrences, loadTwCalendar } from './lunar.js';

const SUPA_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('PUSH_CRON_SECRET') || '';
const APP_URL = (Deno.env.get('APP_BASE_URL') || 'https://milkluffy.github.io/dxf-generator/').replace(/#.*$/, '');
const VAPID = {
  subject: Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com',
  publicKey: Deno.env.get('VAPID_PUBLIC_KEY') || '',
  privateJwk: JSON.parse(Deno.env.get('VAPID_PRIVATE_JWK') || '{}'),
};
const LD_BACK_WORKDAYS = 5;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; topics: string[] | null; remind_time?: string | null; daily_sent_on?: string | null };
type Msg = { title: string; body: string; tag: string; url: string };

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(SUPA_URL + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(path.split('?')[0] + ' HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.status === 204 ? null : res.json();
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// ── 日期(一律用台灣時間) ──
function taipeiToday() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
// 目前時段(往下取到 30 分鐘一格):08:14 → '08:00'、08:31 → '08:30'
function taipeiSlot() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return String(t.getUTCHours()).padStart(2, '0') + ':' + (t.getUTCMinutes() >= 30 ? '30' : '00');
}
const DEFAULT_REMIND = '08:00';
function remindSlotOf(s: Sub) {
  const m = String(s.remind_time || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return DEFAULT_REMIND;
  return String(+m[1]).padStart(2, '0') + ':' + (+m[2] >= 30 ? '30' : '00');
}
function d(ymd: string) { return new Date(ymd + 'T00:00:00Z'); }
function iso(x: Date) { return x.toISOString().slice(0, 10); }
function addDays(ymd: string, n: number) { const x = d(ymd); x.setUTCDate(x.getUTCDate() + n); return iso(x); }
function daysBetween(a: string, b: string) { return Math.round((d(b).getTime() - d(a).getTime()) / 86400000); }
const isWorkday = (x: Date) => x.getUTCDay() !== 0;   // 只跳過週日,與網頁端 ldIsWorkday 相同
function workdayBack(ymd: string, n: number) {
  const x = d(ymd); let left = n;
  while (left > 0) { x.setUTCDate(x.getUTCDate() - 1); if (isWorkday(x)) left--; }
  return iso(x);
}
function workdaysLeft(today: string, target: string) {
  const t = d(today), e = d(target); let n = 0; const x = new Date(t < e ? t : e);
  if (e >= t) { while (x < e) { x.setUTCDate(x.getUTCDate() + 1); if (isWorkday(x)) n++; } return n; }
  while (x < t) { x.setUTCDate(x.getUTCDate() + 1); if (isWorkday(x)) n--; }
  return n;
}
function md(ymd: string) { return ymd.slice(5).replace('-', '/'); }
function listBody(lines: string[], max = 4) {
  return lines.slice(0, max).join('\n') + (lines.length > max ? '\n…等 ' + lines.length + ' 項' : '');
}

async function buildTodoMessages(today: string, subs: Sub[]) {
  const todos = await rest('todos?status=eq.open&due_date=not.is.null&due_date=lte.' + addDays(today, 1) +
    '&select=id,scope,title,due_date,owner_id,assignee_ids,is_template') as any[];
  const todoUsers = [...new Set(subs.filter(s => (s.topics || []).includes('todo')).map(s => s.user_id))];
  const byUser: Record<string, { diff: number; text: string }[]> = {};
  for (const t of todos) {
    if (t.is_template) continue;
    const diff = daysBetween(today, String(t.due_date).slice(0, 10));
    const text = (diff < 0 ? '逾期 ' + (-diff) + ' 天' : diff === 0 ? '今天到期' : '明天到期') + '：' + (t.title || '');
    const assignees: string[] = Array.isArray(t.assignee_ids) ? t.assignee_ids.map(String) : [];
    const who = t.scope === 'team' ? (assignees.length ? assignees : todoUsers) : [String(t.owner_id)];
    for (const u of who) (byUser[u] = byUser[u] || []).push({ diff, text: (t.scope === 'team' ? '[團體] ' : '') + text });
  }
  const out: Record<string, Msg> = {};
  for (const [u, items] of Object.entries(byUser)) {
    items.sort((a, b) => a.diff - b.diff);
    const late = items.filter(i => i.diff < 0).length;
    out[u] = {
      title: '⏰ 待辦提醒 ' + items.length + ' 件' + (late ? '(逾期 ' + late + ')' : ''),
      body: listBody(items.map(i => i.text)),
      tag: 'todo-' + today, url: APP_URL + '#/todo',
    };
  }
  return out;
}

async function buildHandoverMessage(today: string): Promise<Msg | null> {
  const [zones, projects] = await Promise.all([
    rest('zones?select=id,project_id,zone_code,status,erect_date,handover_date&or=(erect_date.not.is.null,handover_date.not.is.null)') as Promise<any[]>,
    rest('projects?select=id,proj_num') as Promise<any[]>,
  ]);
  const projById: Record<string, string> = {};
  projects.forEach(p => { projById[String(p.id)] = String(p.proj_num || '').trim(); });
  const rows = zones
    .filter(z => !['已完成', '轉包'].includes(String(z.status || '').trim()))
    .map(z => {
      const h = String(z.handover_date || '').slice(0, 10) || (z.erect_date ? workdayBack(String(z.erect_date).slice(0, 10), LD_BACK_WORKDAYS) : '');
      return { name: (projById[String(z.project_id)] || '') + '-' + String(z.zone_code || '').trim(), h, left: h ? workdaysLeft(today, h) : null };
    })
    .filter(r => r.left != null && r.left <= 3 && r.left >= -14)
    .sort((a, b) => (a.left as number) - (b.left as number));
  if (!rows.length) return null;
  const late = rows.filter(r => (r.left as number) < 0).length;
  return {
    title: '🚚 交管料日提醒 ' + rows.length + ' 區' + (late ? '(逾期 ' + late + ')' : ''),
    body: listBody(rows.map(r => r.name + ' ' + md(r.h) + ' ' + ((r.left as number) < 0 ? '逾期 ' + (-(r.left as number)) + ' 個工作天' : r.left === 0 ? '今天' : '剩 ' + r.left + ' 個工作天'))),
    tag: 'handover-' + today, url: APP_URL + '#/loading',
  };
}

async function buildReadyMessage(today: string): Promise<Msg | null> {
  const rows = await rest('push_ready_snapshot?id=eq.1&select=items,updated_at') as any[];
  const snap = rows[0];
  if (!snap || !Array.isArray(snap.items) || !snap.items.length) return null;
  // 快照是網頁端開啟時算的;太久沒人開(超過 3 天)就不推,避免推過時的資料
  if (daysBetween(String(snap.updated_at).slice(0, 10), today) > 3) return null;
  const items = snap.items as { text: string }[];
  return {
    title: '🚩 上線準備逾期 ' + items.length + ' 區',
    body: listBody(items.map(i => i.text)),
    tag: 'ready-' + today, url: APP_URL + '#/dashboard',
  };
}

// 報驗完成(待出貨):規則同網頁「待出貨看板」
//  柱位=上線配置床位(D9~D10 取 D9、補兩位數 D09;空白=未排柱位),柱/樑看工程區尾字 C;預報構件不算
function bedLabel(bed: string) {
  const s = String(bed || '').trim();
  if (!s) return '未排柱位';
  const m = s.match(/^([A-Za-z]+)\s*(\d+)/);
  return m ? m[1].toUpperCase() + String(+m[2]).padStart(2, '0') : s;
}
function recvFmt(dd: string, tt: string) {
  const m = String(dd || '').match(/(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?\s*$/);
  if (!m) return '';
  const p2 = (x: string | number) => String(x).padStart(2, '0');
  const tm = String(tt || '').match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  return p2(m[1]) + '/' + p2(m[2]) + (tm ? ' ' + p2(tm[1]) + ':' + tm[2] : '');
}
async function buildShipMessage(date: string, half: 'am' | 'pm'): Promise<Msg | null> {
  const K = (a: unknown, b: unknown) => String(a || '').trim().toUpperCase() + '|' + String(b || '').trim().toUpperCase();
  const [daily, pre, layout, reports] = await Promise.all([
    rest('daily_output?date=eq.' + date + '&select=proj_num,zone_code,part_no,serial_no,inspect_time') as Promise<any[]>,
    rest('pre_inspections?select=proj_num,part_no') as Promise<any[]>,
    rest('layout_items?ship_date=is.null&select=proj_num,part_no,bed,status') as Promise<any[]>,
    rest('inspection_reports?report_date=eq.' + date + '&select=proj_num,serial_no,recv_date:snapshot->>recv_date,recv_time:snapshot->>recv_time') as Promise<any[]>,
  ]);
  const preKeys = new Set(pre.map(x => K(x.proj_num, x.part_no)));
  const bedOf = new Map<string, string>();
  for (const l of layout) { const k = K(l.proj_num, l.part_no); if (!bedOf.get(k) && String(l.bed || '').trim()) bedOf.set(k, String(l.bed)); }
  const recvOf = new Map<string, string>();
  for (const r of reports) { const t = recvFmt(r.recv_date, r.recv_time); if (t) recvOf.set(K(r.proj_num, r.serial_no), t); }
  const beds = new Map<string, { beam: number; col: number; projs: Set<string> }>();
  const recvs = new Set<string>();
  let total = 0;
  for (const r of daily) {
    const t = String(r.inspect_time || '');
    const isPm = t >= '12:00';
    if ((half === 'pm') !== isPm) continue;
    const k = K(r.proj_num, r.part_no);
    if (preKeys.has(k)) continue;
    const bedRaw = bedOf.get(k) || '';
    if (/^HOLD$/i.test(bedRaw.trim())) continue;
    const bed = bedLabel(bedRaw);
    const g = beds.get(bed) || { beam: 0, col: 0, projs: new Set<string>() };
    if (/C$/i.test(String(r.zone_code || '').trim())) g.col++; else g.beam++;
    g.projs.add(String(r.proj_num || '').trim());
    beds.set(bed, g);
    const rv = recvOf.get(K(r.proj_num, r.serial_no)); if (rv) recvs.add(rv);
    total++;
  }
  if (!total) return null;
  const order = [...beds.keys()].sort((a, b) => a === '未排柱位' ? 1 : b === '未排柱位' ? -1 : a.localeCompare(b, undefined, { numeric: true }));
  const lines = order.map(b => {
    const g = beds.get(b)!;
    return b + '：' + [g.beam ? '樑 ' + g.beam : '', g.col ? '柱 ' + g.col : ''].filter(Boolean).join('・') + '（' + [...g.projs].sort().join('、') + '）';
  });
  const rv = [...recvs].sort();
  const head = rv.length ? '受檢 ' + rv[0] + (rv.length > 1 ? ' 等' : '') + '\n' : '';
  return {
    title: '📦 報驗完成 ' + total + ' 支 · ' + order.length + ' 個柱位',
    body: head + listBody(lines, 3),
    tag: 'ship-' + date + '-' + half, url: APP_URL + '#/layout/ship',
  };
}

// 通知管理(app_notifications):規則同網頁 manualNotificationOccurrence
async function buildNoticeMessages(today: string): Promise<Msg[]> {
  const rows = await rest('app_notifications?select=*&is_active=not.is.false') as any[];
  const needCal = rows.some(n => n.recurrence_unit === 'lunar' && n.skip_holidays);
  const y = +today.slice(0, 4);
  const isHoliday = needCal ? await loadTwCalendar([y, y + 1]) : () => false;
  const out: Msg[] = [];
  for (const n of rows) {
    const start = String(n.starts_at || n.created_at || today).slice(0, 10), end = n.expires_at ? String(n.expires_at).slice(0, 10) : '';
    if (today < start || (end && today > end)) continue;
    const unit = n.recurrence_unit || 'none', interval = Math.max(1, parseInt(n.recurrence_interval) || 1);
    const icon = n.priority === '緊急' ? '🚨 ' : n.priority === '重要' ? '❗ ' : unit === 'lunar' ? '🙏 ' : '🔔 ';
    const push = (extra: string, key: string) => out.push({
      title: icon + (n.title || '通知'), body: [extra, n.message || ''].filter(Boolean).join('\n'),
      tag: 'notice-' + n.id + '-' + key, url: APP_URL + '#/dashboard',
    });
    if (unit === 'lunar') { for (const o of lunarOccurrences(n, today, isHoliday)) push(o.text, o.key); continue; }
    const diff = daysBetween(start, today);
    if (unit === 'none') { if (diff === 0) push('', today); continue; }   // 不循環:只在開始當天推一次
    if (unit === 'day' && diff % interval === 0) push('', today);
    if (unit === 'week' && diff % (interval * 7) === 0) push('', today);
    if (unit === 'month') {
      const md = (+today.slice(0, 4) - +start.slice(0, 4)) * 12 + (+today.slice(5, 7) - +start.slice(5, 7));
      const last = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).getUTCDate();
      if (md % interval === 0 && +today.slice(8, 10) === Math.min(+start.slice(8, 10), last)) push('', today);
    }
  }
  return out;
}

async function deliver(subs: Sub[], msg: Msg, stats: { sent: number; failed: number; removed: number }) {
  for (const s of subs) {
    try {
      const res = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, msg, VAPID, { topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) });
      if (res.ok) { stats.sent++; continue; }
      stats.failed++;
      if (res.status === 404 || res.status === 410) {   // 訂閱已失效(移除 App、關閉通知)
        await rest('push_subscriptions?id=eq.' + s.id, { method: 'DELETE' });
        stats.removed++;
      } else console.warn('push failed', res.status, (await res.text()).slice(0, 200));
    } catch (e) { stats.failed++; console.warn('push error', e); }
  }
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!VAPID.publicKey || !VAPID.privateJwk.d) return json({ error: 'VAPID 金鑰尚未設定' }, 500);
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* 空 body */ }
  const stats = { sent: 0, failed: 0, removed: 0 };

  // 測試通知:用登入者自己的 token 驗證身分,只推給自己
  if (body.mode === 'test') {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const ur = await fetch(SUPA_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token } });
    if (!ur.ok) return json({ error: '請先登入' }, 401);
    const user = await ur.json();
    const subs = await rest('push_subscriptions?user_id=eq.' + user.id + '&select=*') as Sub[];
    if (!subs.length) return json({ error: '這個帳號還沒有開啟推播的裝置' }, 404);
    await deliver(subs, { title: '✅ 推播測試成功', body: '之後的待辦、交管料日與上線準備提醒會用這種方式通知您。', tag: 'test', url: APP_URL }, stats);
    return json({ ok: true, devices: subs.length, ...stats });
  }

  // 待審核即時推播:新帳號/新裝置的「當事人自己」呼叫,帶自己的 token。
  // 伺服器會再查一次「真的有這一筆待審核」才推 —— 不然任何登入者都能拿它洗管理員的手機。
  // 管理員一律收得到,不看訂閱主題:審核是職責,不是可選的提醒。
  if (body.mode === 'approval') {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const ur = await fetch(SUPA_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token } });
    if (!ur.ok) return json({ error: '請先登入' }, 401);
    const user = await ur.json();
    const me = (await rest('profiles?id=eq.' + user.id + '&select=id,name,account,status') as any[])[0] || null;
    const who = (me && (me.name || me.account)) || '某帳號';
    const kind = body.kind === 'device' ? 'device' : 'account';
    let msg: Msg | null = null;
    if (kind === 'account') {
      if (!me || me.status !== 'pending') return json({ ok: true, skipped: 'no pending account' });
      msg = { title: '👤 有新帳號等待審核', body: who + '(' + (me.account || '') + ')申請使用系統', tag: 'approval-account', url: APP_URL };
    } else {
      const devs = await rest('user_devices?user_id=eq.' + user.id + '&approved=is.false&select=device_key,ua,first_seen&order=first_seen.desc&limit=1')
        .catch(() => []) as any[];
      if (!devs.length) return json({ ok: true, skipped: 'no pending device' });
      const code = String(devs[0].device_key || '').slice(0, 8).toUpperCase();
      msg = { title: '💻 有新裝置等待核准', body: who + ' 的新裝置  裝置代碼 ' + code, tag: 'approval-device', url: APP_URL };
    }
    const admins = (await rest('profiles?is_admin=is.true&select=id,disabled') as any[]).filter(a => !a.disabled);
    if (!admins.length) return json({ ok: true, admins: 0 });
    const adminSubs = await rest('push_subscriptions?user_id=in.(' + admins.map(a => a.id).join(',') + ')&select=*') as Sub[];
    // 自己就是管理員的話不推給自己(例如管理員換一台電腦登入)
    const targets = adminSubs.filter(s => s.user_id !== user.id);
    if (targets.length) await deliver(targets, msg, stats);
    return json({ ok: true, kind, admins: admins.length, devices: targets.length, ...stats });
  }

  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'forbidden' }, 403);
  const today = taipeiToday();
  const subs = await rest('push_subscriptions?select=*') as Sub[];
  if (!subs.length) return json({ ok: true, today, subscriptions: 0 });
  const has = (s: Sub, t: string) => (s.topics || []).includes(t);

  const slot = taipeiSlot();
  const out: Record<string, unknown> = { ok: true, today, slot, subscriptions: subs.length };

  // 報驗完成(待出貨):固定 13:00 推今天上午、08:00 推前一天下午;或手動帶 mode:'ship'
  if (body.mode === 'ship' || (body.mode !== 'daily' && (slot === '08:00' || slot === '13:00'))) {
    const half: 'am' | 'pm' = body.half === 'am' || body.half === 'pm' ? body.half : (slot === '13:00' ? 'am' : 'pm');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : (half === 'am' ? today : addDays(today, -1));
    const msg = await buildShipMessage(date, half).catch(e => { console.warn('ship', e); return null; });
    const t = subs.filter(s => has(s, 'ship'));
    if (msg && t.length) await deliver(t, msg, stats);
    out.ship = { date, half, title: msg ? msg.title : null, devices: t.length };
    if (body.mode === 'ship') return json({ ...out, ...stats });
  }

  // 每日提醒:只送「設定時間 = 目前時段、今天還沒送過」的裝置;手動帶 mode:'daily' 則全部送(測試用,不看時間)
  const due = subs.filter(s => body.mode === 'daily' || (remindSlotOf(s) === slot && String(s.daily_sent_on || '') !== today));
  out.dailyDue = due.length;
  if (due.length) {
    const report: Record<string, number> = {};
    const todoMsgs = await buildTodoMessages(today, subs);   // 團體待辦沒指派＝推給所有訂閱者,所以名單用全部訂閱
    for (const [u, msg] of Object.entries(todoMsgs)) {
      const mine = due.filter(s => s.user_id === u && has(s, 'todo'));
      if (mine.length) { await deliver(mine, msg, stats); report.todo = (report.todo || 0) + 1; }
    }
    const hand = await buildHandoverMessage(today);
    if (hand) { const t = due.filter(s => has(s, 'handover')); if (t.length) await deliver(t, hand, stats); report.handover = t.length; }
    const notices = await buildNoticeMessages(today).catch(e => { console.warn('notices', e); return [] as Msg[]; });
    if (notices.length) { const t = due.filter(s => has(s, 'notice')); if (t.length) for (const m of notices) await deliver(t, m, stats); report.notice = notices.length; }
    const ready = await buildReadyMessage(today).catch(e => { console.warn('ready snapshot', e); return null; });
    if (ready) { const t = due.filter(s => has(s, 'ready')); if (t.length) await deliver(t, ready, stats); report.ready = t.length; }
    out.report = report;
    if (body.mode !== 'daily') {
      // 標記今天已送;尚未跑 migration(沒有 daily_sent_on 欄)時略過,不影響推送
      await rest('push_subscriptions?id=in.(' + due.map(s => s.id).join(',') + ')', {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ daily_sent_on: today }),
      }).catch(e => console.warn('mark daily_sent_on', e));
    }
  }
  return json({ ...out, ...stats });
});
