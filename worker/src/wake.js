/**
 * Wake triggers for the SPY GexFeed (SHADOW: rows are logged to board_snap_evt as kind "wake:<bot>:<k1+k2>"; POSTs gated off).
 * Pure, cheap per-tick logic. State object lives in DO storage key "wake" (written only when changed).
 *
 * Volume (per ET minute, from Tradier /markets/quotes SPY cumulative `volume`):
 *   min = cum - prevCum. Minutes before 09:35 ET are ignored for spikes AND baselines (premarket is thin and the
 *   09:30-09:35 open is always huge); baselines start fresh at 09:35, so premarket volume never pollutes them.
 *   vol_spike  (TRIGGER)  : rolling 5-min sum >= 2x median of prior completed 5-min window sums (needs >=3 windows, base >= VOL_FLOOR5).
 *   vol_spike1 (LOG-ONLY) : minute vol >= 2x median of previous 20 minutes (needs >=10 minutes).
 */
export const WAKE_BOTS = ["gexquant", "slicky"];
// Routing: both bots get every event (incl. log-only variants, flagged variant:true).
export const ROUTES = { gexquant: null, slicky: null };   // null = all kinds
const LEVELS = ["wall_L", "wall_R", "mm_magnet"];
const TOUCH = 0.10, REARM = 0.25, DEB = 5 * 60e3, DEB_LVL = 10 * 60e3, HB = 30 * 60e3, HB60 = 60 * 60e3, VOL_FLOOR5 = 50000;
// Future live rule for not-green (WAKE_OFF_RULE): "v2" = below-3 always + 5->below-5 only after that day's green5_first.
// In shadow both green_off and green_off3 are always logged; `variant` marks what the configured live rule would NOT send.
const VARIANT_KINDS = new Set(["vol_spike1", "hb60"]);
const LVL_KINDS = new Set(["level_touch", "level_break"]);
const med = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
export function hashId(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, "0"); }

export function newWake(day, nowMs) {
  const t = {}, t60 = {}; for (const b of WAKE_BOTS) { t[b] = nowMs; t60[b] = nowMs; }
  return { day, g: null, g3: false, g5: false, fs: 0, lv: {}, v: { cum: null, mk: null, mins: [], w: [], b5: [], cur: 0, n: 0 }, deb: {}, any: t, any60: t60, stale: false, lastMs: null };
}

/** Evaluate one tick. b = board, vol = cumulative SPY volume (or null), minuteKey = "YYYY-MM-DD HH:MM" (ET), opts.offRule.
 *  Returns {st, dirty, perBot:{bot:[events]}, volInfo}. Caller already ensured SPY, live tick, in session. */
