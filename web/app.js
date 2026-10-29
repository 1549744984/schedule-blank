(() => {
  "use strict";

  const DB_NAME = "schedule-local-v1";
  const DB_VERSION = 1;
  const STORES = {
    days: "date",
    notes: "id",
    meta: "key",
    pending: "key"
  };

  let dbPromise;

  async function init() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          for (const [name, keyPath] of Object.entries(STORES)) {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, { keyPath });
            }
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    return dbPromise;
  }

  async function getAll(store) {
    const db = await init();
    return new Promise((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function get(store, key) {
    const db = await init();
    return new Promise((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function put(store, value) {
    const db = await init();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, "readwrite");
      transaction.objectStore(store).put(value);
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function deleteValue(store, key) {
    const db = await init();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, "readwrite");
      transaction.objectStore(store).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  window.ScheduleOffline = {
    init,
    getAll,
    get,
    put,
    delete: deleteValue
  };
})();

'use strict';

/* ============ 基础工具 ============ */
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const WK = ['日', '一', '二', '三', '四', '五', '六'];
const WK_ORDER = ['一', '二', '三', '四', '五', '六', '日'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function mondayOf(d) {
  const x = new Date(d);
  const off = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - off);
  x.setHours(0, 0, 0, 0);
  return x;
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(w)}`;
}
function isoWeekToMonday(iso) {
  const [y, w] = iso.split('-W').map(Number);
  const mondayW1 = mondayOf(new Date(y, 0, 4));
  return addDays(mondayW1, (w - 1) * 7);
}
const shortIso = (iso) => iso.slice(5);           // 2026-W43 -> W43
/* 时间轴：每小时 PX 像素（44 太挤，15 分钟的日程被压成一条线，改 60）。
   可见范围默认 07:00–22:00，当天 / 本周有事件越界时由 fitHours() 自动撑开。 */
const mobileQuery = window.matchMedia
  ? window.matchMedia('(max-width: 720px)')
  : { matches: false, addEventListener() {} };
let PX = mobileQuery.matches ? 36 : 60;           // 手机小时行高 = 桌面的 0.6 倍
let H0 = 7, H1 = 22;
/* 手机周视图一屏放几天。7 列硬塞进 400px 时每列只有 52px、块内可用 50px，
   「10:00–11:35」要 60px、一个 6 字课名要 102px——时间只能藏、标题只能省略。
   改成固定列宽 + 横向滑动，一屏 3 天：400px 下每列 121px、可用 110px，两样都放得下。 */
const MWEEK_DAYS = 3;
/* 手机时间列宽 = style.css 里的 2.25rem，两边必须同源，否则最后一天会被切掉一条 */
const MWEEK_TIMECOL_REM = 2.25;

/* 把列宽交给 CSS 变量 --mdayw（手机周视图的列宽）。
   按 main 的实际可用宽度算，不用 100vw——scrollbar-gutter 会让两者差几个像素。 */
function syncDayColWidth() {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const host = document.getElementById('main');
  const avail = (host ? host.clientWidth : document.documentElement.clientWidth)
    - MWEEK_TIMECOL_REM * rem;
  /* 76px 是下限：再窄时间又会放不下，宁可多滑一点也不缩回去 */
  const w = Math.max(76, Math.floor(avail / MWEEK_DAYS));
  document.documentElement.style.setProperty('--mdayw', w + 'px');
  return w;
}
const MAX_LINES = 8;                              // 只是上限；真正放几条由 trimMonthCells() 按实际高度量出来
const HOT_HOURS = [8, 12, 18];                    // 早八 / 中午 / 晚六，一天的分水岭
/* 时间列标签：两小时一格，不按一小时切碎。
   H0 是奇数时（默认 7 点），第一格只占一小时，否则标签会整体错位一小时 */
const hourCells = () => {
  const out = [];
  let h = H0;
  if (h % 2) {
    out.push(`<div style="height:var(--hour,60px)">${pad(h)}:00</div>`);
    h += 1;
  }
  for (; h < H1; h += 2) {
    out.push(`<div${HOT_HOURS.includes(h) ? ' class="hot"' : ''}>${pad(h)}:00</div>`);
  }
  return out.join('');
};
/* 三条强线，把列切成早 / 午 / 晚（只画在可见范围内的） */
const hourBars = () => HOT_HOURS.filter((h) => h >= H0 && h <= H1).map((h) =>
  `<div class="hbar" style="top:${(h - H0) * PX}px"></div>`).join('');
const toTop = (t) => {
  const [h, m] = t.split(':').map(Number);
  return Math.max(0, (h + m / 60 - H0) * PX);
};
/* 块高 = 分钟差 / 60 × PX（每分钟像素）。桌面 60px/h、手机 36px/h，算法同一套，
   只有 PX 不同。块之间的 2px 缝由 CSS 的 border-bottom 画，不再从高度里扣，
   否则 60/95/180 分钟会算成 58/93/178，比例从 1:1.58:3 偏到 1:1.60:3.07。 */
const toHeight = (s, e) => {
  const [sh, sm] = s.split(':').map(Number), [eh, em] = e.split(':').map(Number);
  const minutes = (eh + em / 60) - (sh + sm / 60);
  /* 下限只保证「能放下两行字」，不能反过来压掉计算值 */
  return Math.max(mobileQuery.matches ? 22 : 30, minutes * PX);
};
/* type=time 只接受 00:00–23:59；保存前统一校验，点时间轴新建也复用这套换算 */
const timeMinutes = (t) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const timeText = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

/* 手机月视图：格子里只放「类型色点」，不放文字。
   顺序：全天事项最前，其余按开始时间；末尾若有未完成待办补一个待办色点。
   最多 3 个（4 个在 48px 格子里太挤），超出显示 +N。 */
function mobileDotTypes(events, openTodos) {
  const ordered = (events || []).slice().sort((a, b) => {
    if (!!a.allday !== !!b.allday) return a.allday ? -1 : 1;
    return String(a.start || '').localeCompare(String(b.start || ''));
  });
  const types = ordered.map((e) => (e.priority === 'high' ? 'high' : (e.allday ? 'allday' : 'normal')));
  if (openTodos > 0) types.push('todo');
  return types;
}

function mobileDots(events, openTodos) {
  const types = mobileDotTypes(events, openTodos);
  if (!types.length) return '';
  /* 2026-10-29 他要的：一条短线代表一个日程，线的长短代表这件事有多久，几条就是几件事。
     两条防溢出的硬约束：单条最短 4px、最长 8px；最多画 3 条，多的折成 +N。
     3×8 + 2×2 间隙 + 「+N」≈ 38px，而 400px 屏月格可用宽约 40px，塞得下不越界。 */
  const list = (events || []).filter(Boolean);
  if (!list.length) return `<div class="m-bars"><i style="width:7px"></i></div>`;
  const bars = list.slice(0, 3).map((e) => {
    let minutes = 60;
    if (e.start && e.end) {
      const [sh, sm] = String(e.start).split(':').map(Number);
      const [eh, em] = String(e.end).split(':').map(Number);
      minutes = Math.max(15, (eh * 60 + em) - (sh * 60 + sm));
    }
    const w = Math.round(4 + Math.min(minutes, 120) / 120 * 4);  // 4–8px
    return `<i style="width:${w}px"></i>`;
  }).join('');
  const more = list.length > 3 ? `<span class="m-bars-more">+${list.length - 3}</span>` : '';
  return `<div class="m-bars">${bars}${more}</div>`;
}

/* 手机月视图图例：版一已去掉点点，图例一并不再需要 */
function monthLegend() {
  return '';
}

let lastPeriodTrigger = null;

function closePeriodPop(restore = true) {
  const pop = $('#period-pop');
  const bd = $('#pop-backdrop');
  if (pop) pop.hidden = true;
  if (bd) bd.hidden = true;
  if (restore && lastPeriodTrigger && lastPeriodTrigger.isConnected) {
    try { lastPeriodTrigger.focus(); } catch (e) { /* ignore */ }
  }
  lastPeriodTrigger = null;
}

function openPeriodPop(ds, idxs, trigger, opts) {
  opts = opts || {};
  const day = state.days[ds] || { events: [], todos: [] };
  const items = String(idxs || '').split(',').map((n) => Number(n)).filter((n) => Number.isFinite(n))
    .map((i) => ({ e: day.events[i], i })).filter((x) => x.e)
    /* 与月格色点同序：全天最前，其余按开始时间（原来跟着文件顺序，整日会掉到最后） */
    .sort((a, b) => {
      if (!!a.e.allday !== !!b.e.allday) return a.e.allday ? -1 : 1;
      return String(a.e.start || '').localeCompare(String(b.e.start || ''));
    });
  if (!items.length) return;
  const pop = $('#period-pop');
  if (!pop) return;
  const rows = items.map(({ e, i }) => `<button type="button" class="pop-ev" data-pop-ev="${i}" data-date="${ds}">
      <span class="pop-time">${esc(e.allday ? '整日' : e.start + '–' + e.end)}</span>
      <span class="pop-title">${esc(e.title)}</span>
      ${e.location ? `<span class="pop-loc">${esc(e.location)}</span>` : ''}
    </button>`).join('');
  /* 从月格点进来时标题用「共 N 条」；从 +N 点进来保留「几点起」 */
  const first = items[0].e;
  const lead = opts.title || `${first.allday ? '全天' : first.start} 起 ${items.length} 条`;
  let todoHtml = '';
  if (opts.withTodos && (day.todos || []).length) {
    todoHtml = '<div class="pop-todos">' + day.todos.map((t) => `<div class="pop-todo${t.done ? ' done' : ''}${
      t.priority === 'high' ? ' high' : ''}"><span class="pt">${t.done ? '✓' : '·'}</span>${
      esc(t.text)}</div>`).join('') + '</div>';
  }
  pop.innerHTML = `<div class="pop-head"><span>${esc(ds)} · ${esc(lead)}</span>
      <button type="button" class="pop-close" data-pop-close aria-label="关闭">×</button></div>${rows}${todoHtml}`;
  lastPeriodTrigger = trigger || null;
  const bd = $('#pop-backdrop');
  if (bd) bd.hidden = false;
  pop.hidden = false;
  const closeBtn = pop.querySelector('[data-pop-close]');
  if (closeBtn) closeBtn.focus();
}

/* 重叠日程分栏：同一碰撞组共享宽度，原 data-idx 不变，点击仍编辑正确那条 */
/* 跨 ≥6 小时、且与 ≥2 条其他事件重叠的，按「区间」画：整宽淡底占一列，
   不参与分栏。否则一条 05:00–23:45 会把当天所有块都挤成半宽。 */
const SPAN_BAND_MIN = 360;

function layoutEvents(events) {
  const all = [];
  (events || []).forEach((e, idx) => {
    if (e.allday) return;
    const startM = timeMinutes(e.start);
    const endM = Math.max(timeMinutes(e.end), startM + 1);
    all.push({ e, idx, startM, endM, lane: 0, lanes: 1 });
  });
  all.sort((a, b) => a.startM - b.startM || a.endM - b.endM || a.idx - b.idx);

  /* 先挑出「区间事件」，剩下的才参与分栏 */
  const bands = all.filter((a) => (a.endM - a.startM) >= SPAN_BAND_MIN
    && all.filter((b) => b !== a && b.startM < a.endM && a.startM < b.endM).length >= 2);
  const items = bands.length ? all.filter((a) => !bands.includes(a)) : all;

  const out = [];
  let group = [], laneEnds = [], groupEnd = -1;
  const flush = () => {
    const lanes = Math.min(4, Math.max(1, laneEnds.length));
    for (const item of group) {
      item.stack = item.lane > 3 ? item.lane - 3 : 0;
      item.lane = Math.min(item.lane, 3);
      item.lanes = lanes;
      out.push(item);
    }
  };
  for (const item of items) {
    if (group.length && item.startM >= groupEnd) {
      flush();
      group = []; laneEnds = []; groupEnd = -1;
    }
    groupEnd = group.length ? Math.max(groupEnd, item.endM) : item.endM;
    let lane = laneEnds.findIndex((end) => item.startM >= end);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = item.endM;
    item.lane = lane;
    group.push(item);
  }
  flush();
  for (const b of bands) {
    out.push({ ...b, band: true, lane: 0, lanes: 1, stack: 0 });
  }
  return out;
}

/* bleed = 往左越过时间轴的像素数。左边缘 = lane 起点 - (bleed - inset)，
   宽度同步加回去，所以**右边缘不动**，只有左边那一条越界。 */
const laneGeometry = (item, inset, bleed = 0) => {
  const width = 100 / item.lanes;
  const left = item.lane * width;
  const lift = Math.min(item.stack || 0, 3) * 3;
  return `left:calc(${left}% + ${inset - bleed}px);width:calc(${width}% - ${inset * 2 - bleed}px);right:auto;transform:translateY(${lift}px)`;
};
/* 按实际事件撑开可见时段：默认 7–22，有 7 点前 / 22 点后的安排就往外扩 */
function fitHours(lists) {
  let lo = 7, hi = 22;
  for (const list of lists) {
    for (const e of (list || [])) {
      if (e.allday || !e.start || !e.end) continue;
      const [sh, sm] = e.start.split(':').map(Number);
      const [eh, em] = e.end.split(':').map(Number);
      const endH = em > 0 ? eh + 1 : eh;
      if (sh < lo) lo = sh;
      if (endH > hi) hi = endH;
    }
  }
  H0 = Math.max(0, lo);                           // 默认 7 点起，有更早的安排才往前扩
  H1 = Math.min(24, Math.max(hi, H0 + 6));
  if (H1 % 2) H1 = Math.min(24, H1 + 1);           // 收尾落在偶数点，两小时标签才对得齐
}
/* 把每小时像素数交给 CSS，时间列刻度与背景线跟着一起走 */
function syncHourPixels() {
  PX = mobileQuery.matches ? 36 : 60;
  document.documentElement.style.setProperty('--hour', PX + 'px');
  syncDayColWidth();
}
syncHourPixels();

/* 配色只认「事件四类」：重点 / 整日 / 待办 / 普通，一律由 CSS 变量给（见 style.css :root）。
   不再按标签分「工作/学习/生活」色相——两套配色并存会让同一个块说不清是什么含义。 */

/* ============ 状态 ============ */
const state = {
  view: 'month',
  cursor: new Date(),
  days: {},
  months: {},
  weeks: {},
  today: ymd(new Date()),
  editing: null,
  loading: false,
  scrollWeekToTime: false,
  offlineReady: false,
  online: navigator.onLine !== false,
  lastSync: 0,
  pending: 0,
  syncing: false,
  notes: [],
  noteTree: [],
  noteInbox: '收件箱',
  noteArchive: '_归档',
  notesRoot: '',
  noteLegacy: null,
  editingNote: null,
  noteFilter: 'all',
  noteSort: 'created',
  noteSearch: '',
  notePane: 'list',
  noteDirty: false,
  noteSaveStatus: '',
};
let noteSaveTimer = null;

const status = (t) => { $('#status').textContent = t || ''; };

/* ============ 登录态：localStorage + 30 天 token + 静默续期 ============ */
const AUTH_KEY = 'schedule-auth-v1';
let authInfo = null;
let refreshPromise = null;
try { authInfo = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { authInfo = null; }

function saveAuth(info) {
  authInfo = info;
  try { localStorage.setItem(AUTH_KEY, JSON.stringify(info)); } catch (e) { /* 隐私模式仅保本次内存 */ }
}
function clearAuth() {
  authInfo = null;
  try { localStorage.removeItem(AUTH_KEY); } catch (e) { /* 无存储时不影响退出 */ }
}
function openLogin(message) {
  $('#login-panel').hidden = false;
  $('#login-error').hidden = !message;
  $('#login-error').textContent = message || '';
  setTimeout(() => $('#login-user').focus(), 30);
}

async function refreshAuth() {
  if (!authInfo || refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const r = await fetch('/api/auth/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authInfo.token}` },
        body: '{}',
      });
      if (!r.ok) { if (r.status === 401) clearAuth(); return false; }
      saveAuth(await r.json());
      return true;
    } catch (e) { return false; }
  })();
  try { return await refreshPromise; } finally { refreshPromise = null; }
}

