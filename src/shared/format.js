// Pure formatting/date helpers shared by the browser (/shared/format.js) and the server. No DOM, no globals.
export const H = 3600000, MIN = 60000;
export const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

export const pad = n => String(n).padStart(2, '0');
export const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
export const initials = name => String(name || '?').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase();

export const ymd = d => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const hm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const toLocalInput = ts => ts == null ? '' : `${ymd(ts)}T${hm(ts)}`;
export const fromLocalInput = v => v ? new Date(v).getTime() : null;
export const fmtTime = ts => new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
export const fmtDay = ts => new Date(ts).toLocaleDateString([], {weekday:'short', day:'2-digit', month:'short'});
export const fmtStamp = ts => new Date(ts).toLocaleString([], {day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit'});
export const fmtHM = h => { const m = Math.round(h * 60), a = Math.abs(m); return (m < 0 ? '-' : '') + Math.floor(a / 60) + ':' + pad(a % 60); };
export const fmtMin = m => fmtHM(m / 60);
export const fmtElapsed = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
export const money = (n, currency = '$') => (n < 0 ? '-' : '') + currency + Math.abs(n).toFixed(2);

export const dayIndex = ts => (new Date(ts).getDay() + 6) % 7;
export function startOfWeek(d){ d = new Date(d); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - dayIndex(d)); return d; }
export function addDays(d, n){ d = new Date(d); d.setDate(d.getDate() + n); return d; }
export const niceStep = x => { const p = 10 ** Math.floor(Math.log10(x)), f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };

// Prefix text that a spreadsheet would treat as a formula; numbers like "-5" are left alone.
export const safeText = v => { v = String(v ?? ''); return /^[=+\-@]/.test(v) && !/^-?\d/.test(v) ? "'" + v : v; };
export const csvCell = v => `"${safeText(v).replace(/"/g, '""')}"`;
export const csvBuild = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
