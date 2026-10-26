/**
 * GexFeed — Worker port of /workspace/gex-board/live/schwab_feed.py (--source tradier --gamma bs_mid --premarket)
 * + board.py compute_board + notes.py + add_est_oi. PNG/xlsx, chain archives, premarket 6:30-7:30 slot snapshots and
 * oi_check are NOT ported. Board JSON keys/structure match the Python output.
 */
export const WINDOW = 15, WALL_K = 10000, METER_K = 200000, SIG_K = 100000, BLOCK_FRAC = 0.5;
const TRADIER = "https://api.tradier.com/v1";
import { wakeEval, wakePayload, route as wakeRoute } from "./wake.js";
/** D1 helpers injected by index.js (slotStmts, shadowBatch, storeLive). */
export const H = {};
const HTTP_TIMEOUT_MS = 8000;
export const INTERVAL_MS = 5000;
/** Per-symbol feed config. SPY = original shadow feed (unchanged). QQQ = RTH-only live feed into its own storage. */
export const SYMS = {
  SPY: { sym: "SPY", interval: 5000, start: 7 * 3600 + 30 * 60, premarket: true, win: 15, live: false, greenFlag: true },
  // QQQ trades ~0.9x SPY with $1 0DTE strikes near the money, so the same absolute +/-$15 window (~31 strikes) fits.
  // QQQ runs 07:30-16:00 (premarket spot like SPY) for minute snapshots; its live board/D1 storage still updates only from 09:30.
  QQQ: { sym: "QQQ", interval: 10000, start: 7 * 3600 + 30 * 60, premarket: true, win: 15, live: true, greenFlag: false, snap: true },
  // Single-name 0DTE boards: RTH only, 15 s, and only on days whose first Tradier expiration == today (gate0dte; in practice Mon/Wed/Fri).
  // On other days no alarm fires at all: the DO sleeps until the next listed expiration date's 09:30.
  TSLA: { sym: "TSLA", interval: 15000, start: 9 * 3600 + 30 * 60, premarket: false, win: 25, live: true, greenFlag: false, snap: true, gate0dte: true },
  NVDA: { sym: "NVDA", interval: 15000, start: 9 * 3600 + 30 * 60, premarket: false, win: 15, live: true, greenFlag: false, snap: true, gate0dte: true },
  META: { sym: "META", interval: 15000, start: 9 * 3600 + 30 * 60, premarket: false, win: 30, live: true, greenFlag: false, snap: true, gate0dte: true },
};

// NYSE full-day closures (same list as schwab_feed.py). Early closes not modelled.
export const NYSE_HOLIDAYS = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
  "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"]);