/* 桌面壳开窗时 URL 带 ?boot=<时间戳>（server 也会带 client=desktop），手机是裸地址 */
function isDesktopShell() {
  const q = new URLSearchParams(location.search);
  return q.get('client') === 'desktop' || q.has('boot');
}

async function apiFetch(url, opt = {}) {
  /* 提前 7 天续期；即使已经过期，只要仍在续期宽限内也先静默换新 */
  if (authInfo && Date.now() >= authInfo.expiresAt - 7 * 86400000) await refreshAuth();
  const headers = { ...(opt.headers || {}) };
  if (authInfo && authInfo.token) headers.Authorization = `Bearer ${authInfo.token}`;
  /* 告诉服务端「这句话是谁说的」：桌面窗优先，手机让位（2026-10-29 F） */
  if (!headers['X-Client']) headers['X-Client'] = isDesktopShell() ? 'desktop' : 'phone';
  const r = await fetch(url, { ...opt, headers });
  if (r.status === 401) {
    clearAuth();
    openLogin('登录已失效，请重新登录');
    const err = new Error('需要登录'); err.authRequired = true; throw err;
  }
  return r;
}

async function login() {
  const user = $('#login-user').value.trim();
  const password = $('#login-password').value;
  if (!user || !password) { openLogin('请输入用户名和密码'); return; }
  $('#login-error').hidden = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || '登录失败');
    saveAuth(j);
    $('#login-password').value = '';
    $('#login-panel').hidden = true;
    await load();
  } catch (e) { openLogin(e.message || '登录失败'); }
}

/* ============ IndexedDB 离线副本与待同步队列 ============ */
const hasOffline = () => state.offlineReady && !!window.ScheduleOffline;
const eventKey = (e) => JSON.stringify([e.start, e.end, e.title, e.location || '', e.tags || [], !!e.allday]);

function updateSyncStatus() {
  const time = state.lastSync ? new Date(state.lastSync).toTimeString().slice(0, 5) : '尚未同步';
  $('#sync-info').textContent = `${state.online ? '在线' : '离线'} · ${time}${state.pending ? ` · ${state.pending} 项待同步` : ''}`;
}

async function refreshPendingCount() {
  if (!hasOffline()) return;
  state.pending = (await ScheduleOffline.getAll('pending')).length;
  updateSyncStatus();
}

async function markSynced() {
  state.online = true;
  state.lastSync = Date.now();
  if (hasOffline()) await ScheduleOffline.put('meta', { key: 'lastSync', value: state.lastSync });
  updateSyncStatus();
}

async function mergeServerDay(remote) {
  if (!hasOffline()) { state.days[remote.date] = remote; return remote; }
  const local = await ScheduleOffline.get('days', remote.date);
  const localTime = local && local.updatedAt || 0;
  const remoteTime = remote.updatedAt || 0;
  if (local && localTime > remoteTime) {
    state.days[remote.date] = local;
    return local;
  }
  await ScheduleOffline.put('days', remote);
  state.days[remote.date] = remote;
  return remote;
}

async function initOffline() {
  if (!window.ScheduleOffline) return;
  try {
    await ScheduleOffline.init();
    state.offlineReady = true;
    const [days, notes, pending, meta] = await Promise.all([
      ScheduleOffline.getAll('days'), ScheduleOffline.getAll('notes'),
      ScheduleOffline.getAll('pending'), ScheduleOffline.getAll('meta'),
    ]);
    for (const d of days) if (d && d.date) state.days[d.date] = d;
    for (const n of notes) if (n && n.id) upsertStateNote(n);
    for (const m of meta) {
      if (m.key === 'lastSync') state.lastSync = m.value || 0;
      if (m.key === 'plans') { state.months = m.months || {}; state.weeks = m.weeks || {}; }
    }
    state.pending = pending.length;
    updateSyncStatus();
    if (days.length || notes.length) render();    // 先画本地快照，再等网络
  } catch (e) {
    state.offlineReady = false;
    $('#sync-info').textContent = '离线存储不可用';
  }
}

async function syncPending() {
  if (!hasOffline() || state.syncing) return;
  state.syncing = true;
  try {
    const jobs = (await ScheduleOffline.getAll('pending')).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of jobs) {
      try {
        if (job.type === 'day') {
          const r = await apiFetch('/api/day', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.payload),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || '同步失败');
          await ScheduleOffline.put('days', j.day);
          state.days[j.day.date] = j.day;
        } else if (job.type === 'note') {
          await syncNoteJob(job);
        }
        await ScheduleOffline.delete('pending', job.key);
        await markSynced();
      } catch (e) {
        if (e.authRequired) throw e;
        state.online = false;
        updateSyncStatus();
        break;
      }
    }
    await refreshPendingCount();
    render();
  } finally { state.syncing = false; }
}

/* ============ 独立便签：JSON + 离线软删除 ============ */
function upsertStateNote(note) {
  const i = state.notes.findIndex((n) => n.id === note.id);
  if (i >= 0) state.notes[i] = note;
  else state.notes.push(note);
}

async function mergeServerNote(remote) {
  if (!remote || !remote.id) return;
  const local = hasOffline()
    ? await ScheduleOffline.get('notes', remote.id)
    : state.notes.find((n) => n.id === remote.id);
  const t = (v) => { const ms = Date.parse(v || ''); return Number.isNaN(ms) ? 0 : ms; };
  if (local && t(local.updatedAt) > t(remote.updatedAt) + 1000) {
    upsertStateNote(local);
    return local;
  }
  if (hasOffline()) await ScheduleOffline.put('notes', remote);
  upsertStateNote(remote);
  return remote;
}

