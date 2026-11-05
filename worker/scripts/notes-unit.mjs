/**
 * Notes board route checks. Run: node scripts/notes-unit.mjs
 * Fixtures below are fake. They are not Worker secrets.
 */
import fs from "node:fs";
import worker from "../src/index.js";
import {
  NOTE_KEEP_DAYS,
  NOTE_TEXT_MAX,
  NOTES_CREATE_SQL,
  NOTES_INDEX_SQL,
  etStamp,
  pruneCutoffDate,
  renderNotesHtml,
} from "../src/notes.js";

const SLUG = "testslugtestslug";
const KEY = "notes-write-key-test-value";
const PW = "board-password-test";
const base = `https://board.test/b/${SLUG}`;

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL", msg); failed++; }
  else console.log("ok", msg);
}

function memoryDb() {
  const rows = [];
  const calls = [];
  let seq = 1;
  function exec(sql, args) {
    calls.push({ sql, args: [...args] });
    if (/^CREATE /i.test(sql)) return { success: true, meta: { changes: 0 } };
    if (sql === "DELETE FROM board_notes WHERE date < ?") {
      const cut = args[0];
      let changes = 0;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].date < cut) { rows.splice(i, 1); changes++; }
      return { success: true, meta: { changes } };
    }
    if (sql === "INSERT INTO board_notes (ts, from_name, text, tags, date) VALUES (?, ?, ?, ?, ?)") {
      const row = { id: seq++, ts: args[0], from_name: args[1], text: args[2], tags: args[3], date: args[4] };
      rows.push(row);
      return { success: true, meta: { last_row_id: row.id, changes: 1 } };
    }
    throw new Error("unexpected sql: " + sql);
  }
  function query(sql, args) {
    calls.push({ sql, args: [...args] });
    if (sql !== "SELECT id, ts, from_name, text, tags, date FROM board_notes ORDER BY id DESC LIMIT ?") throw new Error("unexpected read: " + sql);
    return { results: [...rows].sort((a, b) => b.id - a.id).slice(0, args[0]) };
  }
  function stmt(sql) {
    const s = {
      args: [],
      bind(...args) { s.args = args; return s; },
      run: () => exec(sql, s.args),
      all: () => query(sql, s.args),
    };
    return s;
  }
  return {
    rows,
    calls,
    seed(row) { rows.push(row); if (row.id >= seq) seq = row.id + 1; },
    prepare: stmt,
    async batch(stmts) {
      const out = [];
      for (const st of stmts) out.push(await st.run());
      return out;
    },
  };
}

const boom = {
  prepare() { throw new Error("D1 should not be touched"); },
  batch() { throw new Error("D1 should not be touched"); },
};

function envOf(db, extra = {}) {
  return { DB: db, BOARD_SLUG: SLUG, BOARD_PASSWORD: PW, NOTES_WRITE_KEY: KEY, ...extra };
}
function basic(pw = PW) { return "Basic " + btoa(`fern:${pw}`); }

async function call(env, path, init = {}) {
  const res = await worker.fetch(new Request(base + path, init), env, { waitUntil() {} });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}