/* ---------------- America/New_York time (DST-aware via Intl) ---------------- */
const ETF = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const p2 = n => String(n).padStart(2, "0");
export function etParts(ms) {
  const p = {}; for (const x of ETF.formatToParts(new Date(ms))) p[x.type] = x.value;
  const y = +p.year, mo = +p.month, d = +p.day, h = +p.hour % 24, mi = +p.minute, s = +p.second;
  const off = Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(ms / 1000) * 1000) / 60000);
  return { ms, y, mo, d, h, mi, s, off, date: `${p.year}-${p.month}-${p.day}`, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(), secs: h * 3600 + mi * 60 + s, hm: `${p2(h)}:${p2(mi)}` };
}
export function etEpoch(date, h, mi, s = 0) {
  const [y, mo, d] = date.split("-").map(Number);
  for (const off of [-240, -300]) {
    const ms = Date.UTC(y, mo - 1, d, h, mi, s) - off * 60000, q = etParts(ms);
    if (q.date === date && q.h === h && q.mi === mi) return ms;
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) + 300 * 60000;
}
export function isoET(p) {   // Python datetime.isoformat(timespec='seconds')
  const o = Math.abs(p.off);
  return `${p.date}T${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}${p.off < 0 ? "-" : "+"}${p2(Math.floor(o / 60))}:${p2(o % 60)}`;
}
function addDays(date, n) { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function dowOf(date) { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function tradingDay(date) { const w = dowOf(date); return w >= 1 && w <= 5 && !NYSE_HOLIDAYS.has(date); }
export const SESSION_START = 7 * 3600 + 30 * 60, RTH_START = 9 * 3600 + 30 * 60, SESSION_END = 16 * 3600;
export function inSession(p, start = SESSION_START) { return tradingDay(p.date) && p.secs >= start && p.secs < SESSION_END; }
export function nextSessionStart(ms, start = SESSION_START) {
  let d = etParts(ms).date;
  for (let i = 0; i < 15; i++, d = addDays(d, 1)) { if (!tradingDay(d)) continue; const t = etEpoch(d, Math.floor(start / 3600), Math.floor(start / 60) % 60); if (t > ms) return t; }
  return ms + 3600e3;
}
function pyUtcIso(ms) {   // datetime.fromtimestamp(ms/1000, utc).isoformat()
  const s = Math.floor(ms / 1000), frac = Math.round((ms - s * 1000) * 1000);   // microseconds
  const base = new Date(s * 1000).toISOString().slice(0, 19);
  return base + (frac ? "." + String(frac).padStart(6, "0") : "") + "+00:00";
}
function pyRound(x, n) { return Number(x.toFixed(n)); }
function pyRoundInt(x) { const f = Math.floor(x), r = x - f; if (r === 0.5) return f % 2 === 0 ? f : f + 1; return Math.round(x); }
export function fmtG(x) { return x === null || x === undefined ? "—" : String(Number(x.toPrecision(6))); }   // f"{x:g}"
const num = x => { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; };   // float(x or 0)
const int = x => Math.trunc(num(x));

/* ---------------- Black-Scholes gamma (board.bs_gamma) ---------------- */
export function bsGamma(S, K, iv, T) {
  if (iv <= 0 || T <= 0) return 0.0;
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  return Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI) / (S * iv * Math.sqrt(T));
}

/* ---------------- compute_board (board.py) ---------------- */
export function computeBoard(ins, spot, spotTime, prevClose, quotes, rng, nowMs, opts = {}) {
  const now = etParts(nowMs);
  const rows = new Map(); const upd = []; let exp;
  for (const [iid, q] of quotes) {
    const m = ins.get(iid); if (!m) continue;
    const k = m.strike, side = m.type;
    const g = num(q.gamma), oi = int(q.open_interest), vol = int(q.volume), iv = num(q.implied_volatility);
    const sign = side === "call" ? 1 : -1;
    const gex_f = sign * g * oi * 100, gex_d = gex_f * spot * spot * 0.01;
    if (!rows.has(k)) rows.set(k, { strike: k });
    rows.get(k)[side] = { id: iid, gamma: g, oi, volume: vol, iv, delta: num(q.delta), bid: num(q.bid_price), ask: num(q.ask_price), mark: num(q.mark_price), gex: gex_f, gex_dollar: gex_d };
    upd.push(q.updated_at); exp = m.expiration_date;
  }
  const strikes = [...rows.keys()].sort((a, b) => a - b);
  if (!strikes.length) throw new Error("no strikes in window");
  const R_ = k => rows.get(k);
  for (const k of strikes) {
    const r = R_(k);
    if (!r.call) r.call = { gamma: 0, oi: 0, volume: 0, iv: 0, gex: 0, gex_dollar: 0, bid: 0, ask: 0, mark: 0, delta: 0 };
    if (!r.put) r.put = { gamma: 0, oi: 0, volume: 0, iv: 0, gex: 0, gex_dollar: 0, bid: 0, ask: 0, mark: 0, delta: 0 };
    r.net_gex = r.call.gex + r.put.gex; r.net_gex_dollar = r.call.gex_dollar + r.put.gex_dollar;
    r.sig_100k = Math.abs(r.net_gex) >= SIG_K;
  }
  let net = 0, net_d = 0; for (const k of strikes) net += R_(k).net_gex; for (const k of strikes) net_d += R_(k).net_gex_dollar;
  const argBest = (f, better) => { let b = strikes[0], bv = f(b); for (const k of strikes) { const v = f(k); if (better(v, bv)) { b = k; bv = v; } } return b; };
  const magnet = argBest(k => Math.abs(R_(k).net_gex), (a, b) => a > b);
  const call_wall_gex = argBest(k => R_(k).net_gex, (a, b) => a > b);
  const put_wall_gex = argBest(k => R_(k).net_gex, (a, b) => a < b);
  const stable = (arr, key) => arr.map((k, i) => [k, i]).sort((a, b) => key(a[0]) - key(b[0]) || a[1] - b[1]).map(x => x[0]);
  const top_pos = stable(strikes.filter(k => R_(k).net_gex > 0), k => -R_(k).net_gex).slice(0, 3);
  const top_neg = stable(strikes.filter(k => R_(k).net_gex < 0), k => R_(k).net_gex).slice(0, 3);
  const coi = k => R_(k).call.oi, poi = k => R_(k).put.oi;
  const cxv = strikes.find(k => coi(k) > poi(k)); const cx = cxv === undefined ? null : cxv;
  let px_ = null; const TOUCH = 0.10;
  for (const k of strikes) { if (poi(k) > coi(k) && (poi(k) - coi(k)) > TOUCH * poi(k)) px_ = k; else break; }
  let R = null; const run_r = [];
  if (cx !== null) { let s = 0; for (const k of strikes.filter(k => k >= cx)) { s += coi(k) - poi(k); run_r.push({ strike: k, net: coi(k) - poi(k), cum: s }); if (s >= WALL_K) { R = k; break; } } }
  let L = null; const run_l = [];
  if (px_ !== null) { let s = 0; for (const k of strikes.filter(k => k <= px_).reverse()) { s += poi(k) - coi(k); run_l.push({ strike: k, net: poi(k) - coi(k), cum: s }); if (s >= WALL_K) { L = k; break; } } }
  // flip: BS sweep of total net GEX vs hypothetical spot (0.05 grid, same as Python)
  const closeMs = etEpoch(now.date, 16, 0);
  const T = Math.max((closeMs - nowMs) / 1000, 15 * 60) / (365 * 24 * 3600);
  const cs = [];
  for (const k of strikes) for (const [side, sg] of [["call", 1], ["put", -1]]) { const c = R_(k)[side]; if (c.oi && c.iv) cs.push([k, sg, c.oi, c.iv, 0.5 * c.iv * c.iv * T, c.iv * Math.sqrt(T)]); }
  const SQ2PI = Math.sqrt(2 * Math.PI);
  const totalAt = S => { let t = 0; for (const [k, sg, oi, iv, h, ivs] of cs) { const d1 = (Math.log(S / k) + h) / ivs; t += sg * (Math.exp(-0.5 * d1 * d1) / SQ2PI / (S * ivs)) * oi * 100; } return t; };
  const n = Math.trunc((strikes[strikes.length - 1] - strikes[0]) / 0.05) + 1;
  // CPU: evaluate every `stride`-th point of the same 0.05 grid, then fill the full 0.05 grid only inside coarse
  // intervals that change sign (or hit 0). Same grid points => same flips as Python unless two crossings fall
  // inside one coarse interval (stride 5 = $0.25). stride 1 = exact full sweep.
  const stride = Math.max(1, Math.trunc(opts.flipStride || 1));
  const val = new Array(n), Sx = i => strikes[0] + i * 0.05;
  const at = i => { if (val[i] === undefined) val[i] = totalAt(Sx(i)); return val[i]; };
  const coarse = []; for (let i = 0; i < n; i += stride) coarse.push(i); if (coarse[coarse.length - 1] !== n - 1) coarse.push(n - 1);
  for (const i of coarse) at(i);
  for (let j = 0; j + 1 < coarse.length; j++) { const a = coarse[j], b = coarse[j + 1]; if (b - a > 1 && (val[a] === 0 || (val[a] < 0) !== (val[b] < 0))) for (let i = a + 1; i < b; i++) at(i); }
  const flips = [];
  for (let i = 0; i + 1 < n; i++) { if (val[i] === undefined || val[i + 1] === undefined) continue; const S1 = Sx(i), v1 = val[i], S2 = Sx(i + 1), v2 = val[i + 1]; if (v1 === 0 || (v1 < 0) !== (v2 < 0)) flips.push(S1 + (S2 - S1) * (-v1) / (v2 - v1)); }
  let flip = null; for (const f of flips) if (flip === null || Math.abs(f - spot) < Math.abs(flip - spot)) flip = f;
  let cum = 0, cflip = null, prev = null;
  for (const k of strikes) { cum += R_(k).net_gex; if (prev !== null && (prev < 0) !== (cum < 0) && cflip === null) cflip = k; prev = cum; }
  const boxes = {};
  boxes["10K"] = { green: L !== null && R !== null && L <= spot && spot <= R, L, R, rule: "L <= SPY <= R" };
  const ng = strikes.map(k => R_(k).net_gex);
  const pos_peak = Math.max(...ng, 0), neg_peak = -Math.min(...ng, 0);
  let ratio, one; if (pos_peak > 0 && neg_peak > 0) { ratio = Math.max(pos_peak, neg_peak) / Math.min(pos_peak, neg_peak); one = false; } else { ratio = null; one = true; }
  const dom = pos_peak >= neg_peak ? "+" : "-";
  boxes["2 to 1"] = { green: one || ratio >= 2, ratio, pos_peak, neg_peak, dominant: dom, one_sided: one,
    rule: "peak +GEX strike vs peak |-GEX| strike in the +/-15 window; green if >=2x or one-sided" };
  boxes["Meter"] = { green: Math.abs(net) >= METER_K, net_gex: net, rule: "|NET GEX| >= 200,000 (fern scale)" };
  const regime = (net > 0 && dom === "+") ? "balloon" : (net < 0 && dom === "-") ? "ball" : (net > 0 ? "balloon (mixed lobe)" : "ball (mixed lobe)");
  const rs = net > 0 ? 1 : -1;
  const [lo, hi] = [spot, magnet].sort((a, b) => a - b);
  let blockers = strikes.filter(k => lo < k && k < hi && R_(k).net_gex * rs < 0 && Math.abs(R_(k).net_gex) >= BLOCK_FRAC * Math.abs(R_(magnet).net_gex));
  const up = magnet > spot, start = up ? Math.floor(spot) : Math.ceil(spot);
  const path = strikes.filter(k => up ? (start <= k && k <= magnet) : (magnet <= k && k <= start));
  path.sort((a, b) => up ? a - b : b - a);
  const dips = [];
  for (let i = 1; i < path.length; i++) { const g0 = R_(path[i - 1]).net_gex * rs, g1 = R_(path[i]).net_gex * rs; if (g1 < g0) dips.push(path[i]); }
  blockers = [...new Set([...blockers, ...dips])].sort((a, b) => a - b);
  boxes["Tmagnet BB"] = { green: blockers.length === 0, regime, T: magnet, blockers, dips,
    rule: "balloon/ball needs a smooth ramp: no opposite-sign strike and no drop in |GEX| from strike to strike between SPY and T" };
  if (rng) {
    const direction = magnet > spot ? "calls" : magnet < spot ? "puts" : "none";
    boxes["5M Range"] = { green: spot > rng.high || spot < rng.low, high: rng.high, low: rng.low, setup: direction,
      rule: "green if SPY is outside the 9:30 5-min range (above high or below low)" };
  } else boxes["5M Range"] = { green: false, high: null, low: null, setup: null, note: "range unavailable" };
  const greens = Object.values(boxes).filter(b => b.green).length;
  const dte = Math.round((Date.parse(exp + "T00:00:00Z") - Date.parse(now.date + "T00:00:00Z")) / 86400e3);
  const u = upd.filter(Boolean); let umax = u[0]; for (const x of u) if (x > umax) umax = x;
  return {
    schema: "bloombot-gex-board/v1", symbol: opts.symbol || "SPY", expiration: exp, dte,
    generated_et: isoET(now), generated_label: `${now.date} ${now.hm} ET`,
    spot: pyRound(spot, 3), spot_trade_time_utc: spotTime, prev_close: prevClose,
    quotes_updated_utc_max: umax, window: [strikes[0], strikes[strikes.length - 1]],
    header: { "NET GEX": pyRoundInt(net), "MM Magnet": magnet, SPY: pyRound(spot, 2), L, R },
    net_gex: pyRoundInt(net), net_gex_dollar_per_1pct: pyRoundInt(net_d),
    mm_magnet: magnet, mm_magnet_note: "ASSUMPTION: largest |net GEX| strike in window",
    call_wall_gex, put_wall_gex, top_pos_gex: top_pos, top_neg_gex: top_neg,
    wall_L: L, wall_R: R, call_crossover: cx, put_crossover: px_, running_R: run_r, running_L: run_l,
    flip: flip !== null ? pyRound(flip, 2) : null, flip_all_crossings: flips.map(f => pyRound(f, 2)),
    flip_cum_strike: cflip, regime, range_5m: rng || null,
    boxes, green_count: greens, box_count: Object.keys(boxes).length,
    sig_100k_strikes: strikes.filter(k => R_(k).sig_100k),
    gex_units: "fern scale = gamma*OI*100 per contract side (calls +, puts -); gex_dollar = fern*spot^2*0.01",
    strikes: strikes.map(R_),
  };
}

/* ---------------- est. live OI (schwab_feed.add_est_oi) ---------------- */
const EST_NOTE = "estimate: OI + volume, upper bound, not true OI";
export function addEstOi(b) {
  let tc = 0, tp = 0;
  for (const r of b.strikes || []) {
    const c = r.call || {}, p = r.put || {};
    const ec = int(c.oi) + int(c.volume), ep = int(p.oi) + int(p.volume);
    r.est_oi_call = ec; r.est_oi_put = ep; r.est_oi_total = ec + ep; tc += ec; tp += ep;
  }
  b.est_live_oi = { note: EST_NOTE, label: "Est. live OI (OI+vol, max)", formula: "open_interest + volume per contract", total_call: tc, total_put: tp, total: tc + tp };
  b.est_live_oi_note = EST_NOTE;
  return b;
}

/* ---------------- notes.py ---------------- */
const TAG_TOL = 0.10, MAX_SHOWN = 8, MAG_CONFIRM_S = 60;
export function newNotesState() { return { events: [], keys: [], tagged: [], last: null, buckets: {}, or_done: false }; }
export function notesUpdate(s, b, nowMs) {
  const now = etParts(nowMs), _f = fmtG;
  const add = (key, t, text) => { if (s.keys.includes(key)) return false; s.keys.push(key); s.events.push({ time: t, text, key }); return true; };
  const spot = b.spot ?? null, mag = b.mm_magnet ?? null, L = b.wall_L ?? null, R = b.wall_R ?? null, flip = b.flip ?? null;
  const g = b.green_count ?? null, n = b.box_count || 5, t = now.hm;
  const rth = now.secs >= RTH_START && !b.premarket;
  const last = s.last || {}, lastEmpty = !s.last || !Object.keys(s.last).length;
  const lspot = last.spot ?? null, lg = ("green" in last) ? last.green : g;
  if (rth && spot !== null) {
    const rr = b.range_5m || {};
    if (now.secs >= 9 * 3600 + 35 * 60 && rr.high !== undefined && rr.high !== null)
      add("or", now.secs < 9 * 3600 + 40 * 60 ? "09:35" : t, `Opening range set ${rr.low.toFixed(2)}–${rr.high.toFixed(2)}`);
    const lm = last.magnet ?? null; let conf = lm;
    if (lm === null) conf = mag;
    else if (mag !== null && mag !== lm) {
      let c = s.magcand || {};
      if (c.m !== mag) s.magcand = c = { m: mag, since_ms: nowMs };
      if ((nowMs - c.since_ms) / 1000 >= MAG_CONFIRM_S) { conf = mag; s.magcand = null; }
    } else s.magcand = null;
    if (lm !== null && conf !== lm)
      add(`newmag:${_f(mag)}`, t, `New magnet ${_f(mag)} (was ${_f(lm)})` + (s.tagged.includes(_f(mag)) ? " — already traded" : ""));
    if (mag !== null && !s.tagged.includes(_f(mag))) {
      const crossed = lspot !== null && (lspot - mag) * (spot - mag) < 0;
      if (Math.abs(spot - mag) <= TAG_TOL || crossed) {
        s.tagged.push(_f(mag));
        add(`tag:${_f(mag)}`, t, `${_f(mag)} magnet tagged ${t} — move already played; boxes were ${lg}/${n} before the tag` + (lg < n ? ", no clean setup." : "."));
      }
    }
    for (const k of [4, 5]) {
      if (g !== null && g >= k && lg !== null && (lg < k || lastEmpty)) {
        let cav = "";
        if (mag !== null && s.tagged.includes(_f(mag))) cav = ` (caveat: ${_f(mag)} magnet already traded)`;
        else if (mag !== null && Math.abs(mag - spot) < 1) cav = ` (caveat: only $${Math.abs(mag - spot).toFixed(2)} of room to ${_f(mag)} magnet)`;
        add(`green${k}`, t, `First ${k}/${n} green at ${spot.toFixed(2)}${cav}`);
      }
    }
    if (flip !== null) {
      const side = lspot !== null && lspot > flip ? "above" : "below";
      if (Math.abs(spot - flip) <= TAG_TOL || (lspot !== null && (lspot - flip) * (spot - flip) < 0))
        add(`flipretest:${_f(flip)}`, t, `${_f(flip)} flip retest at ${spot.toFixed(2)} (from ${side})`);
    }
    const bk = `${p2(now.h)}:${p2(now.mi - now.mi % 15)}`;
    const bs = s.buckets, prev = Object.keys(bs).filter(k => k < bk).sort();
    if (prev.length && !(bk in bs) && flip !== null) {
      const pk = prev[prev.length - 1], c = bs[pk], pc = prev.length > 1 ? bs[prev[prev.length - 2]] : null;
      if (pc !== null && (pc - flip) * (c - flip) < 0) {
        const d = c > flip ? "above" : "below";
        add(`flip15:${_f(flip)}:${d}`, t, `15-min close ${d} ${_f(flip)} flip (${c.toFixed(2)}, ${pk} bar)`);
      }
    }
    bs[bk] = spot;
    if (L !== null && spot <= L + TAG_TOL && spot >= L - 0.5) add(`touchL:${_f(L)}`, t, `L wall ${_f(L)} touched at ${spot.toFixed(2)}`);
    if (R !== null && spot >= R - TAG_TOL && spot <= R + 0.5) add(`touchR:${_f(R)}`, t, `R wall ${_f(R)} touched at ${spot.toFixed(2)}`);
    if (L !== null && spot < L - 0.5) add(`breakL:${_f(L)}`, t, `Broke below L wall ${_f(L)} (${spot.toFixed(2)}) — runner territory, no clean target`);
    if (R !== null && spot > R + 0.5) add(`breakR:${_f(R)}`, t, `Broke above R wall ${_f(R)} (${spot.toFixed(2)}) — runner territory, no clean target`);
    s.last = { spot, magnet: conf, green: g, t: isoET(now) };
  }
  b.notes = s.events.slice().reverse().slice(0, MAX_SHOWN).map(e => ({ time: e.time, text: e.text }));
  b.next = nextLine(s, b);
  return b;
}
function nextLine(s, b) {
  const _f = fmtG, spot = b.spot ?? null, mag = b.mm_magnet ?? null, L = b.wall_L ?? null, R = b.wall_R ?? null, flip = b.flip ?? null;
  if (spot === null) return "Next: —";
  if ((L !== null && spot < L - 0.5) || (R !== null && spot > R + 0.5)) return "No clean target left today (outside walls — runner territory)";
  if (mag !== null && !s.tagged.includes(_f(mag)))
    return `Next: ${_f(mag)} magnet ($${Math.abs(mag - spot).toFixed(2)} ${mag > spot ? "above" : "below"}); tag = within $0.10 or cross`;
  const up = spot >= (flip !== null ? flip : spot);
  const wall = up ? R : L, wk = up ? "touchR" : "touchL";
  if (flip !== null) {
    const lvl = up ? flip + 0.5 : flip - 0.5, fk = `flip15:${_f(flip)}:${up ? "above" : "below"}`;
    if (wall !== null && !s.keys.includes(`${wk}:${_f(wall)}`)) {
      if (s.keys.includes(fk)) return `Next: ${_f(wall)} ${up ? "R" : "L"} wall ($${Math.abs(wall - spot).toFixed(2)} away) after 15-min close ${up ? "above" : "below"} ${_f(flip)} flip`;
      return `Next: ${_f(flip)} flip retest; a 15-min close ${up ? ">" : "<"}${lvl.toFixed(2)} targets ${_f(wall)} wall`;
    }
  }
  if (wall !== null && !s.keys.includes(`${wk}:${_f(wall)}`)) return `Next: ${_f(wall)} wall ($${Math.abs(wall - spot).toFixed(2)} away)`;
  return "No clean target left today";
}

/* ---------------- Tradier source (TradierSource, gamma_mode bs_mid) ---------------- */
export class AuthError extends Error {}
export class Tradier {
  constructor(token, opts = {}) { this.token = token; this.sym = opts.symbol || "SPY"; this.win = opts.win || WINDOW; this.exp = null; this.expDay = null; this.rng = null; this.rngDay = null; this.pm = null; this.strikes = null; this.chainMode = opts.chainMode || "chain"; this.reqs = 0; }
  async get(path, params, method = "GET") {
    const qs = new URLSearchParams(params).toString(); this.reqs++;
    let r; const ac = new AbortController(), tm = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);   // cleared, so the DO isn't held open 8 s
    try {
      try {
        r = await fetch(TRADIER + path + (method === "GET" ? "?" + qs : ""), { method, body: method === "POST" ? qs : undefined, signal: ac.signal,
          headers: { Authorization: "Bearer " + this.token, Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) } });
      } catch (e) { throw new Error(`Tradier ${path} failed: ${e && e.name}`); }
      if (r.status === 401) throw new AuthError("401 from Tradier (bad/expired TRADIER_TOKEN)");
      if (r.status === 429) throw new Error("429 rate limited");
      if (!r.ok) throw new Error(`Tradier HTTP ${r.status} on ${path}`);
      try { return await r.json(); } catch (e) { throw new Error(`Tradier ${path} failed: bad JSON`); }
    } finally { clearTimeout(tm); }
  }
  async expiration(today) {
    if (this.expDay === today && this.exp) return this.exp;
    let d = ((await this.get("/markets/options/expirations", { symbol: this.sym, includeAllRoots: "true" })).expirations || {}).date || [];
    d = typeof d === "string" ? [d] : d;
    const fut = d.filter(x => x >= today).sort();
    if (!fut.length) throw new Error("no expirations");
    this.exp = fut[0]; this.expDay = today; this.strikes = null; return this.exp;
  }
  async premarketSpot(q, now) {
    const b = num(q.bid), a = num(q.ask), c = this.pm;
    if (c && Date.now() - c[0] < 30000) {
      if (b > 0 && a > 0 && a - b < 1) return [(b + a) / 2, "bid_ask_mid (timesales cached)"];
      return [c[1], c[2] + " (cached)"];
    }
    try {
      const j = await this.get("/markets/timesales", { symbol: this.sym, interval: "1min", start: `${now.date} 04:00`, end: `${now.date} ${now.hm}`, session_filter: "all" });
      let d = (j.series || {}).data || []; d = Array.isArray(d) ? d : [d];
      if (d.length) {
        const last = d[d.length - 1], m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(last.time);
        const bt = etEpoch(m[1], +m[2], +m[3], +(last.time.slice(17, 19) || 0));
        if ((now.ms - bt) / 1000 <= 20 * 60) { this.pm = [Date.now(), num(last.close), `timesales_all ${m[2]}:${m[3]}`]; return [this.pm[1], this.pm[2]]; }
      }
    } catch (e) { if (e instanceof AuthError) throw e; console.warn("premarket timesales failed", e && e.message); }
    if (b > 0 && a > 0 && a - b < 1) return [(b + a) / 2, "bid_ask_mid"];
    return [num(q.last), "last (prior close?)"];
  }
  async range5m(now) {
    if (this.rngDay === now.date && this.rng) return this.rng;
    if (now.secs < 9 * 3600 + 35 * 60) return null;
    try {
      const j = await this.get("/markets/timesales", { symbol: this.sym, interval: "5min", start: `${now.date} 09:30`, end: `${now.date} 09:35`, session_filter: "open" });
      let d = (j.series || {}).data || []; d = Array.isArray(d) ? d : [d];
      for (const b of d) if (String(b.time || "").endsWith("09:30:00")) { this.rng = { high: num(b.high), low: num(b.low), bar_start_et: "09:30" }; this.rngDay = now.date; return this.rng; }
    } catch (e) { if (e instanceof AuthError) throw e; console.warn("tradier timesales failed", e && e.message); }
    return null;   // Python falls back to cache/range5m_<date>.txt (not available here)
  }
  static contractIv(g) {
    const smv = num(g.smv_vol), mid = num(g.mid_iv);
    if (mid > 0) return mid;
    const b = num(g.bid_iv), a = num(g.ask_iv);
    if (b > 0 && a > 0) return (b + a) / 2;
    return smv;
  }
  async options(exp, spot) {
    if (this.chainMode === "quotes") {   // only the window's contracts (smaller JSON → less CPU). Same fields as the chain.
      if (!this.strikes || Date.now() - this.strikesAt > 1800e3) { this.strikesAt = Date.now(); let s = ((await this.get("/markets/options/strikes", { symbol: this.sym, expiration: exp })).strikes || {}).strike || []; this.strikes = (Array.isArray(s) ? s : [s]).map(Number); }
      const ymd = exp.slice(2).replace(/-/g, ""), syms = [];
      for (const k of this.strikes) if (Math.abs(k - spot) <= this.win + 0.5) for (const c of ["C", "P"]) syms.push(`${this.sym}${ymd}${c}${String(Math.round(k * 1000)).padStart(8, "0")}`);
      if (!syms.length) return [];
      const o = ((await this.get("/markets/quotes", { symbols: syms.join(","), greeks: "true" }, "POST")).quotes || {}).quote || [];
      return Array.isArray(o) ? o : [o];
    }
    const o = ((await this.get("/markets/options/chains", { symbol: this.sym, expiration: exp, greeks: "true" })).options || {}).option || [];
    return Array.isArray(o) ? o : [o];
  }
  async fetch(spotMode = "mid") {
    const t0 = Date.now(); let now = etParts(t0); const today = now.date;
    const q = (await this.get("/markets/quotes", { symbols: this.sym })).quotes.quote;
    const b = num(q.bid), a = num(q.ask);
    let spot = b > 0 && a > 0 && spotMode === "mid" ? (b + a) / 2 : num(q.last);
    this.spotSource = b > 0 && a > 0 && spotMode === "mid" ? "mid" : "last";
    if (spotMode === "premarket") [spot, this.spotSource] = await this.premarketSpot(q, now);
    const spotTime = q.trade_date ? pyUtcIso(q.trade_date) : null;
    const prevClose = q.prevclose ? parseFloat(q.prevclose) : NaN;
    const exp = await this.expiration(today);
    const opts = await this.options(exp, spot);
    if (!opts.length) throw new Error("empty chain");
    const T = Math.max((etEpoch(today, 16, 0) - t0) / 1000, 15 * 60) / (365 * 24 * 3600);   // same floor as the flip sweep
    const ins = new Map(), quotes = new Map();
    for (const o of opts) {
      const k = parseFloat(o.strike);
      if (Math.abs(k - spot) > this.win + 0.5 || o.expiration_date !== exp) continue;
      const g = o.greeks || {}, iv = Tradier.contractIv(g), side = o.option_type, iid = o.symbol;
      ins.set(iid, { id: iid, strike: k, type: side, expiration_date: exp });
      const bid = num(o.bid), ask = num(o.ask);
      quotes.set(iid, { instrument_id: iid, gamma: !iv ? num(g.gamma) : bsGamma(spot, k, iv, T), gamma_tradier: num(g.gamma),
        open_interest: int(o.open_interest), volume: int(o.volume), implied_volatility: iv, delta: num(g.delta), bid_price: bid, ask_price: ask,
        mark_price: bid && ask ? (bid + ask) / 2 : num(o.last), updated_at: pyUtcIso(o.trade_date || Date.now()) });
    }
    return { ins, spot, spotTime, prevClose, quotes, nOpts: opts.length, vol: int(q.volume) };
  }
}