async function syncNoteJob(job) {
  const r = await apiFetch('/api/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.payload),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '便签同步失败');
  if (j.merged === 'disk-newer') {
    applyNotesPayload(j);
    if (j.note && state.editingNote && j.note.id === state.editingNote.id) {
      state.editingNote = j.note;
      state.noteSaveStatus = '已载入磁盘版本';
    }
    status('已载入磁盘版本');
  } else {
    applyNotesPayload(j);
    await mergeServerNote(j.note);
  }
  await markSynced();
}

async function loadNotes() {
  if (hasOffline()) {
    const cached = await ScheduleOffline.getAll('notes');
    for (const n of cached) upsertStateNote(n);
    render();
  }
  try {
    const r = await apiFetch('/api/notes', { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '便签读取失败');
    applyNotesPayload(j);
    for (const n of j.notes || []) await mergeServerNote(n);
    await markSynced();
    render();
    status('便签已同步');
    applyStickerStatus(j.sticker);
  } catch (e) {
    if (e.authRequired) throw e;
    state.online = false;
    updateSyncStatus();
    status(state.offlineReady ? '离线便签 · 等待同步' : '便签读取失败');
    if (state.offlineReady) render();
  }
}

const noteTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const noteClock = (iso) => {
  const d = new Date(iso || Date.now());
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const noteTitle = (note) => {
  const custom = String(note.title || '').trim();
  if (custom) return [...custom].slice(0, 20).join('');
  const line = String(note.text || '').split(/\r?\n/).find((x) => x.trim());
  return [...(line || '新便签').trim()].slice(0, 20).join('') || '新便签';
};
const noteWide = () => !window.matchMedia || window.matchMedia('(min-width: 640px)').matches;

function isArchived(n) {
  const f = String(n.folder || '');
  const arch = state.noteArchive || '_归档';
  return !!n.archived || f === arch || f.startsWith(arch + '/');
}
function inFolder(n, path) {
  const f = String(n.folder || '');
  return f === path || f.startsWith(path + '/');
}
function folderScope() {
  const f = String(state.noteFilter || 'all');
  return f.startsWith('folder:') ? f.slice(7) : '';
}
function noteSortKey(a, b) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  const field = state.noteSort === 'updated' ? 'updatedAt' : 'createdAt';
  const av = String(a[field] || a.createdAt || '');
  const bv = String(b[field] || b.createdAt || '');
  return bv.localeCompare(av);   // 同序稳定，编辑不会让条目换位置
}
function visibleNotes() {
  return state.notes.filter((n) => !n.deleted && !isArchived(n)).sort(noteSortKey);
}
function archivedNotes() {
  return state.notes.filter((n) => !n.deleted && isArchived(n)).sort(noteSortKey);
}
/* 「全部」要含归档 —— 他 2026-10-29 指出左栏写「全部 2」但库里 4 条。
   置顶 / 最近七天 口径不变（仍然不含归档），只有「全部」这一项把归档算进来。
   列表里归档条目照旧带「_归档 ·」前缀，一进来就分得清。 */
function allNotesIncludingArchive() {
  return state.notes.filter((n) => !n.deleted).sort(noteSortKey);
}

function filteredNotes() {
  const q = state.noteSearch.trim().toLowerCase();
  const scope = folderScope();
  const cutoff = Date.now() - 7 * 86400000;
  const arch = state.noteArchive || '_归档';
  let base = visibleNotes();
  /* 没选文件夹、也没选「置顶/最近七天」时 = 「全部」，此时要把归档也算进来 */
  const isAllScope = !scope && (!state.noteFilter || state.noteFilter === 'all');
  if (isAllScope) base = allNotesIncludingArchive();
  if (scope && scope === arch) base = archivedNotes();
  return base.filter((n) => {
    if (scope) {
      if (!inFolder(n, scope)) return false;
    } else {
      if (state.noteFilter === 'pinned' && !n.pinned) return false;
      if (state.noteFilter === 'recent' && !(Date.parse(n.updatedAt || '') >= cutoff)) return false;
    }
    if (q && !(`${n.title || ''}\n${n.text || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function noteCounts() {
  const all = visibleNotes();
  const cutoff = Date.now() - 7 * 86400000;
  const counts = {
    all: allNotesIncludingArchive().length,
    pinned: all.filter((n) => n.pinned).length,
    recent: all.filter((n) => Date.parse(n.updatedAt || '') >= cutoff).length,
  };
  for (const node of state.noteTree || []) {
    counts[`folder:${node.path}`] = all.filter((n) => inFolder(n, node.path)).length;
  }
  counts[`folder:${state.noteArchive || '_归档'}`] = archivedNotes().length;
  return counts;
}

function noteListHtml() {
  const items = filteredNotes();
  if (!items.length) return '<div class="notes-empty">这个位置还没有便签。</div>';
  const showFolder = !folderScope();
  return items.map((n) => `<button class="note-item${state.editingNote && state.editingNote.id === n.id ? ' on' : ''}" data-note-id="${n.id}">
    <span class="note-item-title">${n.pinned ? '置顶 · ' : ''}${esc(noteTitle(n))}</span>
    <span class="note-item-time">${showFolder && n.folder ? esc(n.folder) + ' · ' : ''}${noteTime(n.updatedAt)}</span></button>`).join('');
}

function updateNoteList() {
  const box = document.querySelector('.notes-list-body');
  if (box) box.innerHTML = noteListHtml();
  const count = document.querySelector('.notes-count');
  if (count) count.textContent = `${filteredNotes().length} 条`;
}

function updateNoteFilters() {
  const counts = noteCounts();
  document.querySelectorAll('[data-note-filter]').forEach((btn) => {
    const key = btn.dataset.noteFilter;
    const cnt = btn.querySelector('.cnt');
    if (cnt) cnt.textContent = counts[key] ?? 0;
    btn.classList.toggle('on', key === state.noteFilter);
  });
}

function folderOptionsHtml(current) {
  const seen = new Set();
  const rows = [];
  const push = (p, label) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    rows.push(`<option value="${esc(p)}"${p === current ? ' selected' : ''}>${esc(label)}</option>`);
  };
  push(state.noteInbox || '收件箱', state.noteInbox || '收件箱');
  for (const node of state.noteTree || []) {
    if (node.archive) continue;
    push(node.path, `${'　'.repeat(node.depth || 0)}${node.name}`);
  }
  if (current && !seen.has(current)) push(current, current);
  return rows.join('');
}

function folderTreeHtml() {
  const counts = noteCounts();
  const fixed = [['all', '全部'], ['pinned', '置顶'], ['recent', '最近七天']];
  const head = fixed.map(([key, label]) =>
    `<button class="note-filter${state.noteFilter === key ? ' on' : ''}" data-note-filter="${key}">
      <span>${label}</span><span class="cnt">${counts[key] || 0}</span></button>`).join('');
  const nodes = (state.noteTree || []).map((node) => {
    const key = `folder:${node.path}`;
    const pad = 8 + (node.depth || 0) * 12;
    const ops = node.archive ? '' :
      `<span class="fops"><button data-folder-rename="${esc(node.path)}" title="重命名文件夹">✎</button><button data-folder-delete="${esc(node.path)}" title="删除空文件夹">×</button></span>`;
    return `<div class="note-folder${state.noteFilter === key ? ' on' : ''}" data-note-filter="${esc(key)}" style="padding-left:${pad}px">
      <span class="fname">${esc(node.name)}</span><span class="cnt">${counts[key] || 0}</span>${ops}</div>`;
  }).join('');
  return `${head}<button class="note-sort" data-note-sort title="默认按创建时间，顺序不会因为编辑而变">
      ${state.noteSort === 'updated' ? '按更新时间' : '按创建时间'}</button>
    <div class="note-tree-head">文件夹</div>${nodes || '<div class="note-tree-empty">还没有文件夹</div>'}
    <button class="note-folder-new" data-folder-new>＋ 新建文件夹</button>`;
}

function currentNoteDraft() {
  const ta = document.querySelector('#note-editor-text');
  if (!ta || !state.editingNote) return null;
  const text = ta.value;
  const titleEl = document.querySelector('#note-title-input');
  const title = titleEl ? titleEl.value.trim() : String(state.editingNote.title || '');
  if (!text.trim() && !title) return null;
  const prev = state.editingNote;
  const now = new Date().toISOString();
  return {
    ...prev,
    id: prev.id || `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    title, text,
    folder: prev.folder || state.noteInbox || '收件箱',
    baseMtime: prev.mtime,
    createdAt: prev.createdAt || now,
    updatedAt: now,
    deleted: false,
  };
}

function applyNotesPayload(j) {
  if (j && Array.isArray(j.notes)) state.notes = j.notes;
  if (j && Array.isArray(j.tree)) state.noteTree = j.tree;
  if (j && j.inbox) state.noteInbox = j.inbox;
  if (j && j.archive) state.noteArchive = j.archive;
  if (j && j.root) state.notesRoot = j.root;
  if (j && j.legacyFile) state.noteLegacy = j.legacyFile;
}

function saveCurrentNote(force = false) {
  if (noteSaveTimer) { clearTimeout(noteSaveTimer); noteSaveTimer = null; }
  const note = currentNoteDraft();
  if (!note) {
    if (!force) state.noteSaveStatus = '内容为空，未保存';
    return Promise.resolve(false);
  }
  state.editingNote = note;
  state.noteDirty = false;
  state.noteSaveStatus = '保存中…';
  const statusEl = document.querySelector('#note-save-status');
  if (statusEl) statusEl.textContent = state.noteSaveStatus;
  return queueNote(note).then(() => {
    state.noteSaveStatus = `已保存 ${noteClock(note.updatedAt)}`;
    const el = document.querySelector('#note-save-status');
    if (el) el.textContent = state.noteSaveStatus;
    updateNoteList();
    updateNoteFilters();
    syncNoteNow(note);
    return true;
  });
}

function openNote(note) {
  saveCurrentNote(true);
  state.editingNote = note;
  state.noteDirty = false;
  state.notePane = 'editor';
  state.noteSaveStatus = note.updatedAt ? `已保存 ${noteClock(note.updatedAt)}` : '新便签 · 输入后自动保存';
  renderNotes();
  const ta = document.querySelector('#note-editor-text');
  if (ta) setTimeout(() => ta.focus(), 20);
}

function newNote() {
  saveCurrentNote(true);
  const now = new Date().toISOString();
  const scope = folderScope();
  const arch = state.noteArchive || '_归档';
  const folder = scope && scope !== arch ? scope : (state.noteInbox || '收件箱');
  openNote({
    id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    title: '', text: '', pinned: false, folder,
    createdAt: now, updatedAt: now, deleted: false,
  });
}

function backToNoteList() {
  saveCurrentNote(true);
  state.notePane = 'list';
  state.editingNote = null;
  renderNotes();
}

function toggleCurrentNotePin() {
  if (!state.editingNote) return;
  state.editingNote.pinned = !state.editingNote.pinned;
  state.noteDirty = true;
  saveCurrentNote(true);
  const btn = document.querySelector('[data-note-pin]');
  if (btn) {
    btn.classList.toggle('on', state.editingNote.pinned);
    btn.setAttribute('aria-pressed', String(state.editingNote.pinned));
    btn.textContent = state.editingNote.pinned ? '已置顶' : '置顶';
  }
}

async function noteOp(url, body, okText) {
  try {
    const r = await apiFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '操作失败');
    applyNotesPayload(j);
    if (j.note && state.editingNote && j.note.id === state.editingNote.id) state.editingNote = j.note;
    status(okText || '已更新');
    renderNotes();
    return j;
  } catch (e) {
    if (!e.authRequired) status(e.message || '操作失败');
    return null;
  }
}

function deleteCurrentNote() {
  const prev = state.editingNote;
  if (!prev) return;
  if (!window.confirm('归档这条便签？它会移到 _归档 文件夹，不会真删。')) return;
  if (noteSaveTimer) { clearTimeout(noteSaveTimer); noteSaveTimer = null; }
  state.noteDirty = false;
  state.editingNote = null;
  state.notePane = 'list';
  state.noteSaveStatus = '';
  noteOp('/api/notes/archive', { id: prev.id, title: prev.title, text: prev.text }, '已归档');
}

function moveCurrentNote(folder) {
  const prev = state.editingNote;
  if (!prev) return;
  noteOp('/api/notes/move', { id: prev.id, folder }, `已移到 ${folder}`);
}

function createFolder() {
  const scope = folderScope();
  const base = scope && scope !== (state.noteArchive || '_归档') ? scope + '/' : '';
  const name = window.prompt('新文件夹名（可用 斜杠/分层）', base);
  if (!name || !name.trim()) return;
  noteOp('/api/notes/folder', { action: 'create', path: name.trim() }, '文件夹已建');
}

function renameFolder(path) {
  const name = window.prompt('把文件夹改名为', path);
  if (!name || !name.trim() || name.trim() === path) return;
  noteOp('/api/notes/folder', { action: 'rename', path, newPath: name.trim() }, '文件夹已改名');
}

function deleteFolder(path) {
  if (!window.confirm(`删除空文件夹「${path}」？里面有便签时不会删。`)) return;
  noteOp('/api/notes/folder', { action: 'delete', path }, '文件夹已删除');
}

function renderNotes() {
  setTitle('便签', '');
  const active = visibleNotes();
  if (state.editingNote && state.editingNote.id) {
    const latest = state.notes.find((n) => n.id === state.editingNote.id && !n.deleted);
    if (latest && !state.noteDirty) state.editingNote = latest;
    else if (!latest && !state.noteDirty && state.editingNote.mtime) state.editingNote = null;
  }
  if (!state.editingNote && active.length && noteWide()) {
    state.editingNote = active[0];
    state.noteSaveStatus = `已保存 ${noteClock(active[0].updatedAt)}`;
  }
  const note = state.editingNote;
  const legacy = state.noteLegacy && state.noteLegacy.exists
    ? (state.noteLegacy.backedUp
      ? '<div class="notes-legacy">旧 便签.json 已迁移为 md，原文件保留作备份。</div>'
      : '<div class="notes-legacy warn">检测到旧 便签.json，还没迁移。</div>')
    : '';
  const editor = note
    ? `<div class="notes-mobile-head"><button data-note-back>‹ 返回</button><span>${noteTitle(note)}</span></div>
       <div class="notes-editor-head">
         <span class="notes-updated">${state.noteSaveStatus || (note.updatedAt ? '已保存 ' + noteClock(note.updatedAt) : '新便签')}</span>
         <select class="note-move" id="note-folder" title="移到别的文件夹">${folderOptionsHtml(note.folder || state.noteInbox || '收件箱')}</select>
         <button class="note-pin${note.pinned ? ' on' : ''}" data-note-pin aria-pressed="${!!note.pinned}">${note.pinned ? '已置顶' : '置顶'}</button>
         <button class="note-delete" data-note-delete>归档</button>
       </div>
       <input id="note-title-input" class="notes-title" value="${esc(note.title || '')}" placeholder="标题（也是文件名）" maxlength="100">
       <textarea id="note-editor-text" class="notes-editor" placeholder="直接开始写…" spellcheck="false">${esc(note.text || '')}</textarea>
       <div class="notes-editor-foot"><span id="note-save-status">${state.noteSaveStatus || ''}</span><span>${note.filename ? esc(note.filename) : '800ms 无输入自动保存'}</span></div>`
    : '<div class="notes-editor-empty">选择左侧便签，或新建一条。</div>';

  $('#main').innerHTML = `<div class="notes-page" data-pane="${state.notePane}">
    <aside class="notes-filters">
      <div class="notes-brand">便签</div>
      ${folderTreeHtml()}
      ${legacy}
      <button class="primary note-new" data-note-new>＋ 新建便签</button>
    </aside>
    <section class="notes-list-col">
      <div class="notes-search"><input id="note-search" type="search" placeholder="搜索全部便签" value="${esc(state.noteSearch)}"><span class="notes-count">${filteredNotes().length} 条</span></div>
      <div class="notes-list-body">${noteListHtml()}</div>
    </section>
    <section class="notes-editor-col">${editor}</section>
  </div>`;
}

function applyStickerStatus(j) {
  const btn = $('#btn-sticker');
  if (!j || !j.available) { btn.hidden = true; return; }
  btn.hidden = false;
  const active = j.active || [];
  btn.classList.toggle('on', active.length > 0);
  btn.title = active.length ? `已贴出 ${active.length} 条；对当前便签点一下可加入或移除` : '把当前选中的便签贴成浮窗';
}

async function refreshStickerStatus() {
  try {
    const r = await apiFetch('/api/sticker/status', { cache: 'no-store' });
    applyStickerStatus(await r.json());
  } catch (e) {
    const btn = $('#btn-sticker');
    if (btn) btn.hidden = true;
  }
}

async function toggleSticker() {
  if (state.view !== 'notes' || !state.editingNote) {
    status('先在便签里选中一条');
    return;
  }
  await saveCurrentNote(true);
  if (state.editingNote) await syncNoteNow(state.editingNote);
  const noteId = state.editingNote && state.editingNote.id;
  if (!noteId) { status('先写点内容再贴'); return; }
  try {
    const r = await apiFetch('/api/sticker/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note_id: noteId }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '贴纸操作失败');
    status(j.action === 'remove' ? '已移除这张贴纸' : '已贴出');
    await refreshStickerStatus();
  } catch (e) {
    if (!e.authRequired) status('贴纸只在桌面应用内可用');
  }
}

async function queueNote(note) {
  upsertStateNote(note);
  if (hasOffline()) {
    await ScheduleOffline.put('notes', note);
    await ScheduleOffline.put('pending', {
      key: `note:${note.id}`, type: 'note', payload: note, updatedAt: Date.parse(note.updatedAt) || Date.now(),
    });
    await refreshPendingCount();
  }
}

async function syncNoteNow(note) {
  try {
    if (hasOffline()) await syncPending();
    else await syncNoteJob({ payload: note });
  } catch (e) {
    if (!e.authRequired) status('便签已存本机 · 等待同步');
  }
  if (state.view === 'notes') {
    updateNoteList();
    updateNoteFilters();
  } else {
    render();
  }
}

/* ============ 数据 ============ */
function rangeFor() {
  const c = state.cursor;
  if (state.view === 'month') {
    const start = mondayOf(new Date(c.getFullYear(), c.getMonth(), 1));
    const last = new Date(c.getFullYear(), c.getMonth() + 1, 0);
    let end = addDays(mondayOf(last), 6);
    return { from: ymd(start), to: ymd(end) };
  }
  if (state.view === 'week') {
    const start = mondayOf(c);
    return { from: ymd(start), to: ymd(addDays(start, 6)) };
  }
  const start = mondayOf(c);
  return { from: ymd(start), to: ymd(addDays(start, 6)) };
}

async function load(silent) {
  if (state.loading) return;
  state.loading = true;
  if (!silent) status('读取中…');
  try {
    if (state.view === 'notes') { await loadNotes(); return; }
    const { from, to } = rangeFor();
    const r = await apiFetch(`/api/range?from=${from}&to=${to}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    for (const remote of Object.values(j.days || {})) await mergeServerDay(remote);
    state.months = j.months;
    state.weeks = j.weeks;
    state.today = j.today;
    if (hasOffline()) await ScheduleOffline.put('meta', { key: 'plans', months: state.months, weeks: state.weeks });
    await markSynced();
    render();
    status('已同步 ' + new Date().toTimeString().slice(0, 5));
    applyStickerStatus(j.sticker);
  } catch (e) {
    if (e.authRequired) { status('需要登录'); return; }
    state.online = false;
    updateSyncStatus();
    if (Object.keys(state.days).length) {
      status('离线数据 · 等待联网同步');
      render();
      return;
    }
    status('连接失败');
    $('#main').innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">
      读不到数据服务，也没有可用的离线副本。<br>联网打开一次后再试。</div>`;
  } finally {
    state.loading = false;
  }
}

async function saveDay(date) {
  const d = state.days[date] || { date, events: [], todos: [] };
  d.date = date;
  d.updatedAt = Date.now();
  state.days[date] = d;
  /* 接口默认已改成 append（对 AI 安全）；网页保存是「整份状态写回」，必须显式 replace */
  const payload = { date, events: d.events, todos: d.todos, note: d.note || '', updatedAt: d.updatedAt, mode: 'replace' };
  if (hasOffline()) {
    await ScheduleOffline.put('days', d);
    await ScheduleOffline.put('pending', { key: `day:${date}`, type: 'day', payload, updatedAt: d.updatedAt });
    await refreshPendingCount();
  }
  render();                                      // 本地先生效，不等待网络
  try {
    const r = await apiFetch('/api/day', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'save failed');
    /* 服务端说「它那份更新」：说明是桌面端刚写过。以桌面端为准，并**明确告诉用户**这次没生效
       （原来这条是静默覆盖，手机上改了等于白改，还不吭声）。 */
    if (j.merged === 'server-newer') {
      state.days[date] = j.day;
      if (hasOffline()) await ScheduleOffline.put('days', j.day);
      render();
      status('已用桌面端的版本，手机上这次的修改没生效');
      return false;
    }
    state.days[date] = j.day;
    if (hasOffline()) {
      await ScheduleOffline.put('days', j.day);
      await ScheduleOffline.delete('pending', `day:${date}`);
      await markSynced();
      await refreshPendingCount();
    }
    status('已保存');
    render();
    return true;
  } catch (e) {
    if (e.authRequired) { status('登录后继续同步'); return false; }
    if (state.offlineReady) {
      state.online = false;
      updateSyncStatus();
      status('已保存在本机 · 待同步');
      render();
      return false;
    }
    status('保存失败');
    alert('保存失败：' + e.message);
    return false;
  }
}

/* ============ 渲染入口 ============ */
/* 月目标 / 关键节点 / 本周重点：就地编辑。
   每条必须有唯一 id，删除/勾选只按 id 操作，禁止用数组索引——用索引删一项会让后面整体前移，
   出现“删一条，左边全没了”。data-plan-field 只挂在分组容器上，绝不能再挂到文本框上。 */
function planUid() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function ensurePlanIds(items) {
  return (items || []).map((g) => ({ ...g, id: g.id || planUid() }));
}

function planGroups(kind, key) {
  if (kind === 'month' && !state.months[key]) storePlan('month', key, { goals: [], milestones: [] });
  if (kind === 'week' && !state.weeks[key]) storePlan('week', key, { goals: [] });
  const data = planData(kind, key);
  if (kind === 'month') {
    return [['本月目标', 'goals', data.goals], ['关键节点', 'milestones', data.milestones]];
  }
  return [['本周重点', 'goals', data.goals]];
}

function planEditor(kind, key, groups) {
  const parts = groups.map(([label, field, items]) => {
    const list = (items || []).map((g) => `
      <span class="g${g.done ? ' done' : ''}" data-uid="${esc(g.id)}" data-done="${g.done ? '1' : '0'}"${g.date ? ` data-date="${esc(g.date)}"` : ''}>
        <button type="button" class="g-done" data-plan-toggle title="勾掉 / 取消">${g.done ? '✓' : '○'}</button>
        <span class="g-text" contenteditable="true" spellcheck="false">${esc(g.text)}</span>
        ${g.date ? `<button type="button" class="g-jump" data-plan-jump="${esc(g.date)}" title="跳到 ${esc(g.date)}">↗</button>` : ''}
        <button type="button" class="g-del" data-plan-del title="删除这一条">×</button>
      </span>`).join('');
    return `<span class="grp" data-plan-field="${field}"><span class="k">${esc(label)}</span>${list}
      <button type="button" class="g-add" data-plan-add="${field}" title="加一条">＋</button></span>`;
  }).join('');
  return `<div class="goals" data-plan-kind="${kind}" data-plan-key="${esc(key)}">${parts}</div>`;
}

function planData(kind, key) {
  if (kind === 'month') {
    const plan = state.months[key] || {};
    return { goals: plan.goals || [], milestones: plan.milestones || [] };
  }
  const plan = state.weeks[key] || {};
  return { goals: plan.goals || [] };
}

function storePlan(kind, key, data) {
  if (kind === 'month') {
    state.months[key] = {
      ym: key,
      goals: ensurePlanIds(data.goals),
      milestones: ensurePlanIds(data.milestones),
    };
  } else {
    state.weeks[key] = { iso: key, goals: ensurePlanIds(data.goals) };
  }
}

function planFieldList(kind, key, field) {
  const data = planData(kind, key);
  return field === 'milestones' ? data.milestones : data.goals;
}

function rerenderPlanBox(box) {
  const kind = box.dataset.planKind;
  const key = box.dataset.planKey;
  box.outerHTML = planEditor(kind, key, planGroups(kind, key));
}

async function postPlan(kind, key, data) {
  const payload = {
    kind, key,
    goals: (data.goals || []).filter((g) => String(g.text || '').trim()),
  };
  if (kind === 'month') {
    payload.milestones = (data.milestones || []).filter((g) => String(g.text || '').trim());
  }
  try {
    const r = await apiFetch('/api/plans', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '保存失败');
    if (j.plan) storePlan(kind, key, j.plan);
    status('已保存');
  } catch (e) {
    if (!e.authRequired) status('目标保存失败：' + (e.message || ''));
  }
}

/* 所有对目标列表的修改都走这里：按 id 改 state → 整段重渲染 → 提交 */
async function mutatePlan(box, field, fn) {
  const kind = box.dataset.planKind;
  const key = box.dataset.planKey;
  if (!kind || !key) return;
  const data = planData(kind, key);
  const list = field === 'milestones' ? data.milestones : data.goals;
  const next = fn(list || []);
  if (field === 'milestones') data.milestones = next;
  else data.goals = next;
  storePlan(kind, key, data);
  rerenderPlanBox(box);
  await postPlan(kind, key, planData(kind, key));
}

function updatePlanText(box, field, uid, text) {
  const kind = box.dataset.planKind;
  const key = box.dataset.planKey;
  if (!kind || !key) return;
  const data = planData(kind, key);
  const list = field === 'milestones' ? data.milestones : data.goals;
  const item = (list || []).find((x) => x.id === uid);
  if (!item) return;
  item.text = text;
  storePlan(kind, key, data);
}

let planTimer = null;
function planTouch(box, field, uid, text) {
  updatePlanText(box, field, uid, text);
  if (planTimer) clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    const kind = box.dataset.planKind;
    const key = box.dataset.planKey;
    if (kind && key) postPlan(kind, key, planData(kind, key));
  }, 800);
}

/* 标题：主文案 + 可选小字后缀；空间不够时缩字号，不加省略号 */
function setTitle(main, sub, mark) {
  const t = $('#title');
  if (!t) return;
  t.innerHTML = `${esc(main)}${sub ? `<span class="t-sub">${esc(sub)}</span>` : ''}`
    + (mark ? `<span class="title-today">${esc(mark)}</span>` : '');
  fitTitle();
}

function fitTitle() {
  const t = $('#title');
  const left = t && t.parentElement;
  if (!t || !left || !left.children.length) return;
  t.style.fontSize = '';
  const kids = [...left.children].filter((el) => el !== t);
  const gap = 9;
  const used = kids.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0)
    + gap * Math.max(0, left.children.length - 1);
  const avail = left.clientWidth - used - 8;
  if (avail <= 0) return;
  /* 基准字号从 CSS 变量读（桌面 20pt），空间不够时一档一档往下缩，绝不加省略号 */
  let size = parseFloat(getComputedStyle(t).fontSize) || 26;
  while (size > 14 && t.getBoundingClientRect().width > avail) {
    size = Math.round((size - 1) * 10) / 10;
    t.style.fontSize = `${size}px`;
  }
}

function render() {
  $('#main').dataset.view = state.view;
  document.body.dataset.view = state.view;
  document.querySelectorAll('#view-switch button').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === state.view);
  });
  const notesView = state.view === 'notes';
  $('#btn-prev').hidden = notesView;
  $('#btn-next').hidden = notesView;
  $('#btn-today').hidden = notesView;
  if (!notesView) syncTodayBtn();
  if (state.view === 'month') renderMonth();
  else if (state.view === 'week') renderWeek();
  else if (state.view === 'notes') renderNotes();
  else renderDay();
  requestAnimationFrame(() => fitTitle());
  try {
    localStorage.setItem('schedule-view-cache-v1', JSON.stringify({
      view: state.view, title: $('#title').textContent, html: $('#main').innerHTML, time: Date.now(),
    }));
  } catch (e) { /* 隐私模式或容量不足时跳过首屏快照 */ }
}

