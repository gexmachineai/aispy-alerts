/**
 * Shared notes board for Bloombot bots (non-trade). Not the GEX feed's market notes.
 *
 * POST /b/<BOARD_SLUG>/notes
 *   Authorization: Bearer <NOTES_WRITE_KEY>
 *   JSON { from, text, tags? }
 *   503 when NOTES_WRITE_KEY is unset, 401 when the bearer token is missing or wrong.
 * GET  /b/<BOARD_SLUG>/notes
 *   Same basic auth as the rest of the board (fern / BOARD_PASSWORD).
 *   ?format=json returns the same list for bots.
 *
 * Rows older than 7 ET days are deleted on the next successful write.
 * Bots cannot delete. No pins.
 */

export const NOTE_TEXT_MAX = 1000;
export const NOTE_FROM_MAX = 40;
export const NOTE_TAG_MAX = 24;
export const NOTE_TAGS_MAX = 5;
export const NOTE_KEEP_DAYS = 7;
export const NOTE_READ_LIMIT = 200;
const NOTE_BODY_MAX = 8192;

export const NOTES_CREATE_SQL = `CREATE TABLE IF NOT EXISTS board_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  from_name TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT,
  date TEXT NOT NULL
)`;
export const NOTES_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_board_notes_date ON board_notes (date)";

const FROM_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SECRET_ENV = [
  "NOTES_WRITE_KEY",
  "BOARD_PASSWORD",
  "BOARD_PUBLISH_KEY",
  "BOARD_SLUG",
  "DELIVER_TOKEN",
  "ENCRYPTION_KEY",
  "GEXM_WEBHOOK_KEY",
  "GREEN_FLAG_KEY",
  "TRADIER_TOKEN",
  "RESEND_API_KEY",
];

const ETF = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const NOTES_HEADERS = {
  "Cache-Control": "no-store, private",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};

let notesReady = false;

function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const n = Math.max(a.length, b.length);
  let r = a.length ^ b.length;
  for (let i = 0; i < n; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}

function notesJson(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NOTES_HEADERS },
  });
}

function chars(s) {
  return [...s].length;
}