/* ---------------- green flag (ported; never sends unless FEED_MODE=live AND GREEN_FLAG_ENABLED=1) ---------------- */
export function greenFlagCheck(st, b) {
  // returns {send: body, marker} when it would fire; caller decides. st: {streak, day, side, sent:{}}
  const p = b.generated_et, day = p.slice(0, 10), hm = p.slice(11, 16);
  if (st.day !== day) { st.day = day; st.streak = 0; st.sent = {}; }
  if (hm < "09:45" || b.premarket) { st.streak = 0; return null; }
  const ok = b.box_count === 5 && b.green_count === 5, regime = b.regime, side = { balloon: "calls", ball: "puts" }[regime] || null;
  if (side !== st.side) { st.side = side; st.streak = 0; }
  if (side === null) { st.streak = 0; return null; }
  st.streak = ok ? st.streak + 1 : 0;
  if (st.streak < 2 || st.sent[regime]) return null;
  return { regime, body: { side, time_et: b.generated_et, spy: b.spot, net_gex: b.net_gex, regime, magnet: b.mm_magnet, l_wall: b.wall_L, r_wall: b.wall_R, flip: b.flip,
    boxes: Object.fromEntries(Object.entries(b.boxes).map(([k, v]) => [k, Boolean(v.green)])) } };
}