/* 「今天」按钮：光标已经落在今天所在的月 / 周 / 日时就点亮，点了要有反馈 */
function syncTodayBtn() {
  const c = state.cursor, t = parseYmd(state.today);
  let at;
  if (state.view === 'month') {
    at = c.getFullYear() === t.getFullYear() && c.getMonth() === t.getMonth();
  } else if (state.view === 'week') {
    at = isoWeek(c) === isoWeek(t);
  } else {
    at = ymd(c) === state.today;
  }
  $('#btn-today').classList.toggle('on', at);
}

/* ============ 月视图 ============ */
function renderMonth() {
  const y = state.cursor.getFullYear(), m = state.cursor.getMonth();

  const first = new Date(y, m, 1);
  let cur = mondayOf(first);
  const last = new Date(y, m + 1, 0);
  const cells = [];
  while (cur <= last) { cells.push(new Date(cur)); cur = addDays(cur, 1); }
  while (cells.length % 7 !== 0) { cells.push(new Date(cur)); cur = addDays(cur, 1); }

  const mk = `${y}-${pad(m + 1)}`;
  /* 标题格式：年份永远两位（26年10月），不再写 2026年 */
  setTitle(`${String(y).slice(-2)}年${m + 1}月`, '');
  const goals = planEditor('month', mk, planGroups('month', mk));

  const head = `<div class="weekday-row">${WK_ORDER.map((w) => `<div>周${w}</div>`).join('')}</div>`;

  const body = cells.map((d) => {
    const ds = ymd(d);
    const out = d.getMonth() !== m;
    const isToday = ds === state.today;
    const isMon = d.getDay() === 1;
    const day = state.days[ds] || { events: [], todos: [] };
    /* 最多 3 行，第 4 行起折成 +N：先保证每条都读得出来，再谈信息量 */
    const allEv = day.events || [];
    const evs = allEv.slice(0, MAX_LINES).map((e) => {
      const type = e.priority === 'high' ? 'high' : (e.allday ? 'allday' : 'normal');
      const time = e.allday ? '整日' : e.start;
      const loc = e.location ? `<span class="loc">${esc(e.location)}</span>` : '';
      return `<div class="ev${e.priority === 'high' ? ' high' : ''}" data-type="${type}">
        <time>${esc(time)}</time><span class="t">${esc(e.title)}</span>${loc}</div>`;
    }).join('') + (allEv.length > MAX_LINES
      ? `<div class="ev-more" title="还有 ${allEv.length - MAX_LINES} 条没显示">…</div>` : '');
    const open = (day.todos || []).filter((t) => !t.done).length;
    const dots = open ? `<div class="dots">${'<i class="dot warn"></i>'.repeat(Math.min(open, 4))}</div>` : '';
    /* 手机格只有 48px，文字一律不塞：换成「日期 + 类型色点」，点开看当天 */
    const cellBody = mobileQuery.matches ? mobileDots(allEv, open) : `${evs}${dots}`;
    /* past：今天之前的日子。他 2026-10-29 要求「已经过去的日子稍微放轻一点」——
       放进 class 里，好让 CSS 按「过去 / 今天之后」分档控制明度。 */
    const isPast = !isToday && ds < state.today;
    return `<div class="cell ${out ? 'out' : ''} ${isToday ? 'today' : ''} ${isPast ? 'past' : ''}" data-date="${ds}">
      <div class="cell-head">
        <span class="dnum">${d.getDate()}</span>
        <span class="cell-flags">${isToday ? '<span class="today-mark">今天</span>' : ''}${isMon && !isToday && !mobileQuery.matches ? `<span class="wnum" data-week="${isoWeek(d)}" title="${isoWeek(d)} 这一周">${parseInt(isoWeek(d).slice(-2), 10)}周</span>` : ''}</span>
      </div>
      ${cellBody}
    </div>`;
  }).join('');

  $('#main').innerHTML = goals + (mobileQuery.matches ? monthLegend() : '')
    + head + `<div class="grid">${body}</div>` + importHint();
  /* 先全部画出来，再按「实际占了几像素」决定留几条 —— 写死条数必然在某些字号/宽度下切半行 */
  requestAnimationFrame(trimMonthCells);
}

