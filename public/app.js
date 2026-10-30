/*
  Architecture
  - Server (Express + SQLite) is the source of truth; this file only renders and calls /api.
  - RemoteStore: cached /api/admin/state for the admin views; Kiosk only talks to /api/kiosk.
  - Pay / format helpers are the same modules the server uses (/shared/*.js), so numbers always match.
  - Views: render functions returning auto-escaped `html` templates.
  - Actions / Forms / Changes / Inputs: one delegated listener per event type (data-act, data-submit, …).
*/
import { H, MIN, DAYS, pad, num, clamp, trunc, initials, ymd, toLocalInput, fromLocalInput, fmtTime, fmtDay, fmtStamp,
  fmtHM, fmtMin, fmtElapsed, money as fmtMoney, startOfWeek, addDays, niceStep, csvBuild } from '/shared/format.js';
import * as Pay from '/shared/pay.js';
import { api } from '/api.js';

// ---------- Utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Auto-escaping templates: every ${value} is HTML-escaped unless it is already a Safe fragment.
const ESC = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
class Safe { constructor(s){ this.s = s; } toString(){ return this.s; } }
const part = v => v == null || v === false ? '' : v instanceof Safe ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v);
const html = (strings, ...vals) => new Safe(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));

const currency = () => RemoteStore.state?.settings.currency ?? Kiosk.info?.currency ?? '$';
const money = n => fmtMoney(n, currency());

