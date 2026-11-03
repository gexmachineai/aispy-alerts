/**
 * Event-trigger checks for the cloud GEX feed (all symbols with minute snapshots; volume check SPY only).
 * Pure + cheap: evaluated once per ET minute from data the feed already fetched (board, quote cumulative volume) plus
 * baselines read from D1 once per day (prior sessions' board_snap_min vol / opts). No Tradier calls, never throws to the caller.
 *
 * Events: volume_spike | strike_pace | flip_cross | wall_touch | wall_break | grade_change
 * Payload: {type, sym, time (ET ISO), spot, strike|null, values{...}}
 */
export const TRG = {
  VOL_X: 2, VOL_REARM: 1.5, VOL_MIN_SESS: 3, VOL_MAX_SESS: 10, VOL_FLOOR: 100000,   // normal = median cum vol at same hm over >=3 prior sessions; baseline >= 100k shares
  PACE_X: 5, PACE_REARM: 2.5, PACE_WIN: 15, PACE_FLOOR: 100, PACE_BAND: 5,          // 15-min contract volume vs same window prior session; prior floored at 100 contracts
  GRADE_HOLD: 2,                                                                       // grade change must hold 2 consecutive minutes
  TOUCH_SPY: 0.10, TOUCH_PCT: 0.0003,                                                  // wall touch tolerance (SPY $0.10, others 0.03% of spot)
};
const p2 = n => String(n).padStart(2, "0");
const r2 = x => (x === null || x === undefined || !Number.isFinite(+x) ? null : Math.round(x * 100) / 100);
const med = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2; };
export function newTrg(day) { return { day, mk: null, g: null, vol: { armed: true, n: 0 }, pace: {}, bar: null, flipSide: null, walls: {}, ob: [], skip: {}, seq: 0 }; }
/** Per-cycle (cheap, memory only): track the last spot of the current 15-min bar. */
export function trgTick(st, spot, h, mi) {
  if (!st || !Number.isFinite(spot)) return;
  const bk = `${p2(h)}:${p2(mi - mi % 15)}`;
  if (!st.bar || st.bar.bk !== bk) { if (st.bar) st.prevBar = { bk: st.bar.bk, close: st.bar.last }; st.bar = { bk, last: spot }; }
  else st.bar.last = spot;
}
/**
 * Evaluate one minute. ctx: {sym, b (board), vol (cum shares|null), date, hm, h, mi, rth (bool), base: {vol:{hm:[cum..]}|null, prior:{hm:{"k|c":vol}}|null, priorDate}}
 * Returns {st, events:[{type,key,payload}], logs:[...]}.
 */