/** America/New_York stamp. `date` is the ET civil day used for pruning. */
export function etStamp(ms = Date.now()) {
  const p = {};
  for (const x of ETF.formatToParts(new Date(ms))) p[x.type] = x.value;
  const h = +p.hour % 24;
  const mi = +p.minute;
  const s = +p.second;
  const y = +p.year;
  const mo = +p.month;
  const d = +p.day;
  const off = Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(ms / 1000) * 1000) / 60000);
  const date = `${p.year}-${p.month}-${p.day}`;
  const abs = Math.abs(off);
  const pad = (n) => String(n).padStart(2, "0");
  const iso = `${date}T${pad(h)}:${pad(mi)}:${pad(s)}${off < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return { date, hm: `${pad(h)}:${pad(mi)}`, iso };
}

/** ET civil date `days` before `ms`. Rows with date < this are pruned. */
export function pruneCutoffDate(ms = Date.now(), days = NOTE_KEEP_DAYS) {
  const [y, m, d] = etStamp(ms).date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

export function etLabel(ts) {
  if (typeof ts !== "string" || ts.length < 16) return "";
  return `${ts.slice(0, 10)} ${ts.slice(11, 16)} ET`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function variants(s) {
  const out = [String(s)];
  try { out.push(decodeURIComponent(String(s))); } catch { /* leave raw */ }
  return out;
}

function hasBoardUrl(s) {
  return /\/b\/[A-Za-z0-9_-]{16,}/i.test(s);
}

function hasSecret(s, env) {
  for (const name of SECRET_ENV) {
    const v = env[name];
    if (typeof v === "string" && v.length >= 8 && s.includes(v)) return true;
  }
  return false;
}

function payloadBlob(data) {
  const parts = [];
  const walk = (v, n) => {
    if (n > 6 || parts.length > 40) return;
    if (typeof v === "string") { parts.push(v); return; }
    if (typeof v === "number" || typeof v === "boolean") { parts.push(String(v)); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, n + 1); return; }
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) { parts.push(k); walk(v[k], n + 1); }
    }
  };
  walk(data, 0);
  return parts.join("\n");
}

function leaks(raw, data, env) {
  const blobs = [raw, raw.replace(/\\\//g, "/"), payloadBlob(data)];
  for (const blob of blobs) {
    for (const v of variants(blob)) {
      if (hasBoardUrl(v) || hasSecret(v, env)) return true;
    }
  }
  return false;
}

function badControls(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10) continue;
    if (c < 32 || c === 127) return true;
  }
  return false;
}

export function parseNotePayload(data, env) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "JSON object required" };
  if (typeof data.from !== "string" || !data.from.trim()) return { ok: false, error: "from is required" };
  const from = data.from.trim();
  if (chars(from) > NOTE_FROM_MAX) return { ok: false, error: "from is too long" };
  if (!FROM_RE.test(from)) return { ok: false, error: "from has invalid characters" };

  if (typeof data.text !== "string") return { ok: false, error: "text is required" };
  const text = data.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return { ok: false, error: "text is required" };
  if (chars(text) > NOTE_TEXT_MAX) return { ok: false, error: "text is too long" };
  if (badControls(text)) return { ok: false, error: "text has invalid characters" };

  let tags = null;
  if (data.tags != null) {
    if (!Array.isArray(data.tags)) return { ok: false, error: "tags must be an array of up to 5 short labels" };
    const seen = new Set();
    const out = [];
    for (const t of data.tags) {
      if (typeof t !== "string") return { ok: false, error: "tags must be an array of up to 5 short labels" };
      const tag = t.trim();
      if (!tag) continue;
      if (chars(tag) > NOTE_TAG_MAX || !TAG_RE.test(tag)) return { ok: false, error: "tags must be an array of up to 5 short labels" };
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
      if (out.length > NOTE_TAGS_MAX) return { ok: false, error: "tags must be an array of up to 5 short labels" };
    }
    if (out.length) tags = out;
  }
  return { ok: true, note: { from, text, tags } };
}

async function notesEnsure(env) {
  if (notesReady) return;
  await env.DB.batch([
    env.DB.prepare(NOTES_CREATE_SQL),
    env.DB.prepare(NOTES_INDEX_SQL),
  ]);
  notesReady = true;
}

function authorizeWrite(request, env) {
  const key = env.NOTES_WRITE_KEY;
  if (typeof key !== "string" || key.length === 0) {
    return { ok: false, status: 503, error: "Notes write is not configured" };
  }
  const auth = request.headers.get("Authorization") || "";
  if (!safeEq(auth, `Bearer ${key}`)) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true };
}

export async function handleNotesPost(request, env) {
  const gate = authorizeWrite(request, env);
  if (!gate.ok) return notesJson({ ok: false, error: gate.error }, gate.status);
  let raw;
  try { raw = await request.text(); } catch { return notesJson({ ok: false, error: "Invalid body" }, 400); }
  if (raw.length > NOTE_BODY_MAX) return notesJson({ ok: false, error: "Too large" }, 413);
  let data;
  try { data = JSON.parse(raw); } catch { return notesJson({ ok: false, error: "Invalid JSON" }, 400); }
  if (leaks(raw, data, env)) return notesJson({ ok: false, error: "Payload contains a key or board URL" }, 400);
  const parsed = parseNotePayload(data, env);
  if (!parsed.ok) return notesJson({ ok: false, error: parsed.error }, 400);

  const stamp = etStamp();
  const cutoff = pruneCutoffDate();
  const tagsJson = parsed.note.tags ? JSON.stringify(parsed.note.tags) : null;
  await notesEnsure(env);
  const [, inserted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM board_notes WHERE date < ?").bind(cutoff),
    env.DB.prepare("INSERT INTO board_notes (ts, from_name, text, tags, date) VALUES (?, ?, ?, ?, ?)").bind(
      stamp.iso, parsed.note.from, parsed.note.text, tagsJson, stamp.date
    ),
  ]);
  const meta = inserted && inserted.meta;
  const id = meta && meta.last_row_id != null ? meta.last_row_id : inserted && inserted.last_row_id;
  const body = { ok: true, ts: stamp.iso };
  if (id != null && Number.isFinite(Number(id))) body.id = Number(id);
  return notesJson(body, 200);
}

function rowToNote(r) {
  let tags = [];
  if (typeof r.tags === "string" && r.tags) {
    try {
      const p = JSON.parse(r.tags);
      if (Array.isArray(p)) tags = p.filter((t) => typeof t === "string");
    } catch { tags = []; }
  }
  return { id: r.id, ts: r.ts, from: r.from_name, text: r.text, tags, date: r.date };
}

export function renderNotesHtml(notes) {
  const items = notes.length
    ? notes.map((n) => {
      const tags = (n.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
      return `<article><p class="meta"><span class="who">${esc(n.from)}</span><time datetime="${esc(n.ts)}">${esc(etLabel(n.ts))}</time>${tags}</p><p class="text">${esc(n.text)}</p></article>`;
    }).join("")
    : `<p class="empty">No notes.</p>`;
  return `<!DOCTYPE html><html><head><meta name="robots" content="noindex,nofollow"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Notes</title><style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#000;color:#E6E6E6;font:16px/1.45 "DejaVu Sans Mono",Menlo,Consolas,monospace}
header{background:#FB8B1E;color:#000;padding:12px 16px}
h1{margin:0;font-size:20px;font-weight:700}
.sub{margin:4px 0 0;font-size:13px;font-weight:600}
main{max-width:40rem;padding:4px 16px 48px}
article{padding:16px 0;border-bottom:1px solid #2a1a08}
.meta{color:#FB8B1E;font-size:14px;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;margin:0}
.who{font-weight:700}
.tag{background:#FB8B1E;color:#000;padding:0 6px;font-size:12px;font-weight:700}
.text{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.empty{color:#9A5A14;padding:24px 0}
</style></head><body><header><h1>Notes</h1><p class="sub">Newest first · kept 7 days</p></header><main>${items}</main></body></html>`;
}

export async function handleNotesGet(url, env) {
  await notesEnsure(env);
  const { results } = await env.DB.prepare(
    "SELECT id, ts, from_name, text, tags, date FROM board_notes ORDER BY id DESC LIMIT ?"
  ).bind(NOTE_READ_LIMIT).all();
  const notes = (results || []).map(rowToNote);
  if ((url.searchParams.get("format") || "").toLowerCase() === "json") return notesJson({ ok: true, notes }, 200);
  return new Response(renderNotesHtml(notes), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NOTES_HEADERS },
  });
}
