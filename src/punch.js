// Kiosk punch state machine: in → (bs → be)* → out. The server clock is the time of every punch.
import { HttpError, ValidationError } from './errors.js';
import { openShiftFor, saveShift, getSettings, addAudit } from './repo.js';
import { shift as calcShift } from './shared/pay.js';
import { hm } from './shared/format.js';
import { randomUUID } from 'node:crypto';

const LABEL = { in: 'Clock in', bs: 'Break start', be: 'Break end', out: 'Clock out' };

export function punch(db, emp, type, now){
  if(!LABEL[type]) throw new ValidationError('Unknown punch type');
  return db.tx(() => {
    let sh = openShiftFor(db, emp.id);
    const open = sh?.breaks.find(b => b.end == null);
    let detail;
    if(type === 'in'){
      if(sh) throw new HttpError(409, 'Already clocked in');
      sh = { id: randomUUID(), empId: emp.id, in: now, out: null, breaks: [] };
      detail = `in at ${hm(now)}`;
    } else if(!sh){
      throw new HttpError(409, 'Not clocked in');
    } else if(type === 'bs'){
      if(open) throw new HttpError(409, 'Already on break');
      sh.breaks.push({ start: now, end: null });
      detail = `break from ${hm(now)}`;
    } else if(type === 'be'){
      if(!open) throw new HttpError(409, 'Not on break');
      open.end = now;
      detail = `break ${hm(open.start)}–${hm(now)}`;
    } else {
      if(open) open.end = now;
      sh.out = now;
      detail = `out at ${hm(now)}`;
    }
    saveShift(db, sh);
    const calc = calcShift(sh, getSettings(db), now);
    addAudit(db, { ts: now, actor: emp.name, action: LABEL[type], detail });
    return { type, at: now, shift: sh, calc };
  });
}
