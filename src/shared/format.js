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

// ----- Local wall-clock helpers (roster times are local "HH:MM" on a local "YYYY-MM-DD") -----
export const atLocal = (day, hhmm) => {
  const [y, m, d] = day.split('-').map(Number), [h, mi] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
};
export const addDaysYmd = (day, n) => { const [y, m, d] = day.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
export const floorMin = ts => ts - (((ts % 60000) + 60000) % 60000);   // UTC maths: safe in the repeated DST hour
const minuteOfDay = ts => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
// Round up/down to the step on the local clock (:00/:15/:30/:45 for 15). Seconds are ignored.
const stepBy = (ts, step, round) => { const m = minuteOfDay(ts); return floorMin(ts) + (round(m / step) * step - m) * 60000; };
export const ceilStep = (ts, step) => stepBy(ts, step, Math.ceil);
export const floorStep = (ts, step) => stepBy(ts, step, Math.floor);

// Roster shorthand from the old roster app: "9.30" / "9.5" (= 9:50) with AM/PM, plus "17:00" or "7:05" PM.
export function parseShortTime(str, meridiem){
  str = String(str ?? '').trim();
  if(!str) return null;
  const m = /^(\d{1,2})(?:([.:])(\d{1,2}))?$/.exec(str);
  if(!m) return null;
  let hour = Number(m[1]);
  const min = m[3] == null ? 0 : Number(m[2] === '.' && m[3].length === 1 ? m[3] + '0' : m[3]);
  if(m[2] === ':' && m[3].length !== 2) return null;
  if(min > 59) return null;
  if(meridiem === 'AM' || meridiem === 'PM'){
    if(hour < 1 || hour > 12) return null;
    if(meridiem === 'PM' && hour !== 12) hour += 12;
    if(meridiem === 'AM' && hour === 12) hour = 0;
  } else if(hour > 23) return null;
  return `${pad(hour)}:${pad(min)}`;
}
// "09:00" → "9A", "17:30" → "5:30P" (compact roster labels)
export const fmt12 = hhmm => {
  if(!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + pad(m) : ''}${h < 12 ? 'A' : 'P'}`;
};

// Compact roster chip labels, same as the old roster app ("9A–5P", "Bakery 5A–1P", "TRN …", "OFF").
export function rosterLabel(e){
  const span = e.start ? `${fmt12(e.start)}–${fmt12(e.end)}` : '';
  return { CAFE: span, BAKERY: `Bakery ${span}`, TRAINING: `TRN ${span}`, DELIVERY: 'DEL', BAKE: 'BAKE', 'BAKERY YC': 'BKY YC', OFF: 'OFF' }[e.type] ?? e.type;
}

// Spreadsheet-safe text: anything that could start a formula gets a leading ' (plain numbers like -5 stay as they are).
export const safeText = v => { v = String(v ?? ''); return /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? "'" + v : v; };
export const csvCell = v => `"${safeText(v).replace(/"/g, '""')}"`;
export const csvBuild = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