/* 导入入口提示：不另写第二份格式说明，直接指向库里的那份唯一权威（第八轮 §1-D 的硬要求，一直没落地） */
function importHint() {
  return `<div class="import-hint">`
    + `<span>不知道怎么用、怎么导课表、怎么换背景？把这份文件整个发给 AI：</span>`
    + `<code>使用说明.md</code>（仓库根目录）`
    + `</div>`;
}

/* 月格截止行：格底留出的那一行只放「…」。任何一条事件只要越过这条线，就整条不显示
   —— 不许出现「半行字」。他 2026-10-29：「地点单独一行，显示不全的干脆不要」。 */
function trimMonthCells() {
  if (mobileQuery.matches) return;          // 手机月格不渲染文字，只画线/条数
  const RESERVE = 26;                       // 与 .cell 的 padding-bottom 一致
  document.querySelectorAll('.cell[data-date]').forEach((cell) => {
    const old = cell.querySelector('.ev-more');
    if (old) old.remove();
    const evs = [...cell.querySelectorAll('.ev')];
    evs.forEach((e) => { e.style.display = ''; });
    if (!evs.length) return;
    const line = cell.getBoundingClientRect().bottom - RESERVE + 1;
    let hidden = 0;
    evs.forEach((e) => {
      if (hidden || e.getBoundingClientRect().bottom > line) {
        e.style.display = 'none';
        hidden += 1;
      }
    });
    if (hidden) {
      const more = document.createElement('div');
      more.className = 'ev-more';
      more.title = `还有 ${hidden} 条没显示`;
      more.textContent = '…';
      cell.appendChild(more);
    }
  });
}

window.addEventListener('resize', () => {
  if (!mobileQuery.matches && document.querySelector('.grid')) {
    requestAnimationFrame(trimMonthCells);
  }
});

/* ============ 周视图 ============ */function renderWeek() {
  const start = mondayOf(state.cursor);
  const iso = isoWeek(start);
  const weekNum = parseInt(iso.slice(-2), 10);
  const mobile = mobileQuery.matches;
  /* 标题格式：与月视图同口径，年月必现（26年10月），周号作后缀；跨月按周一所在月报 */
  const main = `${String(start.getFullYear()).slice(-2)}年${start.getMonth() + 1}月`;
  setTitle(main, `第 ${weekNum} 周`);

  const plan = state.weeks[iso];
  const goals = planEditor('week', iso, planGroups('week', iso));

  /* 先把整周的事件看一遍，决定时间轴要从几点画到几点 */
  fitHours([0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = addDays(start, i);
    return (state.days[ymd(d)] || {}).events || [];
  }));

  const heads = [];
  const alldayCells = [];
  const cols = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const ds = ymd(d);
    const isToday = ds === state.today;
    heads.push(`<div class="wcol-head ${isToday ? 'today' : ''}" data-date="${ds}">
      <span class="wd">周${WK[d.getDay()]}</span><b>${d.getDate()}</b></div>`);

    const day = state.days[ds] || { events: [] };
    const blocks = layoutEvents(day.events).map((p) => {
      const e = p.e, idx = p.idx;
      const top = toTop(e.start), h = toHeight(e.start, e.end);
      /* short = 34–53px 的块：手机周视图放了时间就只剩一行标题的高度，
         不加这个类的话第二行标题会被块的下边界切一半 */
      return `<div class="evblock${h < 34 ? ' tight' : ''}${h >= 34 && h < 54 ? ' short' : ''}${e.priority === 'high' ? ' high' : ''}${p.band ? ' band' : ''}" data-type="${e.priority === 'high' ? 'high' : 'normal'}"
        style="top:${top}px;height:${h}px;${laneGeometry(p, 3)}" data-date="${ds}" data-idx="${idx}"
        data-lane="${p.lane}" data-lanes="${p.lanes}">
        <div class="et">${esc(e.title)}${e.location ? `<span class="et-loc"> · ${esc(e.location)}</span>` : ''}</div>
        <div class="eh"><span class="tt">${esc(e.start)}–${esc(e.end)}</span>${e.location ? `<span class="tloc"> · ${esc(e.location)}</span>` : ''}</div></div>`;
    }).join('');
    /* 整日事项（原来叫「全天」）：点一下就能编辑，不再是个死标签 */
    const allday = (day.events || []).map((e, idx) => {
      if (!e.allday) return '';
      return `<div class="aday${e.priority === 'high' ? ' high' : ''}" data-type="allday" data-date="${ds}" data-idx="${idx}"
        title="${esc(e.title)}">${esc(e.title)}${e.location ? ' · ' + esc(e.location) : ''}</div>`;
    }).join('');
    /* 整日事项独占列头下的一行，不再压进时间轴的 07:00 区域 */
    alldayCells.push(`<div class="allday-cell">${allday}</div>`);
    cols.push(`<div class="day-col ${isToday ? 'today' : ''}" data-date="${ds}" style="height:${(H1 - H0) * PX}px">
      ${hourBars()}${blocks}</div>`);
  }

  const mobileGoals = `<details class="m-goals"><summary>本周重点 <span>${(plan && plan.goals ? plan.goals.length : 0)}</span></summary>
      <div class="m-goal-list">${planEditor('week', iso, planGroups('week', iso))}</div></details>`;

  /* 横向位置：30 秒自动重拉会整块重绘，不记住 scrollLeft 的话会被拽回今天 */
  const prevScroll = document.querySelector('.week-scroll');
  const keepX = prevScroll ? prevScroll.scrollLeft : null;

  $('#main').innerHTML = goals + `<div class="week-scroll">
    <div class="week-grid">
      <div class="wcol-head" style="border-left:0"></div>
      ${heads.join('')}
      <div class="allday-corner">整日</div>
      ${alldayCells.join('')}
      <div class="time-col">${hourCells()}</div>
      ${cols.join('')}
    </div></div>
    <div class="mobile-week-tools">${mobileGoals}</div>`;
  if (mobileQuery.matches) {
    requestAnimationFrame(() => {
      const sc = document.querySelector('.week-scroll');
      if (!sc) return;
      if (keepX != null) { sc.scrollLeft = keepX; return; }
      /* 首次进入本周：横向滚到今天那一列，否则默认停在周一，今天可能在屏幕外。
         用 DOM 里的 .wcol-head[data-date] 定位，不再自己算一遍日期——两套日期算法必然对不上。 */
      const ti = [...document.querySelectorAll('.week-grid .wcol-head[data-date]')]
        .findIndex((h) => h.dataset.date === state.today);
      if (ti > 0) sc.scrollLeft = ti * syncDayColWidth();
    });
  }
  if (mobileQuery.matches && state.scrollWeekToTime) {
    state.scrollWeekToTime = false;
    requestAnimationFrame(() => {
      const now = new Date();
      const y = toTop(`${pad(now.getHours())}:${pad(now.getMinutes())}`);
      $('#main').scrollTop = Math.max(0, y - ($('#main').clientHeight || 500) * 0.3);
    });
  }
}