function saveBlob(name, blob){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const download = (name, text, type) => saveBlob(name, new Blob([text], {type}));
// Server-generated files (Excel, PDF, backups) — errors become toasts.
async function downloadFile(path){
  Toast.show('Preparing download…', {ms:1500});
  try{
    const { blob, name } = await api.file(path);
    saveBlob(name, blob);
  }catch(e){ if(e.status !== 401) Toast.show(e.message, {ms:4000}); }
}

// ---------- Remote store (admin only) ----------
const RemoteStore = {
  state: null,
  get undoLabel(){ return RemoteStore.state?.undoLabel ?? null; },
  async refresh(){ RemoteStore.state = await api.get('/api/admin/state'); },
  // Mutation → refresh → re-render. Returns the response, or null after showing the server's message.
  // A failed refresh after a successful mutation is NOT a failed mutation (re-submitting would duplicate it).
  async call(method, path, body){
    let res;
    try{ res = await api[method](path, body); }
    catch(e){
      if(e.status !== 401) Toast.show(e.message, {ms:4000});
      return null;
    }
    try{ await RemoteStore.refresh(); render(); }
    catch(e){ if(e.status !== 401) Toast.show('Saved, but could not reload the data. Check the connection.', {ms:4000}); }
    return res ?? {};
  }
};
const db = () => RemoteStore.state;
const empById = id => db().employees.find(e => e.id === id);
const empName = id => empById(id)?.name ?? '(deleted)';
const openBreak = sh => sh && sh.breaks.find(b => b.end == null);

// ---------- Toast & modal ----------
const Toast = (() => {
  let t;
  return {
    show(msg, { ms = 3500, action } = {}){
      const el = $('#toast');
      el.innerHTML = html`<span>${msg}</span>${action ? html`<button class="sm" data-act="${action.act}">${action.label}</button>` : ''}`;
      el.classList.remove('hidden');
      clearTimeout(t); t = setTimeout(() => el.classList.add('hidden'), action ? Math.max(ms, 6000) : ms);
    }
  };
})();

const Modal = (() => {
  const root = () => $('#modal'), box = () => $('#modalBox');
  let lastFocus = null, resolver = null;
  const api_ = {
    typed: null,
    isOpen: () => !root().classList.contains('hidden'),
    open(content){
      if(!api_.isOpen()) lastFocus = document.activeElement;
      resolver?.(false); resolver = null; api_.typed = null;
      box().innerHTML = content;
      root().classList.remove('hidden');
      (box().querySelector('[autofocus]') || box().querySelector('input,select,button'))?.focus();
    },
    close(result = false){
      if(!api_.isOpen()) return;
      root().classList.add('hidden'); box().innerHTML = '';
      const r = resolver; resolver = null; r?.(result);
      if(lastFocus?.isConnected) lastFocus.focus();
    },
    confirm(message, { title = 'Are you sure?', ok = 'Confirm', typed = null } = {}){
      api_.open(html`<form data-submit="confirmOk"><h2 id="modalTitle">${title}</h2><p>${message}</p>
        ${typed ? html`<label for="cfTyped">Type ${typed} to confirm</label><input id="cfTyped" name="typed" autocomplete="off" autofocus>` : ''}
        <div class="row" style="margin-top:18px"><button class="inv" type="submit" ${typed ? '' : 'autofocus'}>${ok}</button><button type="button" data-act="modalCancel">Cancel</button></div></form>`);
      api_.typed = typed;
      return new Promise(res => { resolver = res; });
    },
    onKey(ev){
      if(ev.key === 'Escape'){ ev.preventDefault(); api_.close(false); return; }
      if(ev.key !== 'Tab') return;
      const f = $$('button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])', box()).filter(el => el.offsetParent !== null);
      if(!f.length) return;
      const first = f[0], last = f.at(-1);
      if(ev.shiftKey && document.activeElement === first){ last.focus(); ev.preventDefault(); }
      else if(!ev.shiftKey && document.activeElement === last){ first.focus(); ev.preventDefault(); }
    }
  };
  return api_;
})();

// ---------- Charts ----------
function barChart(items, { ref = null, height = 230, fmt = fmtHM } = {}){
  const W = 640, L = 44, R = 8, T = 22, B = 30, plotW = W - L - R, plotH = height - T - B;
  const n = Math.max(items.length, 1), slot = plotW / n, bw = Math.min(56, slot * 0.68);
  const top = Math.max(1, ref ?? 0, ...items.map(i => i.value));
  const step = niceStep(top / 4), max = Math.ceil(top * 1.08 / step) * step;
  const y = v => T + plotH - (v / max) * plotH;
  const ticks = []; for(let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  return html`<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${items.map(i => `${i.label}: ${fmt(i.value)}`).join(', ')}">
    ${ticks.map(v => html`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="s-grid"/>
      <text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="c-muted">${Math.round(v * 10) / 10}h</text>`)}
    ${items.map((it, i) => {
      const x = L + slot * i + (slot - bw) / 2;
      return html`<g><title>${it.label}: ${fmt(it.value)}</title>
        <rect x="${x}" y="${y(it.value)}" width="${bw}" height="${Math.max(0, y(0) - y(it.value))}" class="c-ink"/>
        ${it.value > 0 ? html`<text x="${x + bw / 2}" y="${y(it.value) - 6}" text-anchor="middle" class="c-ink" font-weight="700">${fmt(it.value)}</text>` : ''}
        <text x="${x + bw / 2}" y="${height - 10}" text-anchor="middle" class="c-ink">${trunc(it.label, Math.max(3, Math.floor(slot / 8)))}</text></g>`;
    })}
    <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="s-ink" stroke-width="2"/>
    ${ref ? html`<line x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}" class="s-warn" stroke-width="2" stroke-dasharray="6 4"/>
      <text x="${W - R}" y="${y(ref) - 6}" text-anchor="end" class="c-warn" font-weight="700">${ref}h</text>` : ''}
  </svg>`;
}

// Week timeline: one row per day, shifts drawn by time of day, breaks hatched, overlaps stacked in lanes.
function timeline(ws, empFilter){
  const now = Date.now(), a = +ws, b = +addDays(ws, 7);
  const list = db().shifts.filter(s => (!empFilter || s.empId === empFilter) && s.in < b && (s.out ?? now) > a);
  const W = 1000, L = 84, R = 10, T = 26, rowH = 38, Ht = T + rowH * 7 + 6;
  const X = h => L + (h / 24) * (W - L - R);
  const rows = DAYS.map((d, i) => {
    const ds = +addDays(ws, i), de = +addDays(ws, i + 1), span = (de - ds) / H;
    const hx = t => X(((t - ds) / H) * 24 / span);
    const segs = list.map(s => ({ s, from: Math.max(s.in, ds), to: Math.min(s.out ?? now, de) }))
      .filter(g => g.to > g.from).sort((p, q) => p.from - q.from);
    const laneEnd = [];
    for(const g of segs){
      let l = laneEnd.findIndex(t => t <= g.from);
      if(l < 0){ l = laneEnd.length; laneEnd.push(0); }
      laneEnd[l] = g.to; g.lane = l;
    }
    const lh = (rowH - 8) / Math.max(1, laneEnd.length), y0 = T + i * rowH + 4;
    return html`<g>
      <text x="${L - 10}" y="${T + i * rowH + rowH / 2 + 4}" text-anchor="end" class="c-ink" font-weight="700">${d} ${new Date(ds).getDate()}</text>
      <line x1="${L}" x2="${W - R}" y1="${T + (i + 1) * rowH}" y2="${T + (i + 1) * rowH}" class="s-grid"/>
      ${segs.map(g => {
        const e = empById(g.s.empId), x1 = hx(g.from), x2 = hx(g.to), y = y0 + g.lane * lh, open = g.s.out == null;
        return html`<g class="tl-shift" data-act="editShift" data-id="${g.s.id}">
          <title>${e?.name ?? '(deleted)'} · ${fmtTime(g.s.in)}–${open ? 'now' : fmtTime(g.s.out)}</title>
          <rect x="${x1}" y="${y}" width="${Math.max(2, x2 - x1)}" height="${lh - 2}" class="${open ? 'c-paper s-ink' : 'c-ink'}" stroke-width="2"/>
          ${g.s.breaks.map(bk => {
            const f = Math.max(bk.start, g.from), t = Math.min(bk.end ?? now, g.to);
            return t > f ? html`<rect x="${hx(f)}" y="${y}" width="${Math.max(1, hx(t) - hx(f))}" height="${lh - 2}" fill="url(#hatch)" class="s-ink" stroke-width="1"/>` : '';
          })}
          ${x2 - x1 > 34 && lh > 12 ? html`<text x="${x1 + 5}" y="${y + lh / 2 + 3}" class="${open ? 'c-ink' : 'c-paper'}" font-size="11" font-weight="700">${initials(e?.name)}</text>` : ''}
        </g>`;
      })}
      ${now >= ds && now < de ? html`<line x1="${hx(now)}" x2="${hx(now)}" y1="${y0 - 3}" y2="${y0 + rowH - 5}" class="s-warn" stroke-width="2"/>` : ''}
    </g>`;
  });
  return html`<svg class="chart" viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Shift timeline for the week">
    <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" class="c-paper"/><line x1="0" y1="0" x2="0" y2="6" class="s-ink" stroke-width="2.5"/></pattern></defs>
    ${[0,3,6,9,12,15,18,21,24].map(h => html`<line x1="${X(h)}" x2="${X(h)}" y1="${T - 4}" y2="${Ht - 6}" class="s-grid"/>
      <text x="${X(h)}" y="${T - 9}" text-anchor="middle" class="c-muted" font-size="11">${pad(h % 24)}:00</text>`)}
    ${rows}
  </svg>`;
}

// ---------- UI state ----------
const app = $('#app');
const ui = { view: 'kiosk', tab: 'dashboard', weekStart: startOfWeek(new Date()), shiftFilter: '', empQuery: '', auditQuery: '', auditRows: [], sort: { k: 'name', dir: 1 }, showPins: false };

function applyTheme(){
  const t = (ui.view === 'admin' ? db()?.settings.theme : Kiosk.info?.theme) ?? 'auto';
  if(t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function render(){ applyTheme(); ui.view === 'kiosk' ? Kiosk.render() : Admin.render(); }
function tickLive(now = Date.now()){
  $$('[data-elapsed]').forEach(el => el.textContent = fmtElapsed(now - +el.dataset.elapsed));
  $$('[data-countdown]').forEach(el => el.textContent = Math.max(0, Math.ceil((+el.dataset.countdown - now) / 1000)));
}

// ---------- Kiosk ----------
// The kiosk only ever talks to /api/kiosk: it can identify one employee by code and punch for them.
const Kiosk = {
  info: null, pin: '', heldPin: '', current: null, idleT: 0, idleDeadline: 0, lockUntil: 0, busy: false,
  async loadInfo(){
    try{ Kiosk.info = await api.get('/api/kiosk/info'); }catch{ /* offline: keep last info */ }
    if(ui.view === 'kiosk'){ applyTheme(); Kiosk.tick(Date.now()); }
  },
  render(){
    app.innerHTML = html`
      <header class="bar"><div class="brand">${Kiosk.info?.company ?? 'Time Clock'}</div>
        <button class="sm" data-act="openAdmin">Admin</button></header>
      <main class="kiosk">
        <section class="card clockcard" aria-label="Current time">
          <div class="big" id="clk"></div><div class="date" id="dt"></div>
          <div class="onnow" id="onnow"></div>
        </section>
        <section class="card" id="pad" aria-live="polite"></section>
      </main>`;
    Kiosk.tick(Date.now());
    Kiosk.current ? Kiosk.renderEmp() : Kiosk.renderPad();
  },
  tick(now){
    const c = $('#clk'); if(!c) return;
    const n = new Date(now), info = Kiosk.info;
    c.textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
    $('#dt').textContent = n.toLocaleDateString([], {weekday:'long', day:'numeric', month:'long', year:'numeric'});
    $('#onnow').textContent = !info ? 'Connecting…' : info.hasEmployees
      ? `ON SHIFT: ${info.onShift}  ·  ON BREAK: ${info.onBreak}`
      : 'No staff added yet';
    if(Kiosk.lockUntil && now >= Kiosk.lockUntil){ Kiosk.lockUntil = 0; if(!Kiosk.current) Kiosk.renderPad(); }
  },
  renderPad(){
    const box = $('#pad'); if(!box) return;
    const locked = Date.now() < Kiosk.lockUntil, n = Kiosk.pin.length;
    const keys = ['1','2','3','4','5','6','7','8','9','C','0','<'];
    box.innerHTML = html`
      <div class="lbl">${locked ? html`Too many attempts — wait <span data-countdown="${Kiosk.lockUntil}"></span>s` : 'Enter your 4-digit code'}</div>
      <div class="pins" id="pins" aria-label="${n} of 4 digits entered">${[0,1,2,3].map(i => html`<span class="${i < n ? 'f' : ''}">${i < n ? '●' : ''}</span>`)}</div>
      <div class="keys">${keys.map(k => html`<button data-act="press" data-k="${k}" ${locked ? 'disabled' : ''}
        aria-label="${k === 'C' ? 'Clear' : k === '<' ? 'Delete' : k}">${k === '<' ? '⌫' : k}</button>`)}</div>`;
    tickLive();
  },
  press(k){
    if(Kiosk.current || Kiosk.busy || Date.now() < Kiosk.lockUntil) return;
    if(k === 'C') Kiosk.pin = '';
    else if(k === '<') Kiosk.pin = Kiosk.pin.slice(0, -1);
    else if(/^\d$/.test(k) && Kiosk.pin.length < 4) Kiosk.pin += k;
    Kiosk.renderPad();
    if(Kiosk.pin.length === 4) setTimeout(Kiosk.submit, 120);
  },
  async submit(){
    if(Kiosk.pin.length !== 4 || Kiosk.busy) return;
    const pin = Kiosk.pin;
    Kiosk.pin = ''; Kiosk.busy = true;
    try{
      Kiosk.current = await api.post('/api/kiosk/identify', { pin });
      Kiosk.heldPin = pin;
      Kiosk.renderEmp();
    }catch(e){
      if(e.status === 429) Kiosk.lockUntil = Date.now() + (e.data.retryAfter ?? 30) * 1000;
      Kiosk.renderPad(); $('#pins')?.classList.add('shake');
      Toast.show(e.status === 401 ? 'Code not recognised' : e.message, {ms:1800});
    }finally{ Kiosk.busy = false; }
  },
  reset(rerender){
    Kiosk.current = null; Kiosk.pin = ''; Kiosk.heldPin = ''; clearTimeout(Kiosk.idleT);
    if(rerender) Kiosk.renderPad();
  },
  statusHTML(sh, now){
    if(!sh) return html`NOT CLOCKED IN`;
    const b = sh.breaks.find(x => x.end == null);
    if(b) return html`ON BREAK <b data-elapsed="${b.start}"></b><br><small>Since ${fmtTime(b.start)} · clocked in ${fmtTime(sh.in)}</small>`;
    const taken = sh.breaks.reduce((a, x) => a + Math.max(0, Math.round(((x.end ?? now) - x.start) / MIN)), 0);
    return html`ON SHIFT <b data-elapsed="${sh.in}"></b><br><small>Since ${fmtTime(sh.in)} · break taken ${fmtMin(taken)}</small>`;
  },
  renderEmp(){
    const box = $('#pad'); if(!box) return;
    const cur = Kiosk.current; if(!cur) return Kiosk.reset(true);
    const now = Date.now(), sh = cur.shift, onBreak = sh?.breaks.some(b => b.end == null);
    const tier = num(Kiosk.info?.tierHours), pct = tier ? clamp(cur.weekPaid / tier, 0, 1) : 1;
    const acts = !sh ? html`<button class="inv" data-act="punch" data-k="in" data-primary>Clock in</button>`
      : onBreak ? html`<button class="inv" data-act="punch" data-k="be" data-primary>End break</button><button data-act="punch" data-k="out">Clock out</button>`
      : html`<button class="inv" data-act="punch" data-k="bs" data-primary>Start break</button><button data-act="punch" data-k="out">Clock out</button>`;
    Kiosk.idleDeadline = now + Math.max(5, num(Kiosk.info?.kioskIdleSec) || 20) * 1000;
    box.innerHTML = html`
      <div class="lbl">Hello</div><div class="name">${cur.employee.name}</div>
      <div class="status">${Kiosk.statusHTML(sh, now)}</div>
      <div class="mini"><div><span class="k">Today</span><b>${fmtHM(cur.todayPaid)}</b></div><div><span class="k">This week</span><b>${fmtHM(cur.weekPaid)}</b></div></div>
      ${tier ? html`<div class="progress" role="progressbar" aria-label="Paid hours this week" aria-valuemin="0" aria-valuemax="${tier}" aria-valuenow="${cur.weekPaid.toFixed(2)}"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>
        <small>${fmtHM(cur.weekPaid)} of ${tier}h standard hours this week</small>` : ''}
      <div class="acts">${acts}<button class="sm" data-act="kioskCancel">Cancel · <span data-countdown="${Kiosk.idleDeadline}"></span>s</button></div>`;
    clearTimeout(Kiosk.idleT); Kiosk.idleT = setTimeout(() => Kiosk.reset(true), Kiosk.idleDeadline - now);
    tickLive(now);
  },
  async punch(type){
    const pin = Kiosk.heldPin;
    if(!Kiosk.current || !pin || Kiosk.busy) return;
    Kiosk.busy = true;
    $$('#pad button').forEach(b => b.disabled = true);
    try{
      const r = await api.post('/api/kiosk/punch', { pin, type });
      const c = r.calc, at = fmtTime(r.at);
      Toast.show({
        in: `${r.name} clocked IN at ${at}`,
        bs: `${r.name} — break started at ${at}`,
        be: `${r.name} — break ended. Back on shift.`,
        out: `${r.name} clocked OUT at ${at} · Worked ${fmtHM(c.total)} − break ${fmtMin(c.ded)} = PAID ${fmtHM(c.paid)}`,
      }[r.type], {ms:6000});
    }catch(e){ Toast.show(e.message, {ms:3000}); }
    finally{
      Kiosk.busy = false;
      Kiosk.reset(true);
      Kiosk.loadInfo();
    }
  }
};

// ---------- Admin ----------
const Admin = {
  lastActive: 0, refreshedAt: 0, lockUntil: 0,
  tabs: [['dashboard','Dashboard'],['report','Weekly Report'],['shifts','Shifts'],['employees','Employees'],['audit','Audit Log'],['settings','Settings']],
  loginModal(){
    const locked = Date.now() < Admin.lockUntil;
    Modal.open(html`<form data-submit="adminLogin"><h2 id="modalTitle">Admin access</h2>
      <label for="apin">Admin PIN</label><input id="apin" name="pin" type="password" inputmode="numeric" autocomplete="off" autofocus>
      <p class="muted" id="loginMsg" aria-live="polite">${locked ? html`Locked — try again in <span data-countdown="${Admin.lockUntil}"></span>s` : ''}</p>
      <div class="row"><button class="inv" type="submit">Enter</button><button type="button" data-act="modalCancel">Cancel</button></div></form>`);
    tickLive();
  },
  // Always end the server session, unless the server already told us it is gone (401).
  async logout(reason, { sessionGone = false } = {}){
    const wasAdmin = ui.view === 'admin';
    // Leave admin view before awaiting, so the 1 s idle tick cannot trigger a second logout meanwhile.
    ui.view = 'kiosk';
    if(wasAdmin && !sessionGone) await api.post('/api/auth/logout').catch(() => {});
    RemoteStore.state = null;
    Modal.close(false);
    await Kiosk.loadInfo();
    render(); if(reason) Toast.show(reason);
  },
  async refresh(){
    Admin.refreshedAt = Date.now();
    try{ await RemoteStore.refresh(); if(ui.view === 'admin' && !Modal.isOpen()) Admin.render(); }catch{ /* 401 handled by api.onUnauthorized */ }
  },
  tick(now){
    if(now - Admin.lastActive > Math.max(1, num(db()?.settings.adminTimeoutMin) || 5) * MIN){ Admin.logout('Admin session locked after inactivity'); return; }
    if(ui.tab === 'dashboard' && now - Admin.refreshedAt > 30000) Admin.refresh();
  },
  render(){
    if(!db()) return;
    const s = db(), undoLabel = RemoteStore.undoLabel, alerts = Pay.anomalies(s, startOfWeek(new Date())).length;
    app.innerHTML = html`
      <header class="bar noprint"><div class="brand">${s.settings.company}<span class="hide-sm"> · Admin</span></div>
        <div class="row tight">
          ${undoLabel ? html`<button class="sm" data-act="undo" title="Undo: ${undoLabel}" aria-label="Undo ${undoLabel}">↶<span class="hide-sm"> Undo ${trunc(undoLabel, 18)}</span></button>` : ''}
          <button class="sm" data-act="themeCycle" title="Theme: ${s.settings.theme}" aria-label="Switch theme">◐<span class="hide-sm"> ${s.settings.theme}</span></button>
          <button class="sm inv" data-act="logout">Lock<span class="hide-sm"> · Back to clock</span></button>
        </div></header>
      <nav class="tabs noprint" role="tablist">${Admin.tabs.map(([k, l]) => html`<button role="tab" aria-selected="${ui.tab === k}" class="${ui.tab === k ? 'on' : ''}" data-act="tab" data-k="${k}">${l}${k === 'dashboard' && alerts ? html` <span class="badge" aria-label="${alerts} alerts">${alerts}</span>` : ''}</button>`)}</nav>
      <main class="wrap">${Views[ui.tab]()}</main>`;
    tickLive();
  },
  async loadAudit(){
    try{ ui.auditRows = await api.get(`/api/admin/audit?limit=300&q=${encodeURIComponent(ui.auditQuery.trim())}`); }catch{ ui.auditRows = []; }
    const body = $('#auditRows'); if(body) body.innerHTML = Views.auditRows();
  }
};

// ---------- Views ----------
const kpi = (k, v, cls = '') => html`<div class="kpi ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`;
const rateCell = v => v === '' || v == null ? html`<b>not set</b>` : money(num(v));
function weekNav(){
  const end = addDays(ui.weekStart, 6);
  return html`<div class="row weeknav noprint">
    <button class="sm" data-act="week" data-k="-1">◀ Prev</button>
    <b>${fmtDay(ui.weekStart)} – ${fmtDay(end)} ${end.getFullYear()}</b>
    <button class="sm" data-act="week" data-k="1">Next ▶</button>
    <button class="sm" data-act="weekToday">This week</button>
    <input type="date" style="width:auto" value="${ymd(ui.weekStart)}" data-change="weekPick" aria-label="Jump to week">
  </div>`;
}
function breakRow(b){
  return html`<div class="grid dyn">
    <div><label>Break start</label><input type="datetime-local" name="bs" value="${toLocalInput(b?.start)}"></div>
    <div><label>Break end</label><input type="datetime-local" name="be" value="${toLocalInput(b?.end)}"></div>
    <button type="button" class="sm" data-act="removeRow" aria-label="Remove break">✕</button></div>`;
}
function ruleRow(r){
  return html`<div class="grid dyn rule" style="max-width:520px">
    <div><label>Shift ≥ hours</label><input type="number" step="0.25" min="0" name="rh" value="${r.h}"></div>
    <div><label>Break minutes</label><input type="number" step="1" min="0" name="rm" value="${r.m}"></div>
    <button type="button" class="sm" data-act="removeRow" aria-label="Remove rule">✕</button></div>`;
}
const SORTS = { name: r => r.e.name.toLowerCase(), total: r => r.total, paid: r => r.paid, gross: r => r.gross, net: r => r.net };
function sortRows(rows){
  const f = SORTS[ui.sort.k] || SORTS.name, d = ui.sort.dir;
  return rows.sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * d; });
}
const weekParam = () => `week=${ymd(ui.weekStart)}`;

const Views = {
  dashboard(){
    const now = Date.now(), s = db(), ws = startOfWeek(now), tier = num(s.settings.tierHours);
    const rows = Pay.week(s, ws, now), T = Pay.totals(rows), alerts = Pay.anomalies(s, ws, now);
    const open = s.shifts.filter(x => x.out == null).sort((a, b) => a.in - b.in), onBreak = open.filter(openBreak).length;
    return html`
      <div class="kpis">
        ${kpi('On shift now', open.length - onBreak)}${kpi('On break now', onBreak)}
        ${kpi('Paid hours · week', fmtHM(T.paid))}${kpi('Net payroll · week', money(T.net))}
        ${kpi('Active staff', s.employees.filter(e => e.active !== false).length)}${kpi('Alerts', alerts.length, alerts.length ? 'alert' : '')}
      </div>
      <div class="cols">
        <div class="section"><h3>On the clock now (${open.length})</h3>
          ${open.length ? html`<div class="tablewrap" style="box-shadow:none"><table class="stack">
            <thead><tr><th class="l">Employee</th><th>In</th><th>Elapsed</th><th class="l">Status</th><th>Break</th><th></th></tr></thead>
            <tbody>${open.map(sh => { const b = openBreak(sh), c = Pay.shift(sh, s.settings, now); return html`<tr>
              <td class="l head">${empName(sh.empId)}</td>
              <td data-label="In">${fmtTime(sh.in)}${ymd(sh.in) !== ymd(now) ? html` <small>${fmtDay(sh.in)}</small>` : ''}</td>
              <td data-label="Elapsed" data-elapsed="${sh.in}"></td>
              <td class="l" data-label="Status">${b ? html`<span class="tag">ON BREAK</span>` : html`<span class="tag b">WORKING</span>`}</td>
              <td data-label="Break">${fmtMin(c.actual)}</td>
              <td data-label=""><button class="sm" data-act="forceOut" data-id="${sh.id}">Clock out</button></td></tr>`; })}</tbody>
          </table></div>` : html`<span class="muted">Nobody is clocked in.</span>`}
        </div>
        <div class="section"><h3>Alerts (${alerts.length})</h3>
          ${alerts.length ? html`<ul class="alerts">${alerts.map(a => html`<li class="lvl-${a.level}"><span>${a.msg}</span>
            ${a.shiftId ? html`<button class="sm" data-act="editShift" data-id="${a.shiftId}">Fix</button>`
              : a.empId ? html`<button class="sm" data-act="editEmp" data-id="${a.empId}">Fix</button>`
              : a.tab ? html`<button class="sm" data-act="tab" data-k="${a.tab}">Open</button>` : ''}</li>`)}</ul>`
          : html`<span class="muted">All clear.</span>`}
        </div>
      </div>
      <div class="cols">
        <div class="section"><h3>Paid hours by day · this week</h3>${barChart(DAYS.map((d, i) => ({ label: d, value: T.days[i] })))}</div>
        <div class="section"><h3>Paid hours by employee</h3>
          ${rows.some(r => r.paid > 0) ? barChart(rows.filter(r => r.paid > 0).map(r => ({ label: r.e.name, value: r.paid })), { ref: tier || null })
            : html`<span class="muted">No hours recorded this week yet.</span>`}</div>
      </div>`;
  },

  report(){
    const s = db(), tier = num(s.settings.tierHours), rows = sortRows(Pay.week(s, ui.weekStart)), T = Pay.totals(rows), end = addDays(ui.weekStart, 6);
    const th = (k, label, cls = '') => html`<th class="${cls}" aria-sort="${ui.sort.k === k ? (ui.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">
      <button class="thbtn" data-act="sort" data-k="${k}">${label}${ui.sort.k === k ? (ui.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
    return html`${weekNav()}
      <h2 class="title">Weekly hours & pay · ${fmtDay(ui.weekStart)} – ${fmtDay(end)} ${end.getFullYear()}</h2>
      <div class="tablewrap"><table class="stack">
        <thead><tr>${th('name', 'Employee', 'l')}${DAYS.map(d => html`<th>${d}</th>`)}${th('total', 'Worked')}<th>Break</th>${th('paid', 'Paid hrs')}
          <th>First ${tier}h</th><th>After ${tier}h</th>${th('gross', 'Gross')}<th>+ Allow.</th><th>− Deduct.</th>${th('net', 'Net pay')}<th class="noprint"></th></tr></thead>
        <tbody>
        ${rows.length ? rows.map(r => html`<tr>
          <td class="l head"><a href="#" class="lnk" style="color:inherit;font-weight:700" data-act="showShifts" data-id="${r.e.id}">${r.e.name}</a>${r.open ? html` <span class="tag b">ON</span>` : ''}</td>
          ${r.days.map((d, i) => html`<td class="d" data-label="${DAYS[i]}">${d ? fmtHM(d) : html`<span class="muted">–</span>`}</td>`)}
          <td data-label="Worked">${fmtHM(r.total)}</td><td data-label="Break">${fmtMin(r.ded)}</td><td data-label="Paid hrs"><b>${fmtHM(r.paid)}</b><br class="hide-sm"><small class="hide-sm">${r.paid.toFixed(2)}h</small></td>
          <td data-label="First ${tier}h"><span>${r.h1.toFixed(2)}h × ${r.r1 ? money(r.r1) : html`<b>?</b>`}<br><small>${money(r.p1)}</small></span></td>
          <td data-label="After ${tier}h"><span>${r.h2.toFixed(2)}h × ${r.r2 ? money(r.r2) : html`<b>?</b>`}<br><small>${money(r.p2)}</small></span></td>
          <td data-label="Gross">${money(r.gross)}</td><td data-label="+ Allowances">${money(r.allow)}</td><td data-label="− Deductions">${money(r.deduct)}</td><td class="net" data-label="Net pay">${money(r.net)}</td>
          <td class="noprint" data-label=""><button class="sm" data-act="adjust" data-id="${r.e.id}">± Adjust</button>
            <button class="sm" data-act="payslip" data-id="${r.e.id}">Payslip</button></td></tr>`)
          : html`<tr><td class="l" colspan="19"><span class="muted">No employees yet.</span></td></tr>`}
        ${rows.length ? html`<tr class="tot"><td class="l head">TOTAL</td>${T.days.map((d, i) => html`<td class="d" data-label="${DAYS[i]}">${fmtHM(d)}</td>`)}
          <td data-label="Worked">${fmtHM(T.total)}</td><td data-label="Break">${fmtMin(T.ded)}</td><td data-label="Paid hrs">${fmtHM(T.paid)}</td><td data-label="First ${tier}h"><span>${T.h1.toFixed(2)}h<br><small>${money(T.p1)}</small></span></td>
          <td data-label="After ${tier}h"><span>${T.h2.toFixed(2)}h<br><small>${money(T.p2)}</small></span></td><td data-label="Gross">${money(T.gross)}</td><td data-label="+ Allowances">${money(T.allow)}</td><td data-label="− Deductions">${money(T.deduct)}</td><td class="net" data-label="Net pay">${money(T.net)}</td><td class="noprint hide-sm"></td></tr>` : ''}
        </tbody>
      </table></div>
      <div class="row noprint actions-grid">
        <button class="inv" data-act="exportXlsx">Excel (.xlsx)</button>
        <button class="inv" data-act="exportPdf">PDF report</button>
        <button class="inv" data-act="payslipsAll">Payslips PDF</button>
        <button data-act="print">Print</button><button data-act="exportReport">Payroll CSV</button><button data-act="exportShifts">Shifts CSV</button>
      </div>`;
  },

  shifts(){
    const s = db(), a = +ui.weekStart, b = +addDays(ui.weekStart, 7), now = Date.now();
    const list = s.shifts.filter(x => x.in >= a && x.in < b && (!ui.shiftFilter || x.empId === ui.shiftFilter)).sort((x, y) => x.in - y.in);
    return html`${weekNav()}
      <div class="row">
        <select style="width:auto" data-change="shiftFilter" aria-label="Filter by employee">
          <option value="">All employees</option>
          ${s.employees.map(e => html`<option value="${e.id}" ${ui.shiftFilter === e.id ? 'selected' : ''}>${e.name}</option>`)}
        </select>
        <button class="inv" data-act="addShift">+ Add shift</button>
      </div>
      <div class="section"><h3>Timeline</h3>
        <div class="scrollx">${timeline(ui.weekStart, ui.shiftFilter)}</div>
      </div>
      <div class="tablewrap"><table class="stack">
        <thead><tr><th class="l">Employee</th><th class="l">Date</th><th>In</th><th>Out</th><th class="l">Breaks taken</th>
          <th>Worked</th><th>Break taken</th><th>Break by rule</th><th>Deducted</th><th>Paid</th><th></th></tr></thead>
        <tbody>
        ${list.length ? list.map(sh => { const c = Pay.shift(sh, s.settings, now); return html`<tr>
          <td class="l head">${empName(sh.empId)}<span class="sm-only"> · ${fmtDay(sh.in)}</span></td><td class="l hide-sm" data-label="Date">${fmtDay(sh.in)}</td><td data-label="In">${fmtTime(sh.in)}</td>
          <td data-label="Out">${sh.out ? html`<span>${fmtTime(sh.out)}${ymd(sh.out) !== ymd(sh.in) ? html` <small>+1d</small>` : ''}</span>` : html`<span class="tag b">ON CLOCK</span>`}</td>
          <td class="l" data-label="Breaks">${sh.breaks.length ? sh.breaks.map((bk, i) => html`${i ? html`<br>` : ''}${fmtTime(bk.start)}–${bk.end ? fmtTime(bk.end) : '…'}`) : html`<span class="muted">none</span>`}</td>
          <td data-label="Worked">${fmtHM(c.total)}</td><td class="hide-sm" data-label="Break taken">${fmtMin(c.actual)}</td><td class="hide-sm" data-label="Break by rule">${fmtMin(c.policy)}</td><td data-label="Deducted">${fmtMin(c.ded)}</td><td data-label="Paid"><b>${fmtHM(c.paid)}</b></td>
          <td data-label=""><button class="sm" data-act="editShift" data-id="${sh.id}">Edit</button> <button class="sm" data-act="delShift" data-id="${sh.id}" aria-label="Delete shift">✕</button></td></tr>`; })
        : html`<tr><td class="l" colspan="11"><span class="muted">No shifts this week.</span></td></tr>`}
        </tbody>
      </table></div>`;
  },

  employees(){
    const st = db().settings, tier = num(st.tierHours);
    return html`<form class="section" data-submit="empAdd"><h3>Add employee</h3>
        <div class="grid">
          <div><label for="eName">Name</label><input id="eName" name="name" required autocomplete="off"></div>
          <div><label for="ePin">4-digit code</label><input id="ePin" name="pin" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required autocomplete="off"></div>
          <div><label for="eR1">Rate first ${tier}h (${st.currency}/h)</label><input id="eR1" name="rate1" type="number" step="0.01" min="0"></div>
          <div><label for="eR2">Rate after ${tier}h (${st.currency}/h)</label><input id="eR2" name="rate2" type="number" step="0.01" min="0"></div>
        </div>
        <div class="row tight"><button class="inv" type="submit">Add employee</button><button type="button" class="sm" data-act="suggestPin">Suggest a free code</button></div>
      </form>
      <div class="row">
        <input type="search" placeholder="Search employees…" value="${ui.empQuery}" data-input="empSearch" style="max-width:320px" aria-label="Search employees">
        <button class="sm" data-act="togglePins">${ui.showPins ? 'Hide' : 'Show'} codes</button>
      </div>
      <div class="tablewrap"><table class="stack">
        <thead><tr><th class="l">Name</th><th>Code</th><th>Rate first ${tier}h</th><th>Rate after ${tier}h</th><th>Paid this week</th><th class="l">Status</th><th></th></tr></thead>
        <tbody id="empRows">${Views.empRows()}</tbody>
      </table></div>`;
  },
  empRows(){
    const q = ui.empQuery.trim().toLowerCase();
    const week = new Map(Pay.week(db(), startOfWeek(new Date())).map(r => [r.e.id, r.paid]));
    const list = db().employees.filter(e => !q || e.name.toLowerCase().includes(q))
      .sort((a, b) => (a.active === false) - (b.active === false) || a.name.localeCompare(b.name));
    if(!list.length) return html`<tr><td class="l" colspan="7"><span class="muted">${q ? 'No matches.' : 'No employees yet.'}</span></td></tr>`;
    return html`${list.map(e => html`<tr>
      <td class="l head">${e.name}</td><td data-label="Code">${ui.showPins ? e.pin : '••••'}</td><td data-label="Rate 1">${rateCell(e.rate1)}</td><td data-label="Rate 2">${rateCell(e.rate2)}</td>
      <td data-label="Paid this week">${fmtHM(week.get(e.id) ?? 0)}</td>
      <td class="l" data-label="Status">${e.active === false ? html`<span class="tag">INACTIVE</span>` : html`<span class="tag b">ACTIVE</span>`}</td>
      <td data-label=""><button class="sm" data-act="editEmp" data-id="${e.id}">Edit</button> <button class="sm" data-act="showShifts" data-id="${e.id}">Shifts</button></td></tr>`)}`;
  },

  audit(){
    return html`<div class="row">
        <input type="search" placeholder="Search log…" value="${ui.auditQuery}" data-input="auditSearch" style="max-width:320px" aria-label="Search audit log">
        <button class="sm" data-act="exportAudit">Export CSV</button>
      </div>
      <div class="tablewrap"><table class="stack">
        <thead><tr><th class="l">When</th><th class="l">Who</th><th class="l">Action</th><th class="l">Detail</th></tr></thead>
        <tbody id="auditRows">${Views.auditRows()}</tbody>
      </table></div>`;
  },
  auditRows(){
    const list = ui.auditRows;
    if(!list.length) return html`<tr><td class="l" colspan="4"><span class="muted">${ui.auditQuery.trim() ? 'No matches.' : 'Nothing logged yet.'}</span></td></tr>`;
    return html`${list.map(a => html`<tr><td class="l" data-label="When">${fmtStamp(a.ts)}</td><td class="l" data-label="Who">${a.actor}</td><td class="l" data-label="Action"><b>${a.action}</b></td><td class="l wrap-text" data-label="Detail">${a.detail}</td></tr>`)}`;
  },

  settings(){
    const st = db().settings;
    const opt = (v, cur, label) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`;
    return html`<form data-submit="settingsSave">
        <div class="section"><h3>General</h3><div class="grid">
          <div><label for="sComp">Business name</label><input id="sComp" name="company" value="${st.company}"></div>
          <div><label for="sCur">Currency symbol</label><input id="sCur" name="currency" value="${st.currency}" maxlength="4"></div>
          <div><label for="sTier">Rate 1 covers first … hours/week</label><input id="sTier" name="tierHours" type="number" step="0.5" min="0" value="${st.tierHours}"></div>
          <div><label for="sTheme">Theme</label><select id="sTheme" name="theme">${opt('auto', st.theme, 'Follow device')}${opt('light', st.theme, 'Light')}${opt('dark', st.theme, 'Dark')}</select></div>
        </div></div>
        <div class="section"><h3>Break rules</h3>
          <div id="rules">${st.breakRules.map(ruleRow)}</div>
          <div class="row"><button type="button" class="sm" data-act="addRule">+ Add rule</button></div>
          <label for="sMode">How to deduct the break</label>
          <select id="sMode" name="breakMode" style="max-width:520px">
            ${opt('greater', st.breakMode, 'Whichever is MORE: break by rule or actual break taken')}
            ${opt('policy', st.breakMode, 'Always the break by rule')}
            ${opt('actual', st.breakMode, 'Only the actual break taken (clocked)')}
          </select>
        </div>
        <div class="section"><h3>Kiosk & safety</h3><div class="grid">
          <div><label for="sIdle">Kiosk auto-cancel (seconds)</label><input id="sIdle" name="kioskIdleSec" type="number" min="5" step="1" value="${st.kioskIdleSec}"></div>
          <div><label for="sAdm">Admin auto-lock (minutes)</label><input id="sAdm" name="adminTimeoutMin" type="number" min="1" step="1" value="${st.adminTimeoutMin}"></div>
          <div><label for="sMax">Flag open shifts longer than (hours)</label><input id="sMax" name="maxShiftHours" type="number" min="1" step="0.5" value="${st.maxShiftHours}"></div>
        </div></div>
        <div class="row"><button class="inv" type="submit">Save settings</button></div>
      </form>
      <form class="section" data-submit="pinChange" style="margin-top:22px"><h3>Change admin PIN</h3>
        <div class="grid">
          <div><label for="pCur">Current PIN</label><input id="pCur" name="current" type="password" autocomplete="off" required></div>
          <div><label for="pNew">New PIN (4+ characters)</label><input id="pNew" name="next" type="password" autocomplete="off" minlength="4" required></div>
          <div><label for="pRep">Repeat new PIN</label><input id="pRep" name="repeat" type="password" autocomplete="off" minlength="4" required></div>
        </div>
        <button class="inv" type="submit">Update PIN</button>
      </form>
      <div class="section"><h3>Backup</h3>
        <div class="row tight"><button data-act="backup">Download backup</button>
          <label class="btn" style="margin:0">Restore from backup<input type="file" accept=".json,application/json" class="sr" data-change="importFile"></label>
          <button data-act="erase">Erase all data</button></div>
      </div>`;
  }
};

// ---------- Dialogs ----------
const Dialogs = {
  adjust(empId){
    const e = empById(empId); if(!e) return;
    const list = db().adj[`${ymd(ui.weekStart)}|${empId}`] || [];
    Modal.open(html`<h2 id="modalTitle">Allowances & deductions</h2>
      <p style="margin-top:0"><b>${e.name}</b> · week of ${fmtDay(ui.weekStart)}</p>
      <div class="tablewrap"><table>
        <thead><tr><th class="l">Type</th><th class="l">Description</th><th>Amount</th><th></th></tr></thead>
        <tbody>${list.length ? list.map(x => html`<tr><td class="l">${x.type === 'allowance' ? '+ Allowance' : '− Deduction'}</td><td class="l">${x.label}</td><td>${money(num(x.amount))}</td>
          <td><button class="sm" data-act="delAdj" data-id="${x.id}" data-emp="${empId}" aria-label="Remove">✕</button></td></tr>`)
          : html`<tr><td class="l" colspan="4"><span class="muted">None this week.</span></td></tr>`}</tbody>
      </table></div>
      <form data-submit="adjAdd" data-id="${empId}">
        <div class="grid">
          <div><label for="aType">Type</label><select id="aType" name="type"><option value="allowance">+ Allowance</option><option value="deduction">− Deduction</option></select></div>
          <div><label for="aLabel">Description</label><input id="aLabel" name="label" placeholder="e.g. Travel, Uniform, Advance"></div>
          <div><label for="aAmt">Amount</label><input id="aAmt" name="amount" type="number" step="0.01" min="0.01" required></div>
        </div>
        <div class="row"><button class="inv" type="submit">Add</button><button type="button" data-act="modalCancel">Done</button></div>
      </form>`);
  },
  shift(id){
    const s = db();
    if(!s.employees.length) return Toast.show('Add an employee first', {ms:2000});
    const sh = id ? s.shifts.find(x => x.id === id) : null;
    if(id && !sh) return;
    const sel = sh ? sh.empId : ui.shiftFilter, c = sh ? Pay.shift(sh, s.settings) : null;
    Modal.open(html`<form data-submit="shiftSave" data-id="${id || ''}">
      <h2 id="modalTitle">${sh ? 'Edit' : 'Add'} shift</h2>
      <div class="grid one"><div><label for="fEmp">Employee</label><select id="fEmp" name="empId">
        ${s.employees.map(e => html`<option value="${e.id}" ${sel === e.id ? 'selected' : ''}>${e.name}${e.active === false ? ' (inactive)' : ''}</option>`)}</select></div></div>
      <div class="grid two">
        <div><label for="fIn">Clock in</label><input type="datetime-local" id="fIn" name="in" value="${toLocalInput(sh ? sh.in : +ui.weekStart + 9 * H)}" required></div>
        <div><label for="fOut">Clock out <small>(optional)</small></label><input type="datetime-local" id="fOut" name="out" value="${toLocalInput(sh?.out)}"></div>
      </div>
      <div id="brows">${(sh?.breaks || []).map(b => breakRow(b))}</div>
      <div class="row"><button type="button" class="sm" data-act="addBreakRow">+ Add break</button></div>
      ${c ? html`<p class="muted">Currently: worked ${fmtHM(c.total)} − deducted ${fmtMin(c.ded)} = paid <b>${fmtHM(c.paid)}</b></p>` : ''}
      <div class="row"><button class="inv" type="submit">Save</button><button type="button" data-act="modalCancel">Cancel</button>
        ${sh ? html`<button type="button" data-act="delShift" data-id="${sh.id}">Delete</button>` : ''}</div>
    </form>`);
  },
  emp(id){
    const e = empById(id); if(!e) return;
    const tier = num(db().settings.tierHours), has = db().shifts.some(s => s.empId === id);
    Modal.open(html`<form data-submit="empSave" data-id="${id}"><h2 id="modalTitle">Edit employee</h2>
      <div class="grid two">
        <div><label for="mName">Name</label><input id="mName" name="name" value="${e.name}" required></div>
        <div><label for="mPin">4-digit code</label><input id="mPin" name="pin" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" value="${e.pin}" required></div>
        <div><label for="mR1">Rate first ${tier}h</label><input id="mR1" name="rate1" type="number" step="0.01" min="0" value="${e.rate1}"></div>
        <div><label for="mR2">Rate after ${tier}h</label><input id="mR2" name="rate2" type="number" step="0.01" min="0" value="${e.rate2}"></div>
        <div><label for="mAct">Status</label><select id="mAct" name="active"><option value="1">Active</option><option value="0" ${e.active === false ? 'selected' : ''}>Inactive (cannot clock in)</option></select></div>
      </div>
      <div class="row"><button class="inv" type="submit">Save</button><button type="button" data-act="modalCancel">Cancel</button>
        ${has ? '' : html`<button type="button" data-act="delEmp" data-id="${id}">Delete</button>`}</div>    </form>`);
  }
};

function validPin(p, exceptId){
  if(!/^\d{4}$/.test(p)) return 'Code must be exactly 4 digits';
  if(db().employees.some(e => e.pin === p && e.id !== exceptId)) return 'That code is already used by another employee';
  return '';
}
const undoToast = msg => Toast.show(msg, { action: { label: 'Undo', act: 'undo' } });

// ---------- Event handlers ----------
const Actions = {
  press: d => Kiosk.press(d.k),
  punch: d => Kiosk.punch(d.k),
  kioskCancel: () => Kiosk.reset(true),
  openAdmin: () => Admin.loginModal(),
  modalCancel: () => Modal.close(false),
  logout: () => Admin.logout(),
  print: () => window.print(),
  tab: d => {
    Modal.close(false); ui.tab = d.k; Admin.render();
    if(d.k === 'audit') Admin.loadAudit();
    if(d.k === 'dashboard') Admin.refresh();
  },
  week: d => { ui.weekStart = addDays(ui.weekStart, 7 * +d.k); Admin.render(); },
  weekToday: () => { ui.weekStart = startOfWeek(new Date()); Admin.render(); },
  sort: d => { ui.sort = { k: d.k, dir: ui.sort.k === d.k ? -ui.sort.dir : (d.k === 'name' ? 1 : -1) }; Admin.render(); },
  showShifts: (d, el, ev) => { ev.preventDefault(); ui.shiftFilter = d.id; ui.tab = 'shifts'; Admin.render(); },
  togglePins: () => { ui.showPins = !ui.showPins; $('#empRows').innerHTML = Views.empRows(); },
  undo: async () => {
    try{
      const r = await api.post('/api/admin/undo');
      await RemoteStore.refresh(); render();
      Toast.show(r.undone ? `Undone: ${r.undone}` : 'Nothing to undo', {ms:2500});
    }catch(e){ if(e.status !== 401) Toast.show(e.message, {ms:4000}); }
  },
  themeCycle: () => {
    const order = ['auto', 'light', 'dark'], next = order[(order.indexOf(db().settings.theme) + 1) % 3];
    RemoteStore.call('put', '/api/admin/settings', { theme: next });
  },
  adjust: d => Dialogs.adjust(d.id),
  delAdj: async d => {
    if(await RemoteStore.call('del', `/api/admin/adjustments/${d.id}`)) Dialogs.adjust(d.emp);
  },
  payslip: d => downloadFile(`/api/admin/export/payslips.pdf?${weekParam()}&emp=${encodeURIComponent(d.id)}`),
  payslipsAll: () => downloadFile(`/api/admin/export/payslips.pdf?${weekParam()}&emp=all`),
  exportXlsx: () => downloadFile(`/api/admin/export/payroll.xlsx?${weekParam()}`),
  exportPdf: () => downloadFile(`/api/admin/export/payroll.pdf?${weekParam()}`),
  exportAudit: () => downloadFile('/api/admin/export/audit.csv'),
  backup: () => downloadFile('/api/admin/backup'),
  addShift: () => Dialogs.shift(),
  editShift: d => Dialogs.shift(d.id),
  delShift: async d => {
    const sh = db().shifts.find(x => x.id === d.id); if(!sh) return;
    if(!await Modal.confirm(`Delete the shift for ${empName(sh.empId)} · ${fmtDay(sh.in)} ${fmtTime(sh.in)}?`, { title: 'Delete shift', ok: 'Delete' })) return;
    if(await RemoteStore.call('del', `/api/admin/shifts/${d.id}`)) undoToast('Shift deleted');
  },
  forceOut: async d => {
    const sh = db().shifts.find(x => x.id === d.id); if(!sh) return;
    const name = empName(sh.empId);
    if(!await Modal.confirm(`Clock ${name} out now? Any open break will be ended.`, { title: 'Force clock-out', ok: 'Clock out' })) return;
    if(await RemoteStore.call('post', `/api/admin/shifts/${d.id}/clock-out`)) undoToast(`${name} clocked out`);
  },
  addBreakRow: () => $('#brows').insertAdjacentHTML('beforeend', breakRow()),
  addRule: () => $('#rules').insertAdjacentHTML('beforeend', ruleRow({ h: '', m: '' })),
  removeRow: (d, el) => el.closest('.dyn').remove(),
  editEmp: d => Dialogs.emp(d.id),
  delEmp: async d => {
    const name = empName(d.id);
    if(!await Modal.confirm(`Delete ${name}?`, { title: 'Delete employee', ok: 'Delete' })) return;
    if(await RemoteStore.call('del', `/api/admin/employees/${d.id}`)) undoToast(`${name} deleted`);
  },
  suggestPin: () => {
    const used = new Set(db().employees.map(e => e.pin));
    if(used.size >= 10000) return Toast.show('No free codes left');
    let p; do p = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); while(used.has(p));
    $('#ePin').value = p;
  },
  // Quick CSV exports built in the browser from the same numbers; Excel/PDF come from the server.
  exportReport: () => {
    const rows = Pay.week(db(), ui.weekStart), tier = num(db().settings.tierHours);
    const out = [['Employee', ...DAYS.map(d => d + ' paid hrs'), 'Worked hrs', 'Break deducted hrs', 'Paid hrs',
      `Hrs first ${tier}`, 'Rate 1', `Hrs after ${tier}`, 'Rate 2', 'Gross', 'Allowances', 'Deductions', 'Net pay']];
    for(const r of rows) out.push([r.e.name, ...r.days.map(d => d.toFixed(2)), r.total.toFixed(2), (r.ded / 60).toFixed(2), r.paid.toFixed(2),
      r.h1.toFixed(2), r.r1.toFixed(2), r.h2.toFixed(2), r.r2.toFixed(2), r.gross.toFixed(2), r.allow.toFixed(2), r.deduct.toFixed(2), r.net.toFixed(2)]);
    download(`payroll_${ymd(ui.weekStart)}.csv`, csvBuild(out), 'text/csv');
  },
  exportShifts: () => {
    const a = +ui.weekStart, b = +addDays(ui.weekStart, 7), st = db().settings;
    const out = [['Employee', 'Date', 'In', 'Out', 'Worked hrs', 'Break taken min', 'Break by rule min', 'Deducted min', 'Paid hrs']];
    for(const sh of db().shifts.filter(x => x.in >= a && x.in < b).sort((x, y) => x.in - y.in)){
      const c = Pay.shift(sh, st);
      out.push([empName(sh.empId), ymd(sh.in), fmtTime(sh.in), sh.out ? fmtTime(sh.out) : 'OPEN', c.total.toFixed(2), c.actual, c.policy, c.ded, c.paid.toFixed(2)]);
    }
    download(`shifts_${ymd(ui.weekStart)}.csv`, csvBuild(out), 'text/csv');
  },
  erase: async () => {
    if(!await Modal.confirm('Erase ALL employees, shifts, adjustments, audit log and settings from the database? This cannot be undone.', { title: 'Erase all data', ok: 'Erase everything', typed: 'ERASE' })) return;
    if(await RemoteStore.call('post', '/api/admin/erase', { confirm: 'ERASE' })) Toast.show('All data erased. Admin PIN reset to 0000.', {ms:5000});
  }
};

