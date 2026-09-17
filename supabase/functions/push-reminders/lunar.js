// 農曆循環通知(與網頁 index.html 的 lunar* 函式同一套規則,改一邊要同步改另一邊)
//  ・每月農曆 X 日;遇假日(週六日＋國定假日,補班日算平日)提前到前一個平日
//  ・可選「前一天也提醒」:提醒日＝實際日期的前一個平日
const LUNAR_FMT = new Intl.DateTimeFormat('en-u-ca-chinese', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });
const LUNAR_MONTH = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '臘'];
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function ymdAdd(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function lunarOf(ymd) {
  let m = '', day = 0;
  for (const p of LUNAR_FMT.formatToParts(new Date(ymd + 'T12:00:00+08:00'))) {
    if (p.type === 'month') m = p.value;
    if (p.type === 'day') day = parseInt(p.value, 10);
  }
  return { month: parseInt(m, 10), leap: /bis/.test(m), day };
}
export function lunarDayName(d) {
  const n = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (d <= 10) return '初' + n[d];
  if (d < 20) return '十' + n[d - 10];
  if (d === 20) return '二十';
  if (d < 30) return '廿' + n[d - 20];
  return '三十';
}
export function lunarLabel(l) { return '農曆' + (l.leap ? '閏' : '') + LUNAR_MONTH[l.month - 1] + '月' + lunarDayName(l.day); }
export function mdw(ymd) { return (+ymd.slice(5, 7)) + '/' + (+ymd.slice(8, 10)) + '(' + WEEK[new Date(ymd + 'T12:00:00Z').getUTCDay()] + ')'; }
function prevWorkday(ymd, isHoliday) { let x = ymd, g = 0; while (isHoliday(x) && g++ < 20) x = ymdAdd(x, -1); return x; }

// 回傳今天要出的提醒:[{key, text}];n 需有 lunar_days、skip_holidays、remind_day_before
export function lunarOccurrences(n, today, isHoliday) {
  const days = (Array.isArray(n.lunar_days) ? n.lunar_days : []).map(Number).filter(d => d >= 1 && d <= 30);
  if (!days.length) return [];
  const out = [];
  for (let i = 0; i <= 20; i++) {   // 過年連假最長會往前推十來天
    const base = ymdAdd(today, i), l = lunarOf(base);
    if (!days.includes(l.day)) continue;
    const eff = n.skip_holidays ? prevWorkday(base, isHoliday) : base;
    const moved = eff !== base ? '(原 ' + mdw(base) + ' 遇假日提前)' : '';
    if (eff === today) out.push({ key: base, text: '今天 ' + mdw(eff) + ' ' + lunarLabel(l) + moved });
    else if (n.remind_day_before) {
      const pre = n.skip_holidays ? prevWorkday(ymdAdd(eff, -1), isHoliday) : ymdAdd(eff, -1);
      if (pre === today) out.push({ key: base + ':pre', text: (eff === ymdAdd(today, 1) ? '明天 ' : '') + mdw(eff) + ' ' + lunarLabel(l) + moved });
    }
  }
  return out;
}
export function lunarRuleLabel(n) {
  const days = (Array.isArray(n.lunar_days) ? n.lunar_days : []).map(Number).sort((a, b) => a - b);
  return '農曆每月' + days.map(lunarDayName).join('、') + (n.skip_holidays ? '(遇假日提前)' : '') + (n.remind_day_before ? '＋前一天' : '');
}
// 台灣行事曆(TaiwanCalendar 開放資料):isHoliday 已含週末、國定假日與補班
export async function loadTwCalendar(years) {
  const map = {};
  for (const y of years) {
    try {
      const r = await fetch('https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/' + y + '.json');
      if (!r.ok) continue;
      for (const d of await r.json()) { const s = String(d.date); map[s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8)] = !!d.isHoliday; }
    } catch (_) { /* 抓不到就退回只看週末 */ }
  }
  return ymd => (ymd in map) ? map[ymd] : [0, 6].includes(new Date(ymd + 'T12:00:00Z').getUTCDay());
}