function post(env, body, headers = {}, path = "/notes") {
  return call(env, path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function leaked(text) {
  const hits = [];
  if (text.includes(KEY)) hits.push("write key");
  if (text.includes(PW)) hits.push("board password");
  if (text.includes(SLUG)) hits.push("board slug");
  return hits;
}

const schema = fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
assert(schema.includes(NOTES_CREATE_SQL), "schema.sql creates board_notes");
assert(schema.includes(NOTES_INDEX_SQL), "schema.sql indexes board_notes.date");
assert(NOTE_KEEP_DAYS === 7, "retention is 7 days");
assert(NOTE_TEXT_MAX === 1000, "text cap is 1000 characters");

const nov = Date.parse("2026-11-05T15:00:00Z");
assert(etStamp(nov).iso === "2026-11-05T10:00:00-05:00", "ET stamp in November");
assert(etStamp(nov).date === "2026-11-05", "ET date in November");
assert(pruneCutoffDate(nov) === "2026-10-29", "prune cutoff is 7 ET days earlier");
const july = Date.parse("2026-07-15T03:30:00Z");
assert(etStamp(july).iso === "2026-07-14T23:30:00-04:00", "ET stamp across the UTC date line");
assert(pruneCutoffDate(july) === "2026-07-07", "prune cutoff in July");

const nasty = renderNotesHtml([{
  id: 1,
  ts: "2026-11-05T10:00:00-05:00",
  from: "<bot>",
  text: 'hi <a href="https://evil.example/x">x</a>',
  tags: ["<x>"],
  date: "2026-11-05",
}]);
assert(!/<a[\s>/]/i.test(nasty) && !/<[^>]*href\s*=/i.test(nasty), "html does not link");
assert(nasty.includes("&lt;bot&gt;") && nasty.includes("&lt;a"), "html escapes text");
assert(nasty.includes("2026-11-05 10:00 ET"), "html shows ET time");
assert(/noindex/i.test(nasty), "html is noindex");

const origFetch = globalThis.fetch;
let outbound = 0;
globalThis.fetch = (...args) => { outbound++; return origFetch(...args); };

const healthRes = await worker.fetch(new Request("https://board.test/api/health"), {}, { waitUntil() {} });
const healthText = await healthRes.text();
assert(healthRes.status === 200 && healthText.includes('"ok":true'), "health route unchanged");

const unset = await post(envOf(boom, { NOTES_WRITE_KEY: undefined }), { from: "bloombot", text: "hi" });
assert(unset.status === 503 && unset.text.includes("not configured"), "POST 503 when NOTES_WRITE_KEY is unset");
assert(!leaked(unset.text).length, leaked(unset.text).length ? "503 body leaked " + leaked(unset.text).join(", ") : "503 body does not echo secrets");
const emptyKey = await post(envOf(boom, { NOTES_WRITE_KEY: "" }), { from: "bloombot", text: "hi" });
assert(emptyKey.status === 503, "POST 503 when NOTES_WRITE_KEY is empty");

const missing = await call(envOf(boom), "/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"from":"bloombot","text":"hi"}' });
assert(missing.status === 401 && missing.text.includes("Unauthorized"), "POST 401 when bearer is missing");
assert(!(missing.headers.get("WWW-Authenticate") || "").includes("Basic"), "POST 401 is not a basic-auth challenge");
const wrong = await post(envOf(boom), { from: "bloombot", text: "hi" }, { Authorization: "Bearer wrong-token" });
assert(wrong.status === 401, "POST 401 when bearer is wrong");
const pwAsBearer = await post(envOf(boom), { from: "bloombot", text: "hi" }, { Authorization: `Bearer ${PW}` });
assert(pwAsBearer.status === 401, "board password is not the write key");

const leakKey = await post(envOf(boom), { from: "bloombot", text: "hi", token: KEY });
assert(leakKey.status === 400 && leakKey.text.includes("key or board URL"), "POST rejects a secret in the payload");
assert(!leaked(leakKey.text).length, leaked(leakKey.text).length ? "400 body leaked " + leaked(leakKey.text).join(", ") : "400 body does not echo secrets");
const leakUrl = await post(envOf(boom), { from: "bloombot", text: "see /b/abcdefghijklmnopqrst" });
assert(leakUrl.status === 400, "POST rejects a board URL");
const leakSlug = await post(envOf(boom), { from: "bloombot", text: "slug " + SLUG });
assert(leakSlug.status === 400, "POST rejects the board slug");

const bad = async (body, msg) => {
  const res = await post(envOf(boom), body);
  assert(res.status === 400, msg);
};
await bad({ text: "hi" }, "from is required");
await bad({ from: "bloombot", text: "   " }, "empty text is rejected");
await bad({ from: "bloombot", text: "x".repeat(NOTE_TEXT_MAX + 1) }, "text over 1000 is rejected");
await bad({ from: "bloombot", text: "hi", tags: "ops" }, "tags must be an array");
await bad({ from: "bloombot", text: "hi", tags: ["one", "two", "three", "four", "five", "six"] }, "more than 5 tags is rejected");
const big = await post(envOf(boom), "x".repeat(9000));
assert(big.status === 413, "oversize body is rejected");

const board = await call(envOf(boom), "/", { headers: { Authorization: basic() } });
assert(board.status === 200 && board.text.includes("SPY GEX Board") && !board.text.includes("/notes"), "GEX board is unchanged and does not link to notes");

const openHtml = await call(envOf(boom), "/notes");
assert(openHtml.status === 401 && (openHtml.headers.get("WWW-Authenticate") || "").includes("Basic"), "HTML read requires board basic auth");
const openJson = await call(envOf(boom), "/notes?format=json");
assert(openJson.status === 401, "JSON read requires board basic auth");
assert(!openHtml.text.includes("No notes") && !openJson.text.includes('"notes"'), "unauthorized read does not return notes");

const db = memoryDb();
const today = etStamp().date;
db.seed({ id: 1, ts: "1999-01-01T00:00:00-05:00", from_name: "old", text: "stale-note", tags: null, date: "1999-01-01" });
db.seed({ id: 2, ts: today + "T09:00:00-05:00", from_name: "keep", text: "recent-note", tags: null, date: today });

const noPw = await post(envOf(db, { BOARD_PASSWORD: undefined }), { from: "bloombot", text: "writes do not need the board password", tags: ["ops", "ops"] });
assert(noPw.status === 200, "POST works without board basic auth");
const saved = JSON.parse(noPw.text);
assert(saved.ok === true && saved.id === 3 && typeof saved.ts === "string", "POST returns id and ts");
assert(!leaked(noPw.text).length, leaked(noPw.text).length ? "POST success leaked " + leaked(noPw.text).join(", ") : "POST success does not echo secrets");
const ins = db.calls.filter((c) => c.sql.startsWith("INSERT"));
assert(ins.length === 1 && ins[0].args[1] === "bloombot" && ins[0].args[2] === "writes do not need the board password", "only from and text are stored");
assert(ins[0].args[3] === '["ops"]' && ins[0].args[4] === saved.ts.slice(0, 10), "tags deduped and date is the ET day");
assert(!JSON.stringify(ins[0].args).includes(KEY) && !JSON.stringify(ins[0].args).includes(SLUG), "insert args have no key or board url");
const pruned = db.calls.find((c) => c.sql.startsWith("DELETE"));
assert(pruned && pruned.args[0] === pruneCutoffDate(), "write prunes at the 7-day ET cutoff");
assert(!db.rows.some((r) => r.text === "stale-note"), "rows older than 7 days are removed");
assert(db.rows.some((r) => r.text === "recent-note"), "a row from today is kept");

const extra = await post(envOf(db), { from: "bloombot", text: "see https://example.com/news", source: "https://example.com/public", tags: ["desk"] });
assert(extra.status === 200, "ordinary https text is allowed");
const extraRow = db.rows.find((r) => r.text.startsWith("see https://"));
assert(extraRow && extraRow.text === "see https://example.com/news" && !JSON.stringify(extraRow).includes("example.com/public"), "extra fields are not stored");

const second = await post(envOf(db), { from: "other bot", text: "second note" });
assert(second.status === 200, "second note accepted");

const html = await call(envOf(db), "/notes", { headers: { Authorization: basic() } });
assert(html.status === 200 && (html.headers.get("Content-Type") || "").includes("text/html"), "HTML read with board auth");
assert(/noindex/i.test(html.headers.get("X-Robots-Tag") || "") && /no-store/i.test(html.headers.get("Cache-Control") || ""), "HTML is noindex and no-store");
assert(html.text.includes('name="viewport"') && html.text.includes("other bot") && html.text.includes("second note") && html.text.includes(" ET"), "HTML lists from, ET time, and text");
assert(html.text.indexOf("second note") < html.text.indexOf("see https://example.com/news"), "HTML is newest first");
assert(!/<a[\s>]/i.test(html.text) && !/href\s*=/i.test(html.text), "HTML page has no links");
assert(!leaked(html.text).length, leaked(html.text).length ? "HTML leaked " + leaked(html.text).join(", ") : "HTML does not echo secrets");

const wrongPw = await call(envOf(db), "/notes?format=json", { headers: { Authorization: basic("nope") } });
assert(wrongPw.status === 401 && !wrongPw.text.includes("second note"), "wrong board password does not return notes");

const json = await call(envOf(db), "/notes?format=JSON", { headers: { Authorization: basic() } });
assert(json.status === 200 && (json.headers.get("Content-Type") || "").includes("application/json"), "format=json with board auth");
const body = JSON.parse(json.text);
assert(body.ok === true && body.notes[0].from === "other bot" && body.notes[0].text === "second note" && body.notes[0].tags.length === 0, "JSON is newest first");
assert(body.notes.some((n) => n.tags.includes("desk") && n.text.includes("https://example.com/news")), "JSON includes tags and plain text");
assert(!leaked(json.text).length, leaked(json.text).length ? "JSON leaked " + leaked(json.text).join(", ") : "JSON does not echo secrets");

const slash = await post(envOf(db), { from: "bloombot", text: "slash path" }, {}, "/notes/");
assert(slash.status === 200, "POST /notes/ is the same route");

const del = await call(envOf(db), "/notes", { method: "DELETE", headers: { Authorization: basic() } });
assert(del.status === 405, "DELETE is not offered to bots");
assert(db.rows.some((r) => r.text === "second note"), "DELETE does not remove rows");

const cap = await post(envOf(db), { from: "bloombot", text: "y".repeat(NOTE_TEXT_MAX) });
assert(cap.status === 200 && db.rows.some((r) => r.text.length === NOTE_TEXT_MAX), "1000 character text is accepted");

assert(outbound === 0, "notes routes make no outbound requests");
globalThis.fetch = origFetch;

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("notes unit ok");