/* ============ 日视图 ============ */
function renderDay() {
  const ds = ymd(state.cursor);
  const d = state.cursor;
  const isToday = ds === state.today;
  /* 标题格式：年月日必现，与月/周视图同口径 */
  setTitle(
    `${String(d.getFullYear()).slice(-2)}年${d.getMonth() + 1}月${d.getDate()}日`,
    `周${WK[d.getDay()]}`,
    isToday ? '今天' : '',
  );

  const day = state.days[ds] || { date: ds, events: [], todos: [] };
  const iso = isoWeek(d);
  const ym = ds.slice(0, 7);
  const plan = state.weeks[iso];
  const monthPlan = state.months[ym];

  fitHours([day.events || []]);

  const blocks = layoutEvents(day.events).map((p) => {
    const e = p.e, idx = p.idx;
    const h = toHeight(e.start, e.end);
    return `<div class="evblock${h < 34 ? ' tight' : ''}${e.priority === 'high' ? ' high' : ''}${p.band ? ' band' : ''}" data-type="${e.priority === 'high' ? 'high' : 'normal'}"
      style="top:${toTop(e.start)}px;height:${h}px;${laneGeometry(p, 6)}"
      data-date="${ds}" data-idx="${idx}" data-lane="${p.lane}" data-lanes="${p.lanes}">
      <div class="et">${esc(e.title)}${e.location ? `<span class="et-loc"> · ${esc(e.location)}</span>` : ''}</div>
      <div class="eh"><span class="tt">${esc(e.start)}–${esc(e.end)}</span>${e.location ? `<span class="tloc"> · ${esc(e.location)}</span>` : ''}</div></div>`;
  }).join('');

  /* 整日事项：点击直接进编辑弹窗（原来点了没反应） */
  const allday = (day.events || []).map((e, idx) => {
    if (!e.allday) return '';
    return `<div class="aday${e.priority === 'high' ? ' high' : ''}" data-type="allday" data-idx="${idx}" data-date="${ds}"
      title="点击编辑">${esc(e.title)}${e.location ? ' · ' + esc(e.location) : ''}</div>`;
  }).join('');

  const todos = (day.todos || []).map((t, i) => ({ t, i })).sort((a, b) => {
    const ah = a.t.priority === 'high', bh = b.t.priority === 'high';
    return ah === bh ? a.i - b.i : (ah ? -1 : 1);
  }).map(({ t, i }) => `<div class="todo${t.done ? ' done' : ''}${t.priority === 'high' ? ' high' : ''}" data-todo="${i}">
      <span class="box">${t.done ? '✓' : ''}</span><span class="txt">${esc(t.text)}</span>
      <button class="todo-priority" data-todo-priority="${i}" aria-pressed="${t.priority === 'high'}">${t.priority === 'high' ? '重点' : '标重点'}</button></div>`).join('')
    || '<div class="side-note">还没有待办</div>';

  /* 本周重点 / 本月目标：不再打勾（一整天做不完的粗任务，划了没意义），改成跳转。
     条目里写了 @2026-10-23 就跳到那天；没写就跳到对应的周 / 月 */
  const goalLink = (g, kind) => {
    /* 后端已把 @日期 从 text 拆到 date；保留 text 解析是为了兼容旧缓存数据 */
    const m = /@(\d{4}-\d{2}-\d{2})/.exec(g.text || '');
    const jump = g.date || (m && m[1]) || '';
    const txt = (g.text || '').replace(/@\d{4}-\d{2}-\d{2}/g, '').trim();
    return `<div class="goal-link${g.done ? ' done' : ''}" data-jump="${jump}" data-kind="${kind}">
      <span class="txt">${esc(txt)}</span><span class="go">›</span></div>`;
  };
  const weekGoals = plan && plan.goals.length
    ? plan.goals.map((g) => goalLink(g, 'week')).join('')
    : '<div class="side-note">本周还没有重点</div>';

  const monthGoals = monthPlan && monthPlan.goals.length
    ? monthPlan.goals.map((g) => goalLink(g, 'month')).join('')
    : '<div class="side-note">本月还没有目标</div>';
  const sideDrawer = (title, body) => `<details class="side-sec side-drawer" ${mobileQuery.matches ? '' : 'open'}>
    <summary>${esc(title)}</summary><div class="side-body">${body}</div></details>`;
  const notePreview = esc(day.note || '还没有备注').replace(/\n/g, '<br>');

  $('#main').innerHTML = `<div class="day-wrap">
    <div class="day-main">
      <div class="week-grid" style="grid-template-columns:54px 1fr;min-width:0">
        <div class="time-col">${hourCells()}</div>
        <div class="day-col${isToday ? ' today' : ''}" data-date="${ds}" style="height:${(H1 - H0) * PX}px">${hourBars()}${blocks}</div>
      </div>
    </div>
    <div class="day-side">
      <div class="side-sec"><button class="primary wide" data-add="event">＋ 新建日程</button></div>
      ${sideDrawer('整日事项', allday || '<div class="side-note">—</div>')}
      ${sideDrawer('待办', `<div class="todo-list" data-list="todos">${todos}</div><button class="add-btn" data-add="todo">＋ 新增待办</button>`)}
      ${sideDrawer('每日备注', `<div class="note-preview">${notePreview}</div><button class="add-btn" data-edit-note>编辑备注</button>`)}
      ${sideDrawer('本周重点', weekGoals)}
      ${sideDrawer('本月目标', monthGoals)}
    </div>
  </div>`;
}

/* ============ 弹窗 ============ */
function setTimeError(message) {
  const box = $('#ev-time-error');
  box.textContent = message || '';
  box.hidden = !message;
}

function syncEditorTimeState() {
  const allday = $('#ev-allday').checked;
  $('#ev-start').disabled = allday;
  $('#ev-end').disabled = allday;
  if (allday) setTimeError('');
}

function openEditor(date, ev, idx) {
  const isEdit = typeof idx === 'number' && idx >= 0;
  state.editing = { date, idx: isEdit ? idx : -1, ev: ev || null };
  $('#modal-title').textContent = isEdit ? '编辑日程' : '新建日程';
  $('#ev-title').value = ev ? ev.title : '';
  $('#ev-loc').value = ev ? (ev.location || '') : '';
  $('#ev-start').value = ev ? (ev.start || '09:00') : '09:00';
  $('#ev-end').value = ev ? (ev.end || '10:00') : '10:00';
  $('#ev-tags').value = ev ? (ev.tags || []).join(' ') : '';
  $('#ev-allday').checked = !!(ev && ev.allday);
  $('#ev-priority').checked = !!(ev && ev.priority === 'high');
  syncEditorTimeState();
  setTimeError('');
  $('#btn-del').hidden = !isEdit;
  $('#modal').hidden = false;
  setTimeout(() => $('#ev-title').focus(), 30);
}

function closeEditor() {
  $('#modal').hidden = true;
  state.editing = null;
}

async function submitEditor() {
  const ed = state.editing;
  if (!ed) return;
  const title = $('#ev-title').value.trim();
  if (!title) { $('#ev-title').focus(); return; }
  const date = ed.date;
  const day = state.days[date] || (state.days[date] = { date, events: [], todos: [] });
  const allday = $('#ev-allday').checked;
  const start = $('#ev-start').value;
  const end = $('#ev-end').value;
  if (!allday && (!Number.isFinite(timeMinutes(start)) || !Number.isFinite(timeMinutes(end)))) {
    setTimeError('请选择有效的开始和结束时间');
    return;
  }
  if (!allday && timeMinutes(end) <= timeMinutes(start)) {
    setTimeError('结束时间必须晚于开始时间');
    $('#ev-end').focus();
    return;
  }
  setTimeError('');
  const item = {
    title,
    start: allday ? '' : start,
    end: allday ? '' : end,
    location: $('#ev-loc').value.trim(),
    tags: $('#ev-tags').value.split(/[\s,，]+/).filter(Boolean),
    allday,
    priority: $('#ev-priority').checked ? 'high' : 'normal',
  };
  if (ed.idx >= 0) day.events[ed.idx] = item;
  else day.events.push(item);
  day.events.sort((a, b) => {
    if (!!a.allday !== !!b.allday) return a.allday ? -1 : 1;
    return (a.start || '').localeCompare(b.start || '');
  });
  closeEditor();
  await saveDay(date);
}

async function deleteEvent() {
  const ed = state.editing;
  if (!ed || ed.idx < 0) return;
  const day = state.days[ed.date];
  if (!day) return;
  const removed = day.events[ed.idx];
  day.deleted = (day.deleted || []).filter((x) => x.key !== eventKey(removed));
  day.deleted.push({ key: eventKey(removed), updatedAt: Date.now() });
  day.events.splice(ed.idx, 1);
  closeEditor();
  await saveDay(ed.date);
}

/* ============ 搜索 ============ */
let searchTimer = null;

function initSearch() {
  const inp = $('#search');
  const box = $('#results');
  inp.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = inp.value.trim();
    if (!q) { box.hidden = true; box.innerHTML = ''; return; }
    searchTimer = setTimeout(() => doSearch(q), 280);
  });
  inp.addEventListener('focus', () => {
    if (box.innerHTML && inp.value.trim()) box.hidden = false;
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { box.hidden = true; inp.blur(); }
    else if (e.key === 'Enter') {
      const first = box.querySelector('.r');
      if (first) first.click();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.searchbox')) box.hidden = true;
  });
}

function weekRangeText(iso) {
  const mon = isoWeekToMonday(iso);
  const sun = addDays(mon, 6);
  return `${mon.getMonth() + 1}/${mon.getDate()}–${sun.getMonth() + 1}/${sun.getDate()}`;
}

async function doSearch(q) {
  const box = $('#results');
  try {
    const r = await apiFetch('/api/search?q=' + encodeURIComponent(q), { cache: 'no-store' });
    const j = await r.json();
    if (!j.results || !j.results.length) {
      box.innerHTML = '<div class="empty">没找到</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = j.results.map((it) => {
      const yr = it.id.slice(0, 4);
      const label = it.kind === 'day' ? it.id
        : it.kind === 'week'
          ? `${yr} 第 ${parseInt(it.id.slice(-2), 10)} 周 · ${weekRangeText(it.id)}`
          : `${yr} 年 ${parseInt(it.id.slice(5), 10)} 月`;
      const sub = (it.hits || []).join(' · ');
      return `<div class="r" data-kind="${it.kind}" data-id="${it.id}">
        <div class="rid">${esc(label)}</div>${sub ? `<div class="rh">${esc(sub)}</div>` : ''}</div>`;
    }).join('');
    box.hidden = false;
    box.querySelectorAll('.r').forEach((el) => {
      el.onclick = () => jumpTo(el.dataset.kind, el.dataset.id);
    });
  } catch (e) {
    box.innerHTML = '<div class="empty">搜索失败</div>';
    box.hidden = false;
  }
}

async function showPhone() {
  try {
    const j = await (await apiFetch('/api/ping', { cache: 'no-store' })).json();
    $('#phone-url').textContent = `http://${j.lan}:${j.port}`;
    $('#phone-note').textContent =
      '首次访问要用用户名和密码（在程序目录 auth.json 里）。手机和电脑必须连同一个 WiFi。';
    $('#phone-panel').hidden = false;
  } catch (e) {
    alert('读不到服务地址，确认服务还在跑');
  }
}

function jumpTo(kind, id) {
  $('#results').hidden = true;
  $('#search').value = '';
  if (kind === 'day') {
    state.view = 'day';
    state.cursor = parseYmd(id);
  } else if (kind === 'week') {
    state.view = 'week';
    state.scrollWeekToTime = true;
    state.cursor = isoWeekToMonday(id);
  } else {
    state.view = 'month';
    const [y, m] = id.split('-').map(Number);
    state.cursor = new Date(y, m - 1, 1);
  }
  load();
}

/* ============ 交互绑定 ============ */
function bindStatic() {
  $('#login-form').onsubmit = (e) => { e.preventDefault(); login(); };
  $('#btn-day-note-close').onclick = () => { $('#day-note-panel').hidden = true; };
  $('#btn-day-note-save').onclick = saveDayNote;
  $('#btn-sticker').onclick = toggleSticker;
  $('#btn-prev').onclick = () => {
    if (state.view === 'month') state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() - 1, 1);
    else if (state.view === 'week') state.cursor = addDays(state.cursor, -7);
    else state.cursor = addDays(state.cursor, -1);
    load();
  };
  $('#btn-next').onclick = () => {
    if (state.view === 'month') state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1);
    else if (state.view === 'week') state.cursor = addDays(state.cursor, 7);
    else state.cursor = addDays(state.cursor, 1);
    load();
  };
  $('#btn-today').onclick = () => {
    state.cursor = new Date();
    if (state.view === 'week') state.scrollWeekToTime = true;
    load();
  };
  document.querySelectorAll('#view-switch button').forEach((b) => {
    b.onclick = () => {
      if (state.view === 'notes') saveCurrentNote(true);
      state.view = b.dataset.view;
      if (state.view === 'notes') {
        state.notePane = 'list';
        state.editingNote = null;
        state.noteFilter = 'all';
        state.noteSearch = '';
      }
      if (state.view === 'week') state.scrollWeekToTime = true;
      load();
    };
  });
  $('#btn-close').onclick = closeEditor;
  $('#btn-cancel').onclick = closeEditor;
  $('#btn-save').onclick = submitEditor;
  $('#btn-del').onclick = deleteEvent;
  $('#ev-allday').addEventListener('change', syncEditorTimeState);
  $('#ev-start').addEventListener('input', () => setTimeError(''));
  $('#ev-end').addEventListener('input', () => setTimeError(''));
  $('#btn-sync').onclick = async () => {
    state.online = true;
    status('同步中…');
    if (state.view === 'notes') await saveCurrentNote(true);
    await syncPending();
    await load();
  };
  $('#btn-phone').onclick = showPhone;
  $('#btn-phone-close').onclick = () => { $('#phone-panel').hidden = true; };
  $('#phone-panel').onclick = (e) => { if (e.target.id === 'phone-panel') $('#phone-panel').hidden = true; };
  $('#btn-copy').onclick = async () => {
    const url = $('#phone-url').textContent;
    try {
      await navigator.clipboard.writeText(url);
      $('#btn-copy').textContent = '已复制';
      setTimeout(() => { $('#btn-copy').textContent = '复制地址'; }, 1500);
    } catch (e) {
      const r = document.createRange();
      r.selectNodeContents($('#phone-url'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand('copy');
    }
  };
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeEditor(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
    if (e.key === 'Enter' && !$('#modal').hidden) submitEditor();
  });
}