const Changes = {
  weekPick: el => { if(el.value){ ui.weekStart = startOfWeek(new Date(el.value + 'T00:00')); Admin.render(); } },
  shiftFilter: el => { ui.shiftFilter = el.value; Admin.render(); },
  importFile: el => {
    const file = el.files[0]; if(!file) return;
    const fr = new FileReader();
    fr.onload = async () => {
      let d;
      try{ d = JSON.parse(fr.result); }catch{ d = null; }
      if(!d || !Array.isArray(d.employees) || !Array.isArray(d.shifts)) return Toast.show('That file is not a valid backup', {ms:2500});
      if(!await Modal.confirm(`Replace ALL data in the database with this backup (${d.employees.length} employees, ${d.shifts.length} shifts)? The admin PIN will become the one stored in the backup.`, { title: 'Restore backup', ok: 'Restore' })) return;
      const r = await RemoteStore.call('post', '/api/admin/import', d);
      if(r) Toast.show(`Backup restored: ${r.employees} employees, ${r.shifts} shifts`, {ms:3000});
    };
    fr.readAsText(file);
    el.value = "";   // allow picking the same file again
  }
};

let auditT;
const Inputs = {
  empSearch: el => { ui.empQuery = el.value; $('#empRows').innerHTML = Views.empRows(); },
  auditSearch: el => { ui.auditQuery = el.value; clearTimeout(auditT); auditT = setTimeout(Admin.loadAudit, 250); }
};