export function wakeEval(st, b, vol, nowMs, minuteKey, opts = {}) {
  const day = minuteKey.slice(0, 10), hm = minuteKey.slice(11, 16);
  let dirty = false;
  if (!st || st.day !== day) { st = newWake(day, nowMs); dirty = true; }
  const ev = [], spot = b.spot;
  // stale/recovered from the DO side: gap since previous live tick > 3 min (DO was alive but not cycling)
  if (st.lastMs && nowMs - st.lastMs > 180e3) ev.push({ kind: "recovered", gap_s: Math.round((nowMs - st.lastMs) / 1000) });
  if (st.stale && !ev.length) { ev.push({ kind: "recovered" }); }
  if (st.stale) { st.stale = false; dirty = true; }
  st.lastMs = nowMs;   // in memory each tick; persisted only when something else changes (fine: DO stays warm while ticking)
  // green
  const g = typeof b.green_count === "number" ? b.green_count : null, pg = st.g;
  if (g !== null) {
    if (g >= 3 && !st.g3) { st.g3 = true; ev.push({ kind: "green3_first", g }); }
    if (g === 5 && !st.g5) { st.g5 = true; ev.push({ kind: "green5_first", g }); }
    if (pg === 5 && g < 5) ev.push({ kind: "green_off", g, ...(opts.offRule === "v2" && !st.g5 ? { variant: true } : {}) });
    if (pg !== null && pg >= 3 && g < 3) ev.push({ kind: "green_off3", g });
    if (g !== pg) { st.g = g; dirty = true; }
  }
  // flip cross
  if (typeof b.flip === "number" && typeof spot === "number") {
    const s = sgn(spot - b.flip);
    if (s && s !== st.fs) { if (st.fs) ev.push({ kind: "flip_cross", level: "flip", price: b.flip, dir: s > 0 ? "up" : "down" }); st.fs = s; dirty = true; }
  }
  // levels
  for (const L of LEVELS) {
    const v = b[L]; if (typeof v !== "number" || typeof spot !== "number") continue;
    const d = spot - v, ad = Math.abs(d); let s = st.lv[L];
    if (!s || s.v !== v) { st.lv[L] = { v, arm: ad > TOUCH, side: ad > REARM ? sgn(d) : 0 }; dirty = true; continue; }   // new level value: no false cross
    if (s.arm && ad <= TOUCH) { ev.push({ kind: "level_touch", level: L, price: v }); s.arm = false; dirty = true; }
    if (s.side && sgn(d) === -s.side) { ev.push({ kind: "level_break", level: L, price: v, dir: d > 0 ? "up" : "down" }); s.side = 0; dirty = true; }
    if (ad > REARM) { if (!s.arm) { s.arm = true; dirty = true; } if (s.side !== sgn(d)) { s.side = sgn(d); dirty = true; } }
  }
  // volume, first tick of each ET minute
  const V = st.v; let volInfo = null;
  if (typeof vol === "number" && vol > 0 && V.mk !== minuteKey) {
    dirty = true;
    const m = V.cum !== null && vol >= V.cum ? vol - V.cum : null;
    V.cum = vol; V.mk = minuteKey;
    if (m !== null && hm > "09:35") {
      const base1 = V.mins.length >= 10 ? med(V.mins) : 0;
      V.w.push(m); if (V.w.length > 5) V.w.shift();
      const r5 = V.w.length === 5 ? V.w.reduce((a, x) => a + x, 0) : 0, base5 = V.b5.length >= 3 ? med(V.b5) : 0;
      const x = base1 ? m / base1 : null, x5 = base5 >= VOL_FLOOR5 && r5 ? r5 / base5 : null;
      if (x5 !== null && x5 >= 2) ev.push({ kind: "vol_spike", price: spot, x5: +x5.toFixed(2) });
      if (x !== null && x >= 2) ev.push({ kind: "vol_spike1", price: spot, x: +x.toFixed(2), variant: true });
      V.mins.push(m); if (V.mins.length > 20) V.mins.shift();
      V.cur += m; if (++V.n === 5) { V.b5.push(V.cur); if (V.b5.length > 12) V.b5.shift(); V.cur = 0; V.n = 0; }
      volInfo = { min: m, base: base1 || null, x: x && +x.toFixed(2), x5: x5 && +x5.toFixed(2) };
    }
  }
  return route(st, ev, nowMs, volInfo, dirty);
}

/** Debounce + heartbeat + per-bot routing. Also used by the cron stale check. */
export function route(st, ev, nowMs, volInfo, dirty) {
  const perBot = {};
  for (const bot of WAKE_BOTS) {
    const rt = ROUTES[bot], out = [];
    for (const e of ev) {
      if (rt && !rt.has(e.kind)) continue;
      const key = bot + "|" + e.kind + (e.level ? ":" + e.level : ""), w = LVL_KINDS.has(e.kind) ? DEB_LVL : e.kind === "stale" ? 15 * 60e3 : DEB;
      if (st.deb[key] && nowMs - st.deb[key] < w) continue;
      st.deb[key] = nowMs; dirty = true; out.push(e);
    }
    const real = out.some(e => !e.variant);
    if (real) st.any[bot] = nowMs;
    if (out.length) st.any60[bot] = nowMs;
    if (!real && nowMs - st.any[bot] >= HB) { out.push({ kind: "heartbeat" }); st.any[bot] = nowMs; dirty = true; }
    if (nowMs - st.any60[bot] >= HB60) { out.push({ kind: "hb60", variant: true }); st.any60[bot] = nowMs; dirty = true; }
    if (out.length) perBot[bot] = out;
  }
  return { st, dirty, perBot, volInfo };
}

export function wakePayload(bot, events, b, volInfo, nowMs, url) {
  const kinds = [...new Set(events.map(e => e.kind))].join("+"), ts = new Date(nowMs).toISOString();
  const event_id = hashId((b && b.generated_et || ts).slice(0, 10) + bot + kinds + ts);
  const bx = b && b.boxes ? Object.entries(b.boxes).filter(([, v]) => v && v.green === true).map(([k]) => k) : [];
  const p = { v: 1, src: "aispyalerts", sym: "SPY", ts, event_id, bot, events: events.slice(0, 12),
    board: b ? { spot: b.spot, green: b.green_count, box_count: b.box_count, boxes_green: bx, flip: b.flip, wall_L: b.wall_L, wall_R: b.wall_R, mm_magnet: b.mm_magnet, net_gex: b.net_gex, regime: b.regime, range_5m: b.range_5m, generated_et: b.generated_et } : null,
    vol: volInfo || null, feed: b ? { age_s: Math.max(0, Math.round((nowMs - Date.parse(b.generated_et)) / 1000)), cycle: b.feed && b.feed.cycle } : null, url };
  let s = JSON.stringify(p);
  while (s.length > 2000 && p.events.length > 1) { p.events.pop(); p.truncated = true; s = JSON.stringify(p); }
  return { kinds, event_id, body: s, ts };
}