/* ---------------- Durable Object: one instance ("spy") drives the 5 s loop via alarms ---------------- */
export class GexFeed {
  constructor(state, env) { this.state = state; this.env = env; this.cfg = null; this.src = null; this.notes = null; this.notesDay = null; this.fails = 0; this.gf = null; }
  /** Symbol comes from the ?sym= the Worker passes (persisted so alarms know it). Default/legacy instance = SPY. */
  async conf(req) {
    if (!this.cfg) { const s = (await this.state.storage.get("sym")) || "SPY"; this.cfg = SYMS[s] || SYMS.SPY; }
    const want = req && req.headers.get("x-gex-sym");
    if (want && SYMS[want] && want !== this.cfg.sym) { this.cfg = SYMS[want]; this.src = null; }
    if (want && SYMS[want] && want !== "SPY") await this.state.storage.put("sym", want);
    return this.cfg;
  }
  source() {
    const c = this.cfg || SYMS.SPY;
    if (!this.src) this.src = new Tradier(this.env.TRADIER_TOKEN, { chainMode: this.env.GEX_CHAIN_MODE || "quotes", symbol: c.sym, win: c.win });
    return this.src;
  }
  stride() { const v = parseInt(this.env.GEX_FLIP_STRIDE || "5", 10); return v > 0 ? v : 5; }
  mode() { return String(this.env.FEED_MODE || "").trim().toLowerCase() === "live" ? "live" : "shadow"; }
  async loadNotes(day) {
    if (this.notesDay === day && this.notes) return this.notes;
    this.notes = (await this.state.storage.get("notes:" + day)) || newNotesState(); this.notesDay = day;
    const old = [...(await this.state.storage.list({ prefix: "notes:" })).keys()].filter(k => k !== "notes:" + day);
    if (old.length) await this.state.storage.delete(old);
    return this.notes;
  }
  /** One cycle (schwab_feed.main loop body). opts.manual: shadow-only, notes not persisted. */
  async cycle(opts = {}) {
    const t0 = Date.now(), p0 = etParts(t0), manual = !!opts.manual, cfg = await this.conf();
    const pmLive = !cfg.premarket ? false : opts.spotMode ? opts.spotMode === "premarket" : (tradingDay(p0.date) && p0.secs >= SESSION_START && p0.secs < RTH_START);
    const src = this.source(); src.reqs = 0;
    const f = await src.fetch(pmLive ? "premarket" : "mid");
    const tFetch = Date.now();
    let b;
    if (pmLive) {
      b = computeBoard(f.ins, f.spot, f.spotTime, f.prevClose, f.quotes, null, Date.now(), { flipStride: this.stride(), symbol: cfg.sym });
      b.premarket = true; b.range_5m = null;
      if (b.boxes["5M Range"]) b.boxes["5M Range"].green = null;
    } else {
      const rng = await src.range5m(etParts(Date.now()));
      b = computeBoard(f.ins, f.spot, f.spotTime, f.prevClose, f.quotes, rng, Date.now(), { flipStride: this.stride(), symbol: cfg.sym });
    }
    addEstOi(b);
    const day = b.generated_et.slice(0, 10);
    try {
      const st = await this.loadNotes(day);
      notesUpdate(manual ? structuredClone(st) : st, b, Date.parse(b.generated_et) || Date.now());
      if (!manual) await this.state.storage.put("notes:" + day, st);
    } catch (e) { console.warn("notes error", e && e.message); if (!("notes" in b)) b.notes = []; if (!("next" in b)) b.next = null; }
    const meta = (await this.state.storage.get("meta")) || { cycle: 0 };
    meta.cycle = (meta.day === p0.date ? meta.cycle : 0) + 1; meta.day = p0.date;
    b.feed = { premarket_live: pmLive, spot_source: src.spotSource ?? null, source: "tradier", gamma: "bs_mid", interval_s: cfg.interval / 1000, cycle: meta.cycle, ...(cfg.live ? { symbol: cfg.sym, mode: "live" } : {}) };
    const body = JSON.stringify(b);
    const tasks = [];
    if (cfg.live) {
      // QQQ etc.: straight to its own live storage (DO "board_latest" + D1 board_sym_latest/board_<sym>_hist15). Never SPY tables.
      // Manual runs only return the board unless opts.store (so an off-hours test doesn't replace the last session board).
      if ((!manual || opts.store) && !pmLive) { await this.state.storage.put("board_latest", body); await H.storeSym(this.env, cfg.sym, b, body); }
      if (!manual && cfg.snap) { try { const sp = await this.snap(b, body, false, [], cfg.sym); if (sp) tasks.push(sp); } catch (e) { console.warn("snap", e && e.message); } }
    } else {
    const prev = await this.state.storage.get("board_shadow_latest");
    await this.state.storage.put("board_shadow_latest", body);
    if (!manual) {
      // shadow D1 history: only 15-min slots (09:30..16:00), never board_latest/board_hist15
      if (prev) { try { const slots = H.slotStmts(this.env, "board_shadow_hist15", JSON.parse(prev).generated_et, prev, b.generated_et, body, new Date().toISOString()); if (slots.length) tasks.push(H.shadowBatch(this.env, slots)); } catch (e) { console.warn("shadow hist", e && e.message); } }
      if (this.mode() === "live") tasks.push(H.storeLive(this.env, b));
      // green flag: ported, but disabled unless live AND GREEN_FLAG_ENABLED=1
      this.gf = this.gf || (await this.state.storage.get("gf")) || { streak: 0, day: null, side: null, sent: {} };
      const fire = greenFlagCheck(this.gf, b);
      if (fire) {
        if (this.mode() === "live" && this.env.GREEN_FLAG_ENABLED === "1" && this.env.GREEN_FLAG_URL && this.env.GREEN_FLAG_KEY) {
          try {
            const r = await fetch(this.env.GREEN_FLAG_URL, { method: "POST", body: JSON.stringify(fire.body),
              headers: { Authorization: `Bearer ${this.env.GREEN_FLAG_KEY}`, "X-Webhook-Key": this.env.GREEN_FLAG_KEY, "Content-Type": "application/json", "User-Agent": "gex-green-flag/1" } });
            this.gf.sent[fire.regime] = { http: r.status, at: b.generated_et };
          } catch (e) { console.warn("green flag POST failed", e && e.name); }
        } else { this.gf.sent[fire.regime] = { shadow: true, at: b.generated_et }; console.log("green flag WOULD fire (disabled in shadow)", fire.regime); }
      }
      tasks.push(this.state.storage.put("gf", this.gf));
    }
    let wrows = [];
    if (!manual) { try { wrows = await this.wake(b, f.vol, tasks); } catch (e) { console.warn("wake", e && e.message); } }
    if (!manual || opts.snapTest) { try { const sp = await this.snap(b, body, !!opts.snapTest, wrows); if (sp) tasks.push(sp); } catch (e) { console.warn("snap", e && e.message); } }
    }
    await Promise.all(tasks);
    const tEnd = Date.now();
    Object.assign(meta, { sym: cfg.sym, last_et: b.generated_et, mode: cfg.live ? "live" : this.mode(), manual, wall_ms: tEnd - t0, fetch_ms: tFetch - t0, requests: src.reqs, contracts: f.quotes.size, chain_options: f.nOpts, chain_mode: src.chainMode, last_error: null, spot: b.spot });
    if (!manual) await this.state.storage.put("meta", meta);
    console.log(JSON.stringify({ gexfeed: "cycle", sym: cfg.sym, cycle: meta.cycle, manual, pm: pmLive, mode: cfg.live ? "live" : this.mode(), wall_ms: tEnd - t0, fetch_ms: tFetch - t0, req: src.reqs, n: f.quotes.size, spot: b.spot, net: b.net_gex, flip: b.flip, green: b.green_count }));
    return { board: b, meta };
  }
  /** SPY board snapshots -> D1: one per ET minute 07:30-16:00 (feed session) (board_snap_min) + green_count events (board_snap_evt). test=true writes date "test-YYYY-MM-DD", no state change. */
  /** Wake triggers (SHADOW). Returns board_snap_evt rows for the snap batch; POSTs only if WAKE_ENABLED==="1" AND per-bot URL secret. */
  async wake(b, vol, tasks) {
    const now = Date.now(), p = etParts(now);
    if (!inSession(p)) return [];
    const st0 = this.wakeSt = this.wakeSt || (await this.state.storage.get("wake")) || null;
    const r = wakeEval(st0, b, vol, now, p.date + " " + p.hm, { offRule: this.env.WAKE_OFF_RULE || "v2" });
    this.wakeSt = r.st;
    if (r.dirty) tasks.push(this.state.storage.put("wake", r.st));
    return this.wakeEmit(r.perBot, b, r.volInfo, now, p);
  }
  wakeEmit(perBot, b, volInfo, now, p) {
    const rows = [], ts = `${p.date}T${p.hm}:${String(p.s).padStart(2, "0")}`;
    for (const bot in perBot) {
      const pl = wakePayload(bot, perBot[bot], b, volInfo, now, "https://aispyalerts.com/");
      rows.push(["INSERT OR IGNORE INTO board_snap_evt (date, ts, kind, green, body) VALUES (?, ?, ?, ?, ?)", p.date, ts, `wake:${bot}:${pl.kinds}`, b ? b.green_count ?? null : null, pl.body]);
      const B = bot.toUpperCase(), url = this.env["WAKE_URL_" + B], key = this.env["WAKE_KEY_" + B];
      if (this.env.WAKE_ENABLED === "1" && url) {   // gated OFF: WAKE_ENABLED is not set
        this.state.waitUntil(fetch(url, { method: "POST", body: pl.body, headers: { "Content-Type": "application/json", "X-Event-Id": pl.event_id, ...(key ? { Authorization: "Bearer " + key } : {}) } })
          .then(x => console.log("wake POST", bot, x.status)).catch(e => console.warn("wake POST failed", bot, e && e.name)));
      }
    }
    return rows;
  }
  /** Cron stale check: DO status last_et older than 3 min during the session -> "stale" (debounced 15 min), "recovered" logged on next live tick. */
  async staleCheck() {
    const now = Date.now(), p = etParts(now);
    if (!inSession(p) || p.secs < SESSION_START + 300) return { ok: true, skip: true };
    const m = (await this.state.storage.get("meta")) || {}, age = m.last_et ? Math.round((now - Date.parse(m.last_et)) / 1000) : null;
    if (age !== null && age <= 180) return { ok: true, age_s: age };
    let st = this.wakeSt || (await this.state.storage.get("wake"));
    if (!st || st.day !== p.date) return { ok: true, age_s: age, nostate: true };
    const r = wakeRoute(st, [{ kind: "stale", age_s: age }], now, null, false);
    st.stale = true; this.wakeSt = st; await this.state.storage.put("wake", st);
    const rows = this.wakeEmit(r.perBot, null, null, now, p);
    if (rows.length) await H.snapWrite(this.env, rows, false);
    return { ok: true, age_s: age, stale: true, logged: rows.length };
  }
  async snap(b, body, test, extra = [], sym = "SPY") {
    const T = sym === "SPY" ? "" : "_" + sym.toLowerCase();
    const p = etParts(Date.now()), g = typeof b.green_count === "number" ? b.green_count : null;
    const st = this.snapSt = this.snapSt || (await this.state.storage.get("snap")) || { min: null, g: null, purged: null };
    const date = (test ? "test-" : "") + p.date, inRth = test || (tradingDay(p.date) && p.secs >= SESSION_START && p.secs <= 57659);
    const stmts = [], ts = `${p.date}T${p.hm}:${String(p.s).padStart(2, "0")}`, key = date + " " + p.hm;
    if (inRth && st.min !== key) stmts.push([`INSERT OR IGNORE INTO board_snap_min${T} (date, hm, ts, green, body) VALUES (?, ?, ?, ?, ?)`, date, p.hm, ts, g, body]);
    let ev = null;
    if (g !== null) { if ((st.g === null || st.g < 3) && g >= 3) ev = "green3"; if (g === 5 && st.g !== 5) ev = ev ? "green3+5" : "green5"; }
    if (test) ev = "test";
    for (const x of extra) stmts.push(x);
    if (ev && inRth) stmts.push([`INSERT OR IGNORE INTO board_snap_evt${T} (date, ts, kind, green, body) VALUES (?, ?, ?, ?, ?)`, date, ts, ev, g, body]);
    const purge = !test && inRth && st.purged !== p.date;
    const dirty = !test && (st.g !== g || (inRth && st.min !== key) || purge);
    if (!test) { st.min = inRth ? key : st.min; st.g = g; if (purge) st.purged = p.date; }
    const put = dirty ? this.state.storage.put("snap", st) : null;
    if (!stmts.length && !purge) return put;
    return Promise.all([H.snapWrite(this.env, stmts, purge, sym), put]);
  }
  /** 0DTE gate: Tradier expiration dates (cached in DO storage, refreshed at most once per ET day). */
  async exps(today) {
    const c = await this.state.storage.get("exps");
    if (c && c.day === today && Array.isArray(c.dates)) return c.dates;
    let d = ((await this.source().get("/markets/options/expirations", { symbol: this.cfg.sym, includeAllRoots: "true" })).expirations || {}).date || [];
    d = (typeof d === "string" ? [d] : d).filter(x => x >= today).sort().slice(0, 30);
    await this.state.storage.put("exps", { day: today, dates: d });
    return d;
  }
  /** Next session start on a trading day that is also an expiration date (falls back to the plain next session). */
  async nextGated(now, cfg) {
    const p = etParts(now);
    try {
      const d = await this.exps(p.date);
      for (const x of d) { if (!tradingDay(x)) continue; const t = etEpoch(x, Math.floor(cfg.start / 3600), Math.floor(cfg.start / 60) % 60); if (t > now) return t; }
    } catch (e) { console.warn("gate exps", cfg.sym, e && e.message); }
    return nextSessionStart(now, cfg.start);
  }
  /** true if today has a 0DTE (first expiration >= today is today). Cached per day in storage "gate". */
  async gateOk(p) {
    const g = await this.state.storage.get("gate");
    if (g && g.date === p.date) return g.ok;
    const d = await this.exps(p.date), ok = d[0] === p.date;
    await this.state.storage.put("gate", { date: p.date, ok, first: d[0] || null });
    console.log(JSON.stringify({ gexfeed: "gate", sym: this.cfg.sym, date: p.date, ok, first: d[0] || null }));
    return ok;
  }
  async alarm() {
    const now = Date.now(), p = etParts(now), cfg = await this.conf(), iv = cfg.interval;
    if (!inSession(p, cfg.start)) { await this.state.storage.setAlarm(cfg.gate0dte ? await this.nextGated(now, cfg) : nextSessionStart(now, cfg.start)); return; }
    if (cfg.gate0dte) {
      let ok;
      try { ok = await this.gateOk(p); } catch (e) { console.warn("gate", cfg.sym, e && e.message); await this.state.storage.setAlarm(now + 60e3); return; }
      if (!ok) { await this.state.storage.setAlarm(await this.nextGated(etEpoch(p.date, 16, 0), cfg)); return; }
    }
    let next = now + iv;
    try { await this.cycle(); this.fails = 0; next = Math.max(Date.now() + 250, now + iv); }
    catch (e) {
      this.fails += 1; const back = Math.min(30, 5 * 2 ** Math.min(this.fails, 6)) * 1000; next = Date.now() + back;
      if (e instanceof AuthError) next = Date.now() + 300e3;
      // Single-name boards yield first: much longer backoff (30 s doubling to 5 min; 429 -> 5 min) so SPY/QQQ keep the shared Tradier budget.
      if (cfg.gate0dte) next = Date.now() + (/429/.test(String(e && e.message)) ? 300e3 : Math.min(300, 30 * 2 ** Math.min(this.fails - 1, 4)) * 1000);
      console.error(JSON.stringify({ gexfeed: "cycle_error", sym: cfg.sym, fails: this.fails, err: String(e && e.message).slice(0, 200) }));
      try { const m = (await this.state.storage.get("meta")) || {}; m.last_error = { at: new Date().toISOString(), msg: String(e && e.message).slice(0, 200) }; await this.state.storage.put("meta", m); } catch {}
    }
    await this.state.storage.setAlarm(next);
  }
  async fetch(request) {
    const u = new URL(request.url);
    const cfg = await this.conf(request);
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json; charset=utf-8" } });
    if (u.pathname === "/latest") { const b = await this.state.storage.get(cfg.live ? "board_latest" : "board_shadow_latest"); return b ? new Response(b, { headers: { "Content-Type": "application/json; charset=utf-8" } }) : J({ ok: false, error: cfg.live ? `No ${cfg.sym} data yet` : "No shadow board yet" }, 404); }
    if (u.pathname === "/status") { const a = await this.state.storage.getAlarm(); return J({ ok: true, sym: cfg.sym, mode: cfg.live ? "live" : this.mode(), alarm: a ? new Date(a).toISOString() : null, ...(cfg.gate0dte ? { gate: (await this.state.storage.get("gate")) || null } : {}), meta: (await this.state.storage.get("meta")) || null }); }
    if (u.pathname === "/ensure") {
      const a = await this.state.storage.getAlarm();
      if (cfg.gate0dte) {   // gated symbols: an existing alarm is always trusted (it may deliberately skip non-0DTE days)
        if (!a) { const now = Date.now(), p = etParts(now); let ok = null;
          if (inSession(p, cfg.start)) { const g = await this.state.storage.get("gate"); ok = g && g.date === p.date ? g.ok : null; }
          await this.state.storage.setAlarm(inSession(p, cfg.start) && ok !== false ? now + 1000 : await this.nextGated(inSession(p, cfg.start) ? etEpoch(p.date, 16, 0) : now, cfg)); }
        const b = await this.state.storage.getAlarm(), g = await this.state.storage.get("gate");
        return J({ ok: true, rearmed: !a, alarm: new Date(b).toISOString(), gate: g || null });
      }
      const sNext = nextSessionStart(Date.now(), cfg.start);
      if (a && !inSession(etParts(Date.now()), cfg.start) && a > sNext) { await this.state.storage.setAlarm(sNext); }   // start moved earlier (QQQ 09:30 -> 07:30)
      if (!a) { const now = Date.now(); await this.state.storage.setAlarm(inSession(etParts(now), cfg.start) ? now + 1000 : nextSessionStart(now, cfg.start)); }
      const b = await this.state.storage.getAlarm(); return J({ ok: true, rearmed: !a, alarm: new Date(b).toISOString() });
    }
    if (u.pathname === "/stalecheck" && !cfg.live) { try { return J(await this.staleCheck()); } catch (e) { return J({ ok: false, error: String(e && e.message).slice(0, 200) }, 500); } }
    if (u.pathname === "/snaptest" && !cfg.live) {
      try { const { board } = await this.cycle({ manual: true, snapTest: true }); return J({ ok: true, green: board.green_count }); }
      catch (e) { return J({ ok: false, error: String(e && e.message).slice(0, 200) }, 502); }
    }
    if (u.pathname === "/run") {
      try { const { board, meta } = await this.cycle({ manual: true, store: cfg.live && u.searchParams.get("store") === "1", spotMode: u.searchParams.get("spot") === "premarket" ? "premarket" : "mid" }); return J({ ok: true, meta, board }); }
      catch (e) { return J({ ok: false, error: String(e && e.message).slice(0, 200) }, 502); }
    }
    return J({ ok: false, error: "not found" }, 404);
  }
}
