import { trgEval } from "./triggers.js";
let st = null; const E = [];
const step = (hm, spot, vol) => { const [h, mi] = hm.split(":").map(Number);
  const r = trgEval(st, { sym: "SPY", b: { spot, flip: 754, wall_L: 747, wall_R: 761, green_count: 2, box_count: 5, generated_et: `2026-11-03T${hm}:02-05:00`, strikes: [] }, vol, date: "2026-11-03", hm, h, mi, rth: true, base: { vol: { [hm]: [9e6, 1e7, 1.1e7] }, prior: null } }); st = r.st; E.push(...r.events); };
step("10:44", 761.05, 1.5e7); step("10:45", 761.0, 2.1e7); step("10:59", 761.8, 2.2e7); step("11:00", 761.9, 2.3e7); step("11:01", 761.9, 1.4e7); step("11:02", 761.9, 2.5e7);
for (const e of E) console.log(JSON.stringify(e.payload));
