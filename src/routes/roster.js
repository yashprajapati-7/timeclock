// /api/admin/roster/* — mounted behind requireAdmin. Every write is undoable and audited; past-day changes
// report how many already-worked shifts they re-price (and support dryRun to ask before writing).
import { Router } from 'express';
import { HttpError, ValidationError } from '../errors.js';
import * as R from '../repo.js';
import { validateRosterEntries } from '../validate.js';
import { calcAll } from '../shared/pay.js';
import { planImport, applyImport } from '../roster-import.js';
import { addDaysYmd, fmtDay, ymd, startOfWeek } from '../shared/format.js';

const realDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && ymd(new Date(s + 'T00:00')) === s;
const monday = s => realDay(s) && ymd(startOfWeek(new Date(s + 'T00:00'))) === s;
const DRY = Symbol('dry run');
export const describeEntries = entries => entries.length
  ? entries.map(e => e.start ? `${e.type} ${e.start}–${e.end}` : e.type).join(', ') : 'cleared';

// Paid in/out of already-worked shifts that a roster change on `days` could affect (neighbour days included).
function pastPaidTimes(db, days, now){
  const today = ymd(now);
  const near = new Set(days.filter(dd => dd < today).flatMap(dd => [addDaysYmd(dd, -1), dd, addDaysYmd(dd, 1)]));
  if(!near.size) return new Map();
  const out = new Map();
  for(const [id, c] of calcAll(R.loadData(db), now))
    if(near.has(ymd(c.paidIn)) || near.has(ymd(c.paidOut))) out.set(id, `${c.paidIn}|${c.paidOut}`);
  return out;
}
const countChanged = (before, after) => [...before].filter(([id, v]) => after.get(id) !== v).length;

export const DEFAULT_ROSTER_URL = 'https://roster-production-3522.up.railway.app/api/roster';

export function rosterRoutes({ db, clock, undo, fetch: fetchImpl = globalThis.fetch, rosterImportUrl = DEFAULT_ROSTER_URL }){
  const r = Router();
  const audit = (action, detail) => R.addAudit(db, { ts: clock(), actor: 'Admin', action, detail });

  // Runs `mutate(touch)` as one undoable action, measuring re-priced past shifts. dryRun → measure, then roll back.
  function apply(req, action, days, mutate){
    const now = clock(), dryRun = req.body?.dryRun === true;
    let repriced = 0, result;
    const measured = touch => {
      const before = pastPaidTimes(db, days, now);
      result = mutate(touch);
      repriced = countChanged(before, pastPaidTimes(db, days, now));
    };
    if(dryRun){
      try{ db.tx(() => { measured(() => {}); throw DRY; }); }catch(e){ if(e !== DRY) throw e; }
      return { repriced, dryRun: true };
    }
    undo.run(req.session.key, action, touch => {
      measured(touch);
      audit(action, `${result.detail}${repriced ? ` (past: re-prices ${repriced} shifts)` : ''}`);
    });
    return { ok: true, repriced, ...result.extra };
  }

  // Replace a cell, registering removed and created rows with undo.
  const replaceCell = (touch, empId, day, entries) => {
    for(const e of R.getRosterCell(db, empId, day)) touch('roster', e.id);
    const { addedIds } = R.replaceRosterCell(db, empId, day, entries);
    addedIds.forEach(id => touch('roster', id, { created: true }));
  };

  r.put('/:empId/:day', (req, res) => {
    const { empId, day } = req.params;
    const emp = R.getEmployee(db, empId);
    if(!emp) throw new HttpError(404, 'Employee not found');
    if(!realDay(day)) throw new ValidationError('Day must be a real date (YYYY-MM-DD)');
    const entries = validateRosterEntries(req.body?.entries);
    res.json(apply(req, 'Edit roster', [day], touch => {
      replaceCell(touch, empId, day, entries);
      return { detail: `${emp.name} · ${fmtDay(new Date(day + 'T00:00'))}: ${describeEntries(entries)}` };
    }));
  });

  const weekDays = week => {
    if(!monday(week)) throw new ValidationError('Week must be a Monday (YYYY-MM-DD)');
    return Array.from({ length: 7 }, (_, i) => addDaysYmd(week, i));
  };

  // Copy every filled cell of `week` onto the same weekday next week (empty source cells leave targets alone).
  r.post('/copy-week', (req, res) => {
    const days = weekDays(req.body?.week);
    const cells = Object.entries(R.listRoster(db, { from: days[0], to: days[6] }));
    const targets = days.map(dd => addDaysYmd(dd, 7));
    res.json(apply(req, 'Copy roster week', targets, touch => {
      for(const [key, entries] of cells){
        const [day, empId] = [key.slice(0, 10), key.slice(11)];
        replaceCell(touch, empId, addDaysYmd(day, 7), entries.map(({ type, start, end }) => ({ type, start, end })));
      }
      return { detail: `${cells.length} cells from week of ${days[0]} → ${targets[0]}`, extra: { copied: cells.length } };
    }));
  });

  r.post('/clear-week', (req, res) => {
    const days = weekDays(req.body?.week);
    res.json(apply(req, 'Clear roster week', days, touch => {
      const ids = R.rosterRowIdsInRange(db, days[0], days[6]);
      ids.forEach(id => touch('roster', id));
      db.run('DELETE FROM roster WHERE day >= ? AND day <= ?', [days[0], days[6]]);
      return { detail: `${ids.length} entries in week of ${days[0]}`, extra: { cleared: ids.length } };
    }));
  });

  // Import from the old roster app (fetched from the configured URL only — never a URL from the request) or uploaded JSON.
  r.post('/import', async (req, res) => {
    const src = req.body?.data ?? await fetchOldRoster(fetchImpl, rosterImportUrl);
    const offsetDays = Number.isInteger(req.body?.offsetDays) ? req.body.offsetDays : undefined;
    const now = clock();
    let plan;
    try{ plan = planImport(src, { ...R.loadData(db), now }, { offsetDays }); }
    catch(e){ throw new ValidationError(e.message); }
    const { cells, ...summary } = plan;
    if(req.body?.dryRun === true) return res.json({ ...summary, dryRun: true });
    let result;
    undo.run(req.session.key, 'Import roster', touch => {
      result = applyImport(db, plan, { now, touch });
      audit('Import roster', `${result.changedCells} cells, ${result.created.length} new staff`
        + `${plan.repricedShifts ? ` (past: re-prices ${plan.repricedShifts} shifts)` : ''}`);
    });
    res.json({ ok: true, ...summary, created: result.created, changedCells: result.changedCells, repriced: plan.repricedShifts });
  });

  return r;
}

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
async function fetchOldRoster(fetchImpl, url){
  let res;
  try{ res = await fetchImpl(url, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { accept: 'application/json' } }); }
  catch{ throw new HttpError(502, 'Could not reach the old roster app'); }
  if(!res.ok) throw new HttpError(502, `Could not reach the old roster app (HTTP ${res.status})`);
  // Read with a size cap rather than res.json() on an unbounded body.
  if(!res.body) throw new HttpError(502, 'The old roster app did not return JSON');
  const reader = res.body.getReader(), chunks = [];
  let size = 0;
  for(;;){
    let part;
    try{ part = await reader.read(); }      // the timeout also covers the body
    catch{ throw new HttpError(502, 'Could not reach the old roster app'); }
    if(part.done) break;
    size += part.value.length;
    if(size > MAX_IMPORT_BYTES){ await reader.cancel(); throw new HttpError(502, 'Roster data too large'); }
    chunks.push(part.value);
  }
  try{ return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch{ throw new HttpError(502, 'The old roster app did not return JSON'); }
}