export function trgEval(st, ctx) {
  const { sym, b, date, hm, h, mi } = ctx, ev = [], logs = [];
  if (!st || st.day !== date) st = newTrg(date);
  if (st.mk === hm) return { st, events: ev, logs };
  st.mk = hm;
  const spot = typeof b.spot === "number" ? b.spot : null, time = b.generated_et;
  const P = (type, strike, values) => ({ type, sym, time, spot: r2(spot), strike: strike ?? null, values });
  const skip = (k, msg) => { if (!st.skip[k]) { st.skip[k] = 1; logs.push(msg); } };
  const fire = (type, key, strike, values) => { st.seq++; ev.push({ type, key, payload: P(type, strike, values) }); };
  // closes the previous 15-min bar if this minute starts a new one (spot already folded in by trgTick)
  trgTick(st, spot, h, mi);
  // 1. SPY share volume vs same-hm cumulative of prior sessions
  if (sym === "SPY") {
    const base = ctx.base && ctx.base.vol, arr = base && base[hm];
    if (!Number.isFinite(ctx.vol) || ctx.vol <= 0) skip("vol_none", `volume: no cumulative SPY volume this tick`);
    else if (!base) skip("vol_base", `volume: baseline not loaded`);
    else if (!arr || arr.length < TRG.VOL_MIN_SESS) skip("vol_hist:" + (arr ? arr.length : 0), `volume: only ${arr ? arr.length : 0} prior sessions with vol at ${hm} (need ${TRG.VOL_MIN_SESS}); skipped`);
    else {
      const norm = med(arr);
      if (norm < TRG.VOL_FLOOR) skip("vol_floor", `volume: normal ${norm} < floor ${TRG.VOL_FLOOR} at ${hm}; skipped`);
      else {
        const x = ctx.vol / norm;
        if (st.vol.armed && x >= TRG.VOL_X) { st.vol.armed = false; st.vol.n++; fire("volume_spike", `vol:${st.vol.n}`, null, { cum_volume: ctx.vol, normal_volume: Math.round(norm), ratio: r2(x), sessions: arr.length, hm }); }
        else if (!st.vol.armed && x < TRG.VOL_REARM) st.vol.armed = true;
      }
    }
  }
  // 2. strike within $5 of spot: 15-min contract volume pace vs the same window prior session
  if (ctx.rth && spot !== null) {
    const cur = {}; for (const r of b.strikes || []) { if (Math.abs(r.strike - spot) > TRG.PACE_BAND) continue; for (const sd of ["call", "put"]) cur[`${r.strike}|${sd[0]}`] = (r[sd] && r[sd].volume) || 0; }
    const idx = h * 60 + mi; st.ob = st.ob.filter(o => idx - o.i <= TRG.PACE_WIN + 2); st.ob.push({ i: idx, m: cur });
    const old = st.ob.find(o => idx - o.i >= TRG.PACE_WIN), pr = ctx.base && ctx.base.prior;
    const hm0 = old && `${p2(Math.floor(old.i / 60))}:${p2(old.i % 60)}`;
    if (!pr) skip("pace_base", `strike_pace: no prior-session opts history; skipped`);
    else if (old && pr[hm] && pr[hm0]) {
      for (const k in cur) {
        if (!(k in old.m) || !(k in pr[hm]) || !(k in pr[hm0])) continue;
        const d = cur[k] - old.m[k], pd = Math.max(0, pr[hm][k] - pr[hm0][k]), bse = Math.max(pd, TRG.PACE_FLOOR), x = d / bse, s = st.pace[k] || (st.pace[k] = { armed: true, n: 0 });
        if (s.armed && x >= TRG.PACE_X) { s.armed = false; s.n++; const [K, sd] = k.split("|");
          fire("strike_pace", `pace:${k}:${s.n}`, +K, { side: sd === "c" ? "call" : "put", vol_15m: d, prior_vol_15m: pd, ratio: r2(x), window: `${hm0}-${hm}`, prior_date: ctx.base.priorDate, cum_volume: cur[k] }); }
        else if (!s.armed && x < TRG.PACE_REARM) s.armed = true;
      }
    }
  }
  // 3. 15-min close vs flip / 10k walls (fires on the first minute of the next bar)
  if (st.prevBar && st.prevBar.done !== true && st.bar && st.bar.bk !== st.prevBar.bk) {
    const c = st.prevBar.close, bk = st.prevBar.bk; st.prevBar.done = true;
    const flip = typeof b.flip === "number" ? b.flip : null, L = b.wall_L ?? null, R = b.wall_R ?? null;
    const tol = sym === "SPY" ? TRG.TOUCH_SPY : Math.max(0.01, (spot || c) * TRG.TOUCH_PCT);
    if (flip !== null && c !== flip) {
      const side = c > flip ? "above" : "below";
      if (st.flipSide && st.flipSide !== side) fire("flip_cross", `flip:${side}:${st.seq}`, null, { close_15m: r2(c), bar: bk, flip, direction: side, from: st.flipSide });
      st.flipSide = side;
    }
    for (const [w, lvl] of [["L", L], ["R", R]]) {
      if (lvl === null || lvl === undefined) continue;
      const brk = w === "L" ? c < lvl - tol : c > lvl + tol, tch = Math.abs(c - lvl) <= tol, kind = brk ? "break" : tch ? "touch" : null;
      if (!kind) continue;
      const key = `wall:${w}:${lvl}:${kind}`; if (st.walls[key]) continue; st.walls[key] = 1;
      fire("wall_" + kind, key, lvl, { wall: w, level: lvl, close_15m: r2(c), bar: bk, tol: r2(tol) });
    }
  }
  // 4. board grade (green/box count) change
  const g = typeof b.green_count === "number" ? `${b.green_count}/${b.box_count}` : null;
  // debounced: a new grade must hold for GRADE_HOLD consecutive minute checks before it fires (stops 1-minute flapping)
  if (g !== null) {
    if (st.g === null) st.g = g;
    else if (g === st.g) st.gc = null;
    else { st.gc = st.gc && st.gc.g === g ? { g, n: st.gc.n + 1 } : { g, n: 1 };
      if (st.gc.n >= TRG.GRADE_HOLD) { fire("grade_change", `grade:${st.seq}`, null, { from: st.g, to: g, green: b.green_count, boxes: b.box_count, premarket: !!b.premarket }); st.g = g; st.gc = null; } }
  }
  return { st, events: ev, logs };
}
