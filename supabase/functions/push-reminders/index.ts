// 手機推播提醒(每天早上由 pg_cron 呼叫一次)
//  ・待辦:今天到期、明天到期、已逾期 → 個人待辦推給本人;團體待辦推給被指派的人(沒指派＝全體)
//  ・交管料日:3 個工作天內或已逾期(14 個工作天內)的工程區 → 推給有訂閱「交管料」的人
//  ・通知管理發佈的通知(含農曆每月循環):輪到的日子推給有訂閱「公司通知」的人
//  ・上線準備紅燈:網頁端算好的快照(push_ready_snapshot) → 推給有訂閱「上線準備」的人
// 另外支援 {mode:'test'}:登入者自己按「傳送測試通知」。
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

type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; topics: string[] | null };
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

  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'forbidden' }, 403);
  const today = taipeiToday();
  const subs = await rest('push_subscriptions?select=*') as Sub[];
  if (!subs.length) return json({ ok: true, today, subscriptions: 0 });
  const has = (s: Sub, t: string) => (s.topics || []).includes(t);

  const report: Record<string, number> = {};
  const todoMsgs = await buildTodoMessages(today, subs);
  for (const [u, msg] of Object.entries(todoMsgs)) {
    const mine = subs.filter(s => s.user_id === u && has(s, 'todo'));
    if (mine.length) { await deliver(mine, msg, stats); report.todo = (report.todo || 0) + 1; }
  }
  const hand = await buildHandoverMessage(today);
  if (hand) { const t = subs.filter(s => has(s, 'handover')); await deliver(t, hand, stats); report.handover = t.length; }
  const notices = await buildNoticeMessages(today).catch(e => { console.warn('notices', e); return [] as Msg[]; });
  if (notices.length) { const t = subs.filter(s => has(s, 'notice')); for (const m of notices) await deliver(t, m, stats); report.notice = notices.length; }
  const ready = await buildReadyMessage(today).catch(e => { console.warn('ready snapshot', e); return null; });
  if (ready) { const t = subs.filter(s => has(s, 'ready')); await deliver(t, ready, stats); report.ready = t.length; }

  return json({ ok: true, today, subscriptions: subs.length, report, ...stats });
});
