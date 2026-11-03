import fs from "fs"; import { trgEval } from "./triggers.js";
const esc = s => "'" + String(s).replace(/'/g, "''") + "'";
const sql = [], counts = {}, samples = {}, logs = [];
for (const [sym, t] of [["SPY", ""], ["QQQ", "_qqq"]]) {
  const today = JSON.parse(fs.readFileSync(`today${t}.json`))[0].results, pr = JSON.parse(fs.readFileSync(`prior${t}.json`))[0].results;
  const prior = {}; for (const r of pr) { const o = JSON.parse(r.opts), m = {}; for (const x of o.rows) m[`${x[0]}|${x[1]}`] = x[5]; prior[r.hm] = m; }
  const base = { vol: sym === "SPY" ? {} : null, prior, priorDate: "2026-11-02" };   // no stored vol history yet
  let st = null; counts[sym] = {};
  for (const r of today) {
    const strikes = []; if (r.opts) { const o = JSON.parse(r.opts), m = new Map(); for (const x of o.rows) { const e = m.get(x[0]) || { strike: x[0], call: {}, put: {} }; e[x[1] === "c" ? "call" : "put"].volume = x[5]; m.set(x[0], e); } strikes.push(...m.values()); }
    const b = { spot: r.spot, flip: r.flip, wall_L: r.L, wall_R: r.R, green_count: r.g, box_count: r.bc, premarket: !!r.pm, generated_et: r.et, strikes };
    const [h, mi] = r.hm.split(":").map(Number);
    const out = trgEval(st, { sym, b, vol: null, date: "2026-11-03", hm: r.hm, h, mi, rth: h * 60 + mi >= 570 && !r.pm, base }); st = out.st;
    for (const l of out.logs) logs.push(sym + " " + l);
    for (const e of out.events) { counts[sym][e.type] = (counts[sym][e.type] || 0) + 1; (samples[e.type] ||= JSON.stringify(e.payload));
      sql.push(`INSERT OR IGNORE INTO trigger_events (date, ts, sym, type, ekey, payload, sent, src) VALUES ('2026-11-03', ${esc(r.ts)}, '${sym}', ${esc(e.type)}, ${esc(e.key)}, ${esc(JSON.stringify(e.payload))}, 0, 'replay');`); }
  }
}
fs.writeFileSync("replay.sql", sql.join("\n") + "\n");
console.log(JSON.stringify({ counts, logs, n: sql.length }, null, 1)); for (const k in samples) console.log(samples[k]);
