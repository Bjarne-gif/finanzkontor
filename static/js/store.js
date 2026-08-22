/* Winziger State-Store + Event-Bus.
   Das Fundament, damit Bausteine später aufeinander reagieren können:
   ein Modul ändert Daten -> emit('...') -> andere Module hören mit. */

export const store = (() => {
  const state = {};
  const subs = new Map(); // key -> Set<fn>

  return {
    get: (k) => state[k],
    set: (k, v) => {
      state[k] = v;
      (subs.get(k) || []).forEach((fn) => fn(v));
    },
    watch: (k, fn) => {
      if (!subs.has(k)) subs.set(k, new Set());
      subs.get(k).add(fn);
      return () => subs.get(k).delete(fn);
    },
  };
})();

export const bus = (() => {
  const map = new Map(); // event -> Set<fn>
  return {
    on: (ev, fn) => {
      if (!map.has(ev)) map.set(ev, new Set());
      map.get(ev).add(fn);
      return () => map.get(ev).delete(fn);
    },
    emit: (ev, payload) => (map.get(ev) || []).forEach((fn) => fn(payload)),
  };
})();