/* 侧栏「新增待办」：就地插一个输入框，回车保存、Esc 取消 */
function openTodoInput() {
  const list = document.querySelector('[data-list="todos"]');
  if (!list || list.querySelector('.todo-new')) return;
  const inp = document.createElement('input');
  inp.className = 'todo-new';
  inp.placeholder = '写一条，回车保存，Esc 取消';
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const v = inp.value.trim();
    inp.remove();
    if (!save || !v) return;
    const ds = ymd(state.cursor);
    const day = state.days[ds] || (state.days[ds] = { date: ds, events: [], todos: [] });
    day.todos.push({ done: false, text: v, priority: 'normal' });
    saveDay(ds);
  };
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); return; }
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    finish(true);
  });
  inp.addEventListener('blur', () => finish(true));
  list.appendChild(inp);
  inp.focus();
}

function openDayNote() {
  const ds = ymd(state.cursor);
  const day = state.days[ds] || { date: ds, events: [], todos: [], note: '' };
  $('#day-note-content').value = day.note || '';
  $('#day-note-panel').hidden = false;
  setTimeout(() => $('#day-note-content').focus(), 30);
}
async function saveDayNote() {
  const ds = ymd(state.cursor);
  const day = state.days[ds] || (state.days[ds] = { date: ds, events: [], todos: [], note: '' });
  day.note = $('#day-note-content').value;
  const ok = await saveDay(ds);
  if (ok || state.offlineReady) $('#day-note-panel').hidden = true;
}

/* 时段浮层：×、点遮罩、Esc 三种都能关；关完焦点回到触发它的 +N 按钮。
   注意浮层在 #main 外面，事件必须挂在 document 上，不能靠 #main 的委托。 */
function bindPeriodPop() {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-pop-close]')) { e.stopPropagation(); closePeriodPop(); return; }
    if (t.id === 'pop-backdrop') { e.stopPropagation(); closePeriodPop(); return; }
    const pe = t.closest('[data-pop-ev]');
    if (pe) {
      e.stopPropagation();
      const ds = pe.dataset.date;
      const i = Number(pe.dataset.popEv);
      closePeriodPop(false);
      if (state.days[ds] && state.days[ds].events[i]) openEditor(ds, state.days[ds].events[i], i);
      return;
    }
    // 点浮层以外的空白也关（遮罩万一被别的东西盖住时的兜底）
    const pop = $('#period-pop');
    /* 点月格是「打开当天列表」，别被这条兜底立刻关掉（换一格会重新打开该天） */
    if (pop && !pop.hidden && !t.closest('#period-pop') && !t.closest('[data-period]') && !t.closest('.cell')) closePeriodPop();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const pop = $('#period-pop');
    if (pop && !pop.hidden) { e.preventDefault(); closePeriodPop(); return; }
    const modal = $('#modal');
    if (modal && !modal.hidden) { e.preventDefault(); closeEditor(); return; }
    const phone = $('#phone-panel');
    if (phone && !phone.hidden) { e.preventDefault(); phone.hidden = true; }
  });
}

function bindMain() {
  $('#main').addEventListener('click', (e) => {
    const newBtn = e.target.closest('[data-note-new]');
    if (newBtn) { newNote(); return; }
    const backBtn = e.target.closest('[data-note-back]');
    if (backBtn) { backToNoteList(); return; }
    const folderRename = e.target.closest('[data-folder-rename]');
    if (folderRename) { e.stopPropagation(); renameFolder(folderRename.dataset.folderRename); return; }
    const folderDelete = e.target.closest('[data-folder-delete]');
    if (folderDelete) { e.stopPropagation(); deleteFolder(folderDelete.dataset.folderDelete); return; }
    const folderNew = e.target.closest('[data-folder-new]');
    if (folderNew) { e.stopPropagation(); createFolder(); return; }
    const sortBtn = e.target.closest('[data-note-sort]');
    if (sortBtn) {
      state.noteSort = state.noteSort === 'updated' ? 'created' : 'updated';
      renderNotes();
      return;
    }
    const filterBtn = e.target.closest('[data-note-filter]');
    if (filterBtn) {
      saveCurrentNote(true);
      state.noteFilter = filterBtn.dataset.noteFilter;
      updateNoteFilters();
      updateNoteList();
      return;
    }
    const noteCard = e.target.closest('[data-note-id]');
    if (noteCard) {
      const note = state.notes.find((n) => n.id === noteCard.dataset.noteId && !n.deleted);
      if (note) openNote(note);
      return;
    }
    const pinBtn = e.target.closest('[data-note-pin]');
    if (pinBtn) { toggleCurrentNotePin(); return; }
    const delBtn = e.target.closest('[data-note-delete]');
    if (delBtn) { deleteCurrentNote(); return; }
    const editNote = e.target.closest('[data-edit-note]');
    if (editNote) { openDayNote(); return; }
    const wn = e.target.closest('.wnum');
    if (wn) {
      e.stopPropagation();
      state.view = 'week';
      state.scrollWeekToTime = true;
      state.cursor = parseYmd(wn.closest('.cell').dataset.date);
      load();
      return;
    }
    const moreBtn = e.target.closest('[data-period]');
    if (moreBtn) {
      e.stopPropagation();
      openPeriodPop(moreBtn.dataset.period, moreBtn.dataset.idxs, moreBtn);
      return;
    }
    const block = e.target.closest('.evblock, .ev-line');
    if (block) {
      e.stopPropagation();
      const date = block.dataset.date;
      const idx = Number(block.dataset.idx);
      openEditor(date, state.days[date].events[idx], idx);
      return;
    }
    const whead = e.target.closest('.wcol-head[data-date]');
    if (whead) {
      state.view = 'day';
      state.cursor = parseYmd(whead.dataset.date);
      load();
      return;
    }
    /* 月目标 / 关键节点 / 本周重点：就地编辑，一律按唯一 id 操作 */
    const planToggle = e.target.closest('[data-plan-toggle]');
    if (planToggle) {
      e.stopPropagation();
      e.preventDefault();
      const box = planToggle.closest('.goals');
      const grp = planToggle.closest('.grp');
      const uid = planToggle.closest('.g').dataset.uid;
      mutatePlan(box, grp.dataset.planField,
        (arr) => arr.map((x) => (x.id === uid ? { ...x, done: !x.done } : x)));
      return;
    }
    const planDel = e.target.closest('[data-plan-del]');
    if (planDel) {
      e.stopPropagation();
      e.preventDefault();
      const box = planDel.closest('.goals');
      const grp = planDel.closest('.grp');
      const uid = planDel.closest('.g').dataset.uid;
      mutatePlan(box, grp.dataset.planField, (arr) => arr.filter((x) => x.id !== uid));
      return;
    }
    const planAdd = e.target.closest('[data-plan-add]');
    if (planAdd) {
      e.stopPropagation();
      e.preventDefault();
      const box = planAdd.closest('.goals');
      const field = planAdd.dataset.planAdd;
      mutatePlan(box, field, (arr) => [...arr, { id: planUid(), done: false, text: '' }])
        .then(() => {
          const fresh = document.querySelector(
            `.goals[data-plan-kind="${box.dataset.planKind}"][data-plan-key="${box.dataset.planKey}"]`
            + ` .grp[data-plan-field="${field}"] .g:last-of-type .g-text`);
          if (fresh) fresh.focus();
        });
      return;
    }
    const planJump = e.target.closest('[data-plan-jump]');
    if (planJump) {
      e.stopPropagation();
      state.view = 'day';
      state.cursor = parseYmd(planJump.dataset.planJump);
      load();
      return;
    }
    /* 日视图侧栏的旧版目标行：点了跳转 */
    const goal = e.target.closest('.goal-link');
    if (goal) {
      e.stopPropagation();
      const jump = goal.dataset.jump;
      if (jump) {
        state.view = 'day'; state.cursor = parseYmd(jump);
      } else if (goal.dataset.kind === 'week') {
        state.view = 'week'; state.cursor = mondayOf(state.cursor);
      } else {
        state.view = 'month';
        state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1);
      }
      load();
      return;
    }

    /* 日视图侧栏的「新建日程」：显式入口，不靠点空白时间轴 */
    const addEv = e.target.closest('[data-add="event"]');
    if (addEv) {
      e.stopPropagation();
      openEditor(ymd(state.cursor), null, -1);
      return;
    }

    /* 整日事项：点一下进编辑 */
    const aday = e.target.closest('.aday');
    if (aday) {
      e.stopPropagation();
      const d2 = state.days[aday.dataset.date];
      const i2 = Number(aday.dataset.idx);
      if (d2 && d2.events[i2]) openEditor(aday.dataset.date, d2.events[i2], i2);
      return;
    }

    const addBtn = e.target.closest('[data-add="todo"]');
    if (addBtn) {
      e.stopPropagation();
      openTodoInput();
      return;
    }

    const priorityBtn = e.target.closest('[data-todo-priority]');
    if (priorityBtn) {
      e.stopPropagation();
      const ds = ymd(state.cursor);
      const day = state.days[ds];
      const i = Number(priorityBtn.dataset.todoPriority);
      if (day && day.todos[i]) {
        day.todos[i].priority = day.todos[i].priority === 'high' ? 'normal' : 'high';
        saveDay(ds);
      }
      return;
    }
    const todo = e.target.closest('[data-todo]');
    if (todo) {
      const ds = ymd(state.cursor);
      const day = state.days[ds];
      const i = Number(todo.dataset.todo);
      if (day && day.todos[i]) { day.todos[i].done = !day.todos[i].done; saveDay(ds); }
      return;
    }
    const cell = e.target.closest('.cell');
    if (cell) {
      const ds = cell.dataset.date;
      const day = state.days[ds];
      /* 手机月格只画色点，点一下先弹出当天列表；当天没日程才跳日视图 */
      if (mobileQuery.matches && day && (day.events || []).length) {
        openPeriodPop(ds, (day.events || []).map((_, i) => i).join(','), cell,
          { title: `共 ${day.events.length} 条`, withTodos: true });
        return;
      }
      state.view = 'day';
      state.cursor = parseYmd(ds);
      load();
      return;
    }
    const col = e.target.closest('.day-col[data-date]');
    if (col) {
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const h = Math.floor(y / PX) + H0;
      const m = Math.floor(((y % PX) / PX) * 4) * 15;
      const startMinutes = Math.min(h * 60 + m, 23 * 60 + 45);
      /* 最后一档 23:45 不再生成 23:45–23:45；当天最晚收到 23:59 */
      const endMinutes = Math.min(startMinutes + 60, 23 * 60 + 59);
      openEditor(col.dataset.date, {
        title: '', start: timeText(startMinutes), end: timeText(endMinutes), tags: [], allday: false,
      }, -1);
    }
  });

  $('#main').addEventListener('input', (e) => {
    if (e.target.classList && e.target.classList.contains('g-text')) {
      const box = e.target.closest('.goals');
      const grp = e.target.closest('.grp');
      const uid = e.target.closest('.g').dataset.uid;
      planTouch(box, grp.dataset.planField, uid, e.target.textContent);
      return;
    }
    if (e.target.id === 'note-search') {
      state.noteSearch = e.target.value;
      updateNoteList();
      return;
    }
    if ((e.target.id !== 'note-editor-text' && e.target.id !== 'note-title-input') || !state.editingNote) return;
    if (e.target.id === 'note-title-input') state.editingNote.title = e.target.value;
    else state.editingNote.text = e.target.value;
    state.noteDirty = true;
    state.noteSaveStatus = '正在输入…';
    const statusEl = document.querySelector('#note-save-status');
    if (statusEl) statusEl.textContent = state.noteSaveStatus;
    if (noteSaveTimer) clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => saveCurrentNote(), 800);
  });

  $('#main').addEventListener('change', (e) => {
    if (e.target.id === 'note-folder') moveCurrentNote(e.target.value);
  });

  $('#main').addEventListener('focusout', (e) => {
    if (e.target.classList && e.target.classList.contains('g-text')) {
      const box = e.target.closest('.goals');
      const grp = e.target.closest('.grp');
      const uid = e.target.closest('.g').dataset.uid;
      updatePlanText(box, grp.dataset.planField, uid, e.target.textContent);
      const kind = box.dataset.planKind;
      const key = box.dataset.planKey;
      if (kind && key) postPlan(kind, key, planData(kind, key));
      return;
    }
    if (e.target.id === 'note-editor-text' || e.target.id === 'note-title-input') saveCurrentNote(true);
  });
}

