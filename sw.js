// 鎮山工程管理系統 — Service Worker(離線快取 + 推播)
// 主頁 index.html:先拿本機快取秒開,背景向 GitHub 確認有沒有新版;有新版就存起來並通知頁面顯示「重新載入」。
// 外部程式庫(網址帶版本號)、字型:第一次下載後就一直用本機那份。
// Supabase 資料庫與其他請求一律不經過快取。
const SHELL_CACHE = 'sc-shell-v1';
const LIB_CACHE = 'sc-lib-v1';
const KEEP = [SHELL_CACHE, LIB_CACHE];
const SCOPE = new URL(self.registration.scope);
const INDEX_URL = new URL('index.html', SCOPE).href;
const PRECACHE = ['assets/pwa/icon-192.png', 'assets/pwa/icon-512.png', 'assets/pwa/apple-touch-icon.png', 'manifest.webmanifest']
  .map(p => new URL(p, SCOPE).href);

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await Promise.all(PRECACHE.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    try {
      const r = await fetch(INDEX_URL, { cache: 'reload' });
      if (r.ok) await c.put(INDEX_URL, r);
    } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('sc-') && !KEEP.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

function isIndexNavigation(req, url) {
  if (req.mode !== 'navigate' || url.origin !== SCOPE.origin) return false;
  return url.pathname === SCOPE.pathname || url.pathname === SCOPE.pathname + 'index.html';
}
// 網址裡有固定版本號(@1.2.3)的 CDN 檔案內容不會變,可以永久用快取
function isImmutableLib(url) {
  if (url.hostname === 'fonts.gstatic.com') return true;
  return url.hostname === 'cdn.jsdelivr.net' && /\/npm\/[^/]*@\d[^/]*\//.test(url.pathname);
}

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (isIndexNavigation(req, url)) {
    const done = serveIndex();
    ev.respondWith(done.then(x => x.response));
    ev.waitUntil(done.then(x => x.refresh).catch(() => {}));   // 先回快取,背景更新要在同步階段登記才不會被瀏覽器提早結束
    return;
  }
  if (isImmutableLib(url)) { ev.respondWith(cacheFirst(req)); return; }
  if (url.hostname === 'fonts.googleapis.com') { ev.respondWith(staleWhileRevalidate(req)); return; }
  if (url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname + 'assets/')) { ev.respondWith(staleWhileRevalidate(req)); return; }
});

// index.html 裡的 <meta name="sc-version" content="...">,拿來顯示「系統已更新 X 版」
const VERSION_RE = /<meta\s+name=["']sc-version["']\s+content=["']([^"']+)["']/i;
function versionOf(text) {
  const m = text && text.match(VERSION_RE);
  return m ? m[1] : '';
}

// 背景確認 index.html 有沒有新版。
// 這裡比對「整份內容」而不是 ETag:ETag 會因為壓縮方式、CDN 節點不同而變,
// 之前沒推新版也一直跳「系統已更新」就是這個原因。
async function checkIndex(c, notify) {
  const fresh = await fetch(INDEX_URL, { cache: 'no-cache' });   // 帶 ETag 去問,沒變伺服器只回 304,很省流量
  if (!fresh.ok) return fresh;
  const newText = await fresh.clone().text();
  const prev = await c.match(INDEX_URL);
  const oldText = prev ? await prev.text().catch(() => '') : '';
  const changed = !!oldText && oldText !== newText;
  // index.html 有 3MB 以上,快取空間不足時 put 會失敗。
  // 以前這裡失敗是無聲的,結果快取永遠停在舊版 → 每次開都拿舊的、每次都跳「系統已更新」,
  // 按重新載入也沒用。現在存不進去就把舊的那份刪掉,下次直接走網路拿新版。
  let stored = true;
  try { await c.put(INDEX_URL, fresh.clone()); }
  catch (e) {
    stored = false;
    try { await c.delete(INDEX_URL); } catch (e2) {}
  }
  if (notify && changed) {
    const msg = { type: 'sc-new-version', version: versionOf(newText), from: versionOf(oldText), stored };
    const all = await self.clients.matchAll({ type: 'window' });
    all.forEach(cl => cl.postMessage(msg));
  }
  return fresh;
}

function offlineResponse() {
  return new Response('<meta charset="utf-8"><p style="font:16px sans-serif;padding:24px">目前沒有網路,且這台裝置還沒有離線快取。請連上網路後再開一次。</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 使用者按了提示列的「重新載入」→ 下一次開主頁一定走網路,不看快取。
// (光靠刪快取會跟重整搶時間,搶輸就又拿到舊的那份,所以再加這道保險)
let forceFreshIndex = false;

async function serveIndex() {
  const c = await caches.open(SHELL_CACHE);
  const force = forceFreshIndex; forceFreshIndex = false;
  const cached = await c.match(INDEX_URL);
  const refresh = checkIndex(c, !force && !!cached);   // 他自己按的那次不用再提示一遍
  refresh.catch(() => {});
  if (force) {
    try { return { response: await refresh, refresh }; }
    catch (e) { return { refresh, response: cached || offlineResponse() }; }   // 真的沒網路才退回快取
  }
  if (cached) return { response: cached, refresh };
  try { return { response: await refresh, refresh }; }
  catch (e) { return { refresh, response: offlineResponse() }; }
}

// 頁面開著不動時,由頁面每隔幾分鐘叫我們再確認一次(不用等到重新整理才發現新版)
// sc-reset:按「重新載入」時先把快取那份 index.html 丟掉,確保重整一定拿到新版
self.addEventListener('message', ev => {
  const d = ev.data || {};
  if (d.type === 'sc-check') {
    ev.waitUntil(caches.open(SHELL_CACHE).then(c => checkIndex(c, true)).catch(() => {}));
  }
  if (d.type === 'sc-reset') {
    forceFreshIndex = true;
    const done = caches.open(SHELL_CACHE).then(c => c.delete(INDEX_URL)).catch(() => {});
    ev.waitUntil(done);
    if (ev.source) done.then(() => { try { ev.source.postMessage({ type: 'sc-reset-done' }); } catch (e) {} });
  }
});

async function cacheFirst(req) {
  const c = await caches.open(LIB_CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') c.put(req, res.clone()).catch(() => {});
  return res;
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(req.url.includes('fonts.googleapis.com') ? LIB_CACHE : SHELL_CACHE);
  const hit = await c.match(req);
  const net = fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') c.put(req, res.clone()).catch(() => {});
    return res;
  });
  if (hit) { net.catch(() => {}); return hit; }
  return net;
}

// ── 手機推播 ──
self.addEventListener('push', ev => {
  let d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch (e) { d = { body: ev.data ? ev.data.text() : '' }; }
  const title = d.title || '鎮山工程管理系統';
  ev.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: new URL('assets/pwa/icon-192.png', SCOPE).href,
    badge: new URL('assets/pwa/icon-192.png', SCOPE).href,
    data: { url: d.url || SCOPE.href }
  }));
});

self.addEventListener('notificationclick', ev => {
  ev.notification.close();
  const target = new URL((ev.notification.data && ev.notification.data.url) || SCOPE.href, SCOPE).href;
  ev.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const cl of all) {
      if (cl.url.startsWith(SCOPE.href)) {
        await cl.focus();
        cl.postMessage({ type: 'sc-open', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
