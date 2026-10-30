// In-memory "N failures then locked for ms" counter, keyed by client IP.
export function createLockout({ max = 5, ms = 60000, clock = Date.now } = {}){
  const state = new Map();   // key -> { fails, until }
  const retry = until => Math.ceil((until - clock()) / 1000);
  return {
    check(key){
      const s = state.get(key);
      if(s?.until && clock() >= s.until) state.delete(key);
      const cur = state.get(key);
      return cur?.until ? { locked: true, retryAfterSec: retry(cur.until) } : { locked: false };
    },
    fail(key){
      this.check(key);
      const s = state.get(key) ?? { fails: 0, until: 0 };
      s.fails++;
      state.set(key, s);
      if(s.fails >= max){ s.until = clock() + ms; return { locked: true, remaining: 0, retryAfterSec: retry(s.until) }; }
      return { locked: false, remaining: max - s.fails };
    },
    reset(key){ state.delete(key); },
  };
}
