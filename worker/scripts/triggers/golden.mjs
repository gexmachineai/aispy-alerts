// Golden: run GexFeed.cycle (old vs new) on identical mocked Tradier data + fixed clock; compare board JSON and D1 rows.
import fs from "fs";
const W = "/workspace/aispy-alerts/worker/src/";
fs.copyFileSync(W + "gexfeed.js.bak-pre-triggers", "/workspace/trgtest/gexfeed_old.js");
for (const f of ["wake.js", "triggers.js"]) fs.copyFileSync(W + f, "/workspace/trgtest/" + f);
fs.copyFileSync(W + "gexfeed.js", "/workspace/trgtest/gexfeed_new.js");
const spotAt = t => 680 + 3 * Math.sin(t / 7e5);
function mockFetch(clock) {
  return async (url, init) => {
    const u = new URL(url), t = clock(), s = spotAt(t), path = u.pathname.replace("/v1", "");
    const J = o => ({ ok: true, status: 200, json: async () => o });
    if (path === "/markets/quotes" && (init.method || "GET") === "GET") return J({ quotes: { quote: { bid: s - 0.01, ask: s + 0.01, last: s, volume: Math.round((t % 1e8) / 10), trade_date: t - 1000, prevclose: "679" } } });
    if (path === "/markets/options/expirations") return J({ expirations: { date: ["2026-11-03", "2026-11-04"] } });
    if (path === "/markets/options/strikes") { const a = []; for (let k = 640; k <= 720; k++) a.push(k); return J({ strikes: { strike: a } }); }
    if (path === "/markets/timesales") return J({ series: { data: [{ time: "2026-11-03T09:30:00", high: 681, low: 679, close: 680 }] } });
    if (path === "/markets/quotes") {
      const syms = new URLSearchParams(init.body).get("symbols").split(","), q = [];
      for (const sy of syms) { const k = parseInt(sy.slice(-8)) / 1000, c = sy[sy.length - 9] === "C", d = (k - 680) / 10;
        q.push({ symbol: sy, strike: k, option_type: c ? "call" : "put", expiration_date: "2026-11-03", open_interest: Math.round(5000 * Math.exp(-d * d) + (c ? 300 * k % 7 : 200 * k % 5)), volume: Math.round(((t / 1000) % 9000) * Math.exp(-d * d) * (c ? 1.1 : 0.9)), bid: 1, ask: 1.1, last: 1.05, trade_date: t - 2000, greeks: { mid_iv: 0.15 + 0.01 * Math.abs(d), delta: c ? 0.5 : -0.5, gamma: 0.05 } }); }
      return J({ quotes: { quote: q } });
    }
    throw new Error("unmocked " + path);
  };
}
function mkState() { const m = new Map(); let alarm = null; return { storage: { get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { for (const x of [].concat(k)) m.delete(x); }, list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))), getAlarm: async () => alarm, setAlarm: async a => { alarm = a; } }, waitUntil: () => {} }; }
async function run(modPath) {
  const mod = await import(modPath + "?" + Math.random()), out = [], rows = [];
  let T = Date.UTC(2026, 10, 3, 14, 40, 0);   // 09:40 ET
  const realNow = Date.now; Date.now = () => T; globalThis.fetch = mockFetch(() => T);
  mod.H.snapWrite = async (env, r) => { for (const x of r) rows.push(x); }; mod.H.shadowBatch = async () => {}; mod.H.slotStmts = () => [];
  mod.H.trgLoad = async () => ({ vol: null, prior: null, priorDate: null });
  const g = new mod.GexFeed(mkState(), { TRADIER_TOKEN: "x" });
  for (let i = 0; i < 400; i++) { const { board } = await g.cycle(); out.push(JSON.stringify(board)); T += 5000; await new Promise(r => setImmediate(r)); }
  Date.now = realNow; return { out, rows };
}
const log = console.log; console.log = () => {}; console.warn = () => {};
const A = await run("/workspace/trgtest/gexfeed_old.js"), B = await run("/workspace/trgtest/gexfeed_new.js");
console.log = log;
let diff = 0; for (let i = 0; i < A.out.length; i++) if (A.out[i] !== B.out[i]) diff++;
const minA = A.rows.filter(r => /board_snap_min/.test(r[0])), minB = B.rows.filter(r => /board_snap_min/.test(r[0]));
let rd = 0; for (let i = 0; i < minA.length; i++) if (JSON.stringify(minA[i].slice(1)) !== JSON.stringify(minB[i].slice(1, 7))) rd++;
const evtA = A.rows.filter(r => /board_snap_evt/.test(r[0])).map(r => JSON.stringify(r)), evtB = B.rows.filter(r => /board_snap_evt/.test(r[0])).map(r => JSON.stringify(r));
const trg = B.rows.filter(r => /trigger_events/.test(r[0]));
log(JSON.stringify({ boards: A.out.length, board_diffs: diff, min_rows: [minA.length, minB.length], min_row_diffs: rd, evt_same: JSON.stringify(evtA) === JSON.stringify(evtB), evt_n: evtA.length, trigger_rows: trg.length, types: trg.map(r => r[4]), sample: trg.slice(0, 2).map(r => r[6]), vol_col: minB.slice(0, 2).map(r => r[7]) }));
