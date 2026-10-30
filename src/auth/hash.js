// Admin PIN hashing: scrypt for new hashes; legacy sha256/fnv hashes from old backups are verified once and then rehashed.
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export function fnv1a(input){
  let h = 0x811c9dc5;
  for(let i = 0; i < input.length; i++){ h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'fnv:' + h.toString(16);
}

export async function hashPin(pin){
  const salt = randomBytes(16);
  const key = await scrypt(String(pin), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const same = (a, b) => { a = Buffer.from(a); b = Buffer.from(b); return a.length === b.length && timingSafeEqual(a, b); };

// Never throws: malformed hashes simply fail to verify.
export async function verifyPin(pin, stored){
  try{
    pin = String(pin);
    if(typeof stored !== 'string' || !stored) return false;
    if(stored.startsWith('scrypt$')){
      const [, n, r, p, salt, key] = stored.split('$');
      if(!key) return false;
      const expected = Buffer.from(key, 'base64');
      const actual = await scrypt(pin, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
      return same(actual, expected);
    }
    // Legacy "<salt>|sha256:<hex>" or "<salt>|fnv:<hex>" (hash of `${salt}:${pin}`)
    const bar = stored.indexOf('|');
    if(bar < 0) return false;
    const salt = stored.slice(0, bar), hash = stored.slice(bar + 1), input = `${salt}:${pin}`;
    if(hash.startsWith('sha256:')) return same('sha256:' + createHash('sha256').update(input).digest('hex'), hash);
    if(hash.startsWith('fnv:')) return same(fnv1a(input), hash);
    return false;
  }catch{ return false; }
}

export const needsRehash = stored => !String(stored).startsWith('scrypt$');