const Forms = {
  confirmOk: fd => {
    if(Modal.typed && fd.get('typed') !== Modal.typed) return Toast.show(`Type ${Modal.typed} exactly to confirm`, {ms:2200});
    Modal.close(true);
  },
  adminLogin: async fd => {
    const msg = $('#loginMsg');
    if(Date.now() < Admin.lockUntil) return;
    try{
      await api.post('/api/auth/login', { pin: String(fd.get('pin') ?? '') });
    }catch(e){
      if(e.status === 429){
        Admin.lockUntil = Date.now() + (e.data.retryAfter ?? 60) * 1000;
        msg.innerHTML = html`Locked — try again in <span data-countdown="${Admin.lockUntil}"></span>s`;
      } else msg.textContent = e.status === 401 ? `Wrong PIN (${e.data.remaining} tries left)` : e.message;
      const i = $('#apin'); i.value = ''; i.classList.remove('shake'); void i.offsetWidth; i.classList.add('shake'); i.focus();
      return;
    }
    await RemoteStore.refresh();
    Admin.lastActive = Date.now(); Admin.refreshedAt = Date.now(); Kiosk.reset(false);
    Object.assign(ui, { view: 'admin', tab: 'dashboard', weekStart: startOfWeek(new Date()) });
    Modal.close(true); render();
  },
  adjAdd: async (fd, form) => {
    const empId = form.dataset.id, amount = num(fd.get('amount'));
    if(amount <= 0) return Toast.show('Enter an amount', {ms:1800});
    const body = { week: ymd(ui.weekStart), empId, type: fd.get('type'), label: String(fd.get('label')).trim(), amount };
    if(await RemoteStore.call('post', '/api/admin/adjustments', body)) Dialogs.adjust(empId);
  },
  shiftSave: async (fd, form) => {
    const id = form.dataset.id || null, empId = fd.get('empId');
    const tin = fromLocalInput(fd.get('in')), tout = fromLocalInput(fd.get('out'));
    if(!tin) return Toast.show('Clock-in time is required', {ms:2000});
    if(tout && tout <= tin) return Toast.show('Clock-out must be after clock-in', {ms:2000});
    const bs = fd.getAll('bs'), be = fd.getAll('be'), breaks = [];
    for(let i = 0; i < bs.length; i++){
      const start = fromLocalInput(bs[i]), end = fromLocalInput(be[i]);
      if(start) breaks.push({ start, end });
    }
    // The server re-validates everything (inside shift, no overlaps, no clash) and answers 422 with the reason.
    const body = { empId, in: tin, out: tout, breaks };
    const ok = id ? await RemoteStore.call('put', `/api/admin/shifts/${id}`, body) : await RemoteStore.call('post', '/api/admin/shifts', body);
    if(ok){ Modal.close(true); undoToast('Shift saved'); }
  },
  empAdd: async fd => {
    const name = String(fd.get('name')).trim(), p = String(fd.get('pin')).trim();
    if(!name) return Toast.show('Enter a name', {ms:1800});
    const err = validPin(p); if(err) return Toast.show(err, {ms:2200});
    if(await RemoteStore.call('post', '/api/admin/employees', { name, pin: p, rate1: fd.get('rate1'), rate2: fd.get('rate2'), active: true })){
      Toast.show(`${name} added`, {ms:1500});
      $('#eName')?.focus();
    }
  },
  empSave: async (fd, form) => {
    const id = form.dataset.id, name = String(fd.get('name')).trim(), p = String(fd.get('pin')).trim();
    if(!name) return Toast.show('Enter a name', {ms:1800});
    const err = validPin(p, id); if(err) return Toast.show(err, {ms:2200});
    const body = { name, pin: p, rate1: fd.get('rate1'), rate2: fd.get('rate2'), active: fd.get('active') === '1' };
    if(await RemoteStore.call('put', `/api/admin/employees/${id}`, body)) Modal.close(true);
  },
  settingsSave: async fd => {
    const rm = fd.getAll('rm');
    const breakRules = fd.getAll('rh').map((h, i) => ({ h: num(h), m: num(rm[i]) }));
    const body = { company: fd.get('company'), currency: fd.get('currency'), tierHours: fd.get('tierHours'), theme: fd.get('theme'),
      breakMode: fd.get('breakMode'), breakRules, kioskIdleSec: fd.get('kioskIdleSec'), adminTimeoutMin: fd.get('adminTimeoutMin'), maxShiftHours: fd.get('maxShiftHours') };
    if(await RemoteStore.call('put', '/api/admin/settings', body)) Toast.show('Settings saved', { ms: 1500, action: { label: 'Undo', act: 'undo' } });
  },
  pinChange: async (fd, form) => {
    if(fd.get('next') !== fd.get('repeat')) return Toast.show('New PINs do not match', {ms:2200});
    if(await RemoteStore.call('post', '/api/auth/pin', { current: fd.get('current'), next: fd.get('next') })){
      form.reset(); Toast.show('Admin PIN updated', {ms:2000});
    }
  }
};