/* ============ 重点日程提醒（仅页面打开时） ============ */

/* 手机连接状态：三行分别判断，卡在哪一步就说哪一步，不用「未启用」一句糊过去 */
function connLine(key, text, ok) {
  const li = document.querySelector(`#conn-state li[data-conn="${key}"]`);
  if (!li) return;
  const b = li.querySelector('b');
  if (b) b.textContent = text;
  li.classList.toggle('ok', !!ok);
  li.classList.toggle('bad', !ok);
  li.dataset.ok = ok ? '1' : '0';
}

const CA_CLOSED_KEY = 'schedule-ca-card-closed-until';
const CA_CLOSED_MS = 7 * 86400000;

function caClosedUntil() {
  try { return Number(localStorage.getItem(CA_CLOSED_KEY) || 0) || 0; } catch (e) { return 0; }
}

function setCaState(st) {
  const box = $('#https-help');
  if (!box) return;
  box.dataset.state = st;
  const sum = $('#https-summary');
  if (sum) sum.setAttribute('aria-expanded', String(st === 'open'));
}

function toggleCaCard() {
  const box = $('#https-help');
  if (!box || box.hidden) return;
  setCaState(box.dataset.state === 'open' ? 'collapsed' : 'open');
}

function closeCaCard() {
  setCaState('closed');
  try { localStorage.setItem(CA_CLOSED_KEY, String(Date.now() + CA_CLOSED_MS)); } catch (e) { /* 隐私模式 */ }
  status('离线提示 7 天内不再出现');
}

function reopenCaCard() {
  try { localStorage.removeItem(CA_CLOSED_KEY); } catch (e) { /* ignore */ }
  setupHttpsHelp();
}

async function setupHttpsHelp() {
  const box = $('#https-help');
  if (!box || typeof location === 'undefined') return;
  const host = location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (local) { box.hidden = true; return; }

  // 夸克：页面能用，但没有「添加到主屏幕」；给一行轻提示，不弹窗
  const ua = navigator.userAgent || '';
  const isQuark = /Quark/i.test(ua);
  const qt = $('#quark-tip');
  if (qt) {
    qt.hidden = !isQuark;
    if (isQuark) {
      qt.textContent = '夸克：页面正常用；夸克本身没有「添加到主屏幕」，用「收藏」固定本页；'
        + '自签证书必须装成「CA 证书」，装完请重启夸克再打开 https 地址。';
    }
  }
  const qh = $('#quark-help');
  if (qh) qh.hidden = !isQuark;

  if (caClosedUntil() > Date.now()) { box.hidden = true; return; }
  box.hidden = false;
  if (box.dataset.state === 'closed') setCaState('collapsed');

  const target = $('#https-target');
  if (target) target.textContent = `https://${host}:8771`;
  const protoOk = location.protocol === 'https:';
  connLine('proto', protoOk ? 'https ✓' : 'http ✗（现在用的是 http，不是证书没生效）', protoOk);

  // 证书是否被信任：用不需要登录的静态文件探，避免把“401 没登录”误判成“证书没装”
  let certOk = false;
  let certWhy;
  if (!protoOk) {
    certWhy = '未验证（第 1 步：先用 https 地址打开）';
  } else {
    try {
      const r = await fetch('/manifest.json', { cache: 'no-store' });
      certOk = !!r && r.ok;
      certWhy = certOk ? '已信任 ✓' : `未通过（第 2 步：静态资源返回 ${r && r.status}）`;
    } catch (e) {
      certWhy = '未通过（第 2 步：证书没被信任，确认装成「CA 证书」）';
    }
  }
  connLine('cert', certWhy, certOk);

  // 离线缓存：注册 → 缓存资源 → 接管页面，三段分开报
  let swState = '不支持（浏览器没有 Service Worker）';
  let swOk = false;
  if ('serviceWorker' in navigator) {
    if (!window.isSecureContext) {
      swState = '不可用（不是安全上下文，必须 https）';
    } else {
      try {
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        if (!reg) {
          swState = '未完成（第 1 步：注册 Service Worker 超时，刷新一次）';
        } else {
          let controller = navigator.serviceWorker.controller;
          if (!controller) {
            // 刚注册完接管会晚一两百毫秒，等一小会儿再判定，别急着报红
            controller = await new Promise((resolve) => {
              const done = (v) => { clearTimeout(timer); resolve(v); };
              const timer = setTimeout(() => done(!!navigator.serviceWorker.controller), 1500);
              navigator.serviceWorker.addEventListener('controllerchange', () => done(true), { once: true });
            });
          }
          if (controller) {
            swState = '已接管 ✓';
            swOk = true;
          } else {
            swState = '已注册未接管（第 3 步：刷新一次让页面被接管）';
          }
        }
      } catch (e) {
        swState = '失败（第 1 步：注册报错 ' + (e.message || e) + '）';
      }
    }
  }
  connLine('sw', swState, swOk);

  const allOk = protoOk && certOk && swOk;
  box.classList.toggle('ready', allOk);

  /* 状态点必须配文字：绿=已就绪、橙=未就绪、灰=离线。只靠颜色看不懂 */
  const hhmm = (ts) => (ts ? new Date(ts).toTimeString().slice(0, 5) : '—');
  const isOffline = navigator.onLine === false;
  const sumText = $('#https-summary-text');
  if (sumText) {
    sumText.textContent = isOffline
      ? `离线 · 上次同步 ${hhmm(state.lastSync)}`
      : (allOk ? `离线已就绪 · ${hhmm(Date.now())}` : '离线未就绪 · 查看');
  }
  box.dataset.conn = isOffline ? 'offline' : (allOk ? 'ready' : 'pending');

  const why = $('#conn-why');
  if (why) {
    if (allOk) why.textContent = '三项都通过：现在断网也能从主屏打开。';
    else if (!protoOk) why.textContent = `卡在第 1 项：请改用 https://${host}:8771 打开，http 下浏览器不允许离线缓存。`;
    else if (!certOk) why.textContent = '卡在第 2 项：证书没被信任。到系统里确认装的是「CA 证书」，装完重启浏览器。';
    else why.textContent = '卡在第 3 项：缓存还没接管页面，刷新一次再看。';
  }

  // 三项没全绿时默认也折叠，只留一行，别一直占屏幕
  if (box.dataset.state !== 'open') setCaState('collapsed');
}


/* ============ 启动 ============ */
mobileQuery.addEventListener('change', () => { syncHourPixels(); render(); });
if (window.addEventListener) {
  window.addEventListener('resize', () => { requestAnimationFrame(() => fitTitle()); });
}
if (window.addEventListener) {
  window.addEventListener('online', () => {
    state.online = true;
    updateSyncStatus();
    syncPending().then(() => { if (!state.noteDirty) load(true); });
  });
  window.addEventListener('offline', () => { state.online = false; updateSyncStatus(); });
}
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => { $('#sync-info').textContent = '应用壳缓存未启用'; });
}
setupHttpsHelp();
const caSummaryBtn = $('#https-summary');
if (caSummaryBtn) caSummaryBtn.onclick = toggleCaCard;
const caCloseBtn = $('#https-close');
if (caCloseBtn) caCloseBtn.onclick = closeCaCard;
const caShowBtn = $('#btn-show-ca-card');
if (caShowBtn) {
  caShowBtn.onclick = () => {
    reopenCaCard();
    const panel = $('#phone-panel');
    if (panel) panel.hidden = true;
  };
}
const recheckBtn = $('#btn-recheck');
if (recheckBtn) {
  recheckBtn.onclick = () => {
    document.querySelectorAll('#conn-state li').forEach((li) => {
      const b = li.querySelector('b');
      if (b) b.textContent = '检测中…';
      li.classList.remove('ok', 'bad');
    });
    setupHttpsHelp();
  };
}
/* 仅供自动化/调试：?view=week&d=2026-10-25 直接落到指定视图与日期，正常访问不生效 */
try {
  const qs = new URLSearchParams(location.search);
  const v = qs.get('view');
  if (v && ['month', 'week', 'day', 'notes'].includes(v)) state.view = v;
  const d = qs.get('d');
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) state.cursor = parseYmd(d);
} catch (e) { /* ignore */ }

bindStatic();
bindMain();
bindPeriodPop();
bindVerReload();
initSearch();
/* 版本号：一律从服务端 /api/ping 取，前端不写死——写死就又会变成「看不到最新版是什么」 */
/* 版本号：一律从服务端取，前端不写死——写死就又会变成「看不到最新版是什么」。
   页面版本 = 服务端吐 index.html 时注入的那份（meta 标签）；
   服务版本 = /api/ping 现查。两者不一致说明有一个是旧进程，必须显式说出来。 */
function pageVersion() {
  const meta = (name) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? (el.getAttribute('content') || '') : '';
  };
  return { version: meta('app-version'), build: meta('app-build') };
}

function verBanner(text) {
  const box = $('#ver-banner');
  if (!box) return;
  if (!text) { box.hidden = true; return; }
  $('#ver-banner-text').textContent = text;
  box.hidden = false;
}

/* 清掉 Service Worker 与缓存再刷新：换版本后第一次打开必然是旧页面（staleWhileRevalidate），
   这个按钮让它当场变新，不用教用户「刷两次」。 */
function bindVerReload() {
  const btn = $('#ver-reload');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) { /* 清不掉也照样刷新 */ }
    location.reload();
  });
}

async function showVersion() {
  const el = $('#ver');
  if (!el) return;
  const page = pageVersion();
  try {
    const j = await (await apiFetch('/api/ping', { cache: 'no-store' })).json();
    const srvVer = j.version || '';
    const boot = j.bootAtText || '';
    const realPort = j.realPort || j.port || '';
    const pageVer = page.version || '';
    const same = !!pageVer && !!srvVer && pageVer === srvVer;

    el.textContent = `页面 v${pageVer || '?'} ｜ 服务 v${srvVer || '旧进程'}`;
    if (!same) {
      const dot = document.createElement('i');
      dot.className = 'ver-dot';
      el.appendChild(dot);
    }
    el.title = [
      `页面版本：v${pageVer || '?'}（${page.build || '?'}）`,
      `服务版本：v${srvVer || '旧进程，没有 version 字段'}（${j.build || '?'}）`,
      `服务进程：pid ${j.pid || '?'}，${boot || '?'} 启动`,
      `监听端口：${realPort || '?'}（配置里是 ${j.port || '?'}）`,
      `数据目录：${j.vault || '?'}`,
    ].join('\n');
    el.hidden = false;

    if (same) {
      verBanner('');
    } else {
      const why = !srvVer
        ? `服务端是旧进程（${boot || '未知时刻'} 启动，没有版本字段）`
        : `页面与服务版本不一致（页面 ${pageVer}／服务 ${srvVer}）`;
      verBanner(`${why} —— 新版界面重启后才生效：桌面窗关掉重开，网页端双击「启动.vbs」。`);
    }
  } catch (e) { /* 拿不到就先不显示，别占地方 */ }
}

(async () => {
  await initOffline();
  await syncPending();
  await load();
  await showVersion();
})();
setInterval(() => {
  if ($('#modal').hidden && $('#login-panel').hidden && !document.hidden && !state.noteDirty) syncPending().then(() => load(true));
}, 30000);

/* 仅供自动化自检：URL 带 ?selftest=1 时暴露内部状态，正常访问完全不生效 */
try {
  if (new URLSearchParams(location.search).has('selftest')) {
    window.__selftest = { state, render, openPeriodPop, closePeriodPop, setTitle, mobileQuery, setupHttpsHelp };
  }
} catch (e) { /* ignore */ }