function bindEvents(){
  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if(!el || el.disabled) return;
    Actions[el.dataset.act]?.(el.dataset, el, ev);
  });
  document.addEventListener('submit', async ev => {
    const fn = Forms[ev.target.dataset.submit]; if(!fn) return;
    ev.preventDefault();
    // Disable the form's buttons while the request is in flight to avoid double submits.
    const buttons = $$('button', ev.target).filter(b => !b.disabled);
    buttons.forEach(b => b.disabled = true);
    try{ await fn(new FormData(ev.target), ev.target); }
    finally{ buttons.forEach(b => { if(b.isConnected) b.disabled = false; }); }
  });
  document.addEventListener('change', ev => { const el = ev.target.closest('[data-change]'); if(el) Changes[el.dataset.change]?.(el); });
  document.addEventListener('input', ev => { const el = ev.target.closest('[data-input]'); if(el) Inputs[el.dataset.input]?.(el); });
  $('#modal').addEventListener('mousedown', ev => { if(ev.target === ev.currentTarget) Modal.close(false); });

  document.addEventListener('keydown', ev => {
    if(Modal.isOpen()) return Modal.onKey(ev);
    if(ui.view !== 'kiosk' || ev.target.matches('input,select,textarea')) return;
    if(/^[0-9]$/.test(ev.key)) Kiosk.press(ev.key);
    else if(ev.key === 'Backspace') Kiosk.press('<');
    else if(ev.key === 'Escape') Kiosk.current ? Kiosk.reset(true) : Kiosk.press('C');
    else if(ev.key === 'Enter' && Kiosk.current && ev.target.tagName !== 'BUTTON'){ ev.preventDefault(); $('[data-primary]')?.click(); }
  });
  ['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, () => { if(ui.view === 'admin') Admin.lastActive = Date.now(); }, true));

  // Pick up changes made elsewhere (kiosk punches, other admins) when the window regains focus.
  const onFocus = () => { if(document.visibilityState === 'visible') ui.view === 'admin' ? Admin.refresh() : Kiosk.loadInfo(); };
  document.addEventListener('visibilitychange', onFocus);
  window.addEventListener('focus', onFocus);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  api.onUnauthorized = () => { if(ui.view === 'admin') Admin.logout('Admin session expired', { sessionGone: true }); };
}

async function boot(){
  bindEvents();
  await Kiosk.loadInfo();
  render();
  setInterval(() => {
    const now = Date.now();
    ui.view === 'kiosk' ? Kiosk.tick(now) : Admin.tick(now);
    tickLive(now);
  }, 1000);
  setInterval(() => { if(ui.view === 'kiosk') Kiosk.loadInfo(); }, 10000);
}
boot();
