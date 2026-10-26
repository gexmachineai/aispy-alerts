import { BOARD_HTML } from "./board_html.js";
import { GexFeed, H as GEX_H } from "./gexfeed.js";
export { GexFeed };
/**
 * AISPYALERTS API — subscribe (webhook + email) + deliver fan-out
 *
 * POST /api/subscribe: name, email, webhookUrl, senderKey → D1 (key encrypted)
 *   and Resend Founding Free enroll when RESEND_API_KEY is set.
 * POST /api/deliver: Bearer DELIVER_TOKEN → POST alerts to subscriber webhooks
 *   (skips rows without a usable webhook).
 *   Optional body.emails: string[] allowlist — only those emails get the webhook;
 *   omit emails for all active webhook subscribers. emails is stripped before POST.
 *
 * Secrets: ENCRYPTION_KEY (base64 32 bytes), DELIVER_TOKEN, RESEND_API_KEY
 * Binding: DB (D1)
 */

const ALLOWED_ORIGINS = new Set([
  "https://aispyalerts.com",
  "http://aispyalerts.com",
  "https://www.aispyalerts.com",
  "http://www.aispyalerts.com",
  "https://gexmachineai.github.io",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
]);

/** Resend segment used by Alert Spreader BCC ("Founding Free"). */
const RESEND_FOUNDING_FREE_SEGMENT_ID = "da3de8a2-5fad-4718-b96b-eca4516945f8";

function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://aispyalerts.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function getAesKey(env) {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY not configured");
  const raw = b64ToBytes(env.ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSecret(plain, env) {
  const key = await getAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain)
  );
  return `${bytesToB64(iv)}.${bytesToB64(new Uint8Array(enc))}`;
}

async function decryptSecret(blob, env) {
  const [ivB64, dataB64] = String(blob).split(".");
  if (!ivB64 || !dataB64) throw new Error("bad ciphertext");
  const key = await getAesKey(env);
  const dec = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(ivB64) },
    key,
    b64ToBytes(dataB64)
  );
  return new TextDecoder().decode(dec);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isHttpsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function hasUsableWebhook(sub) {
  const url = sub && sub.webhook_url != null ? String(sub.webhook_url).trim() : "";
  const key = sub && sub.sender_key_encrypted != null ? String(sub.sender_key_encrypted).trim() : "";
  return Boolean(url && key && isHttpsUrl(url));
}

/**
 * Create/upsert contact in Resend and ensure membership in Founding Free.
 * Returns { ok, skipped?, error? }. Never throws — subscribe still succeeds on D1.
 */
async function enrollResendFoundingFree(email, name, env) {
  if (!env.RESEND_API_KEY) {
    console.warn(
      "RESEND_API_KEY missing — D1 saved but Resend enroll skipped. Run: wrangler secret put RESEND_API_KEY"
    );
    return { ok: false, skipped: true, error: "RESEND_API_KEY not configured" };
  }

  const headers = {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };

  const firstName = name ? String(name).trim().split(/\s+/)[0] : undefined;
  const createBody = {
    email,
    unsubscribed: false,
    segments: [{ id: RESEND_FOUNDING_FREE_SEGMENT_ID }],
  };
  if (firstName) createBody.first_name = firstName;

  try {
    const createRes = await fetch("https://api.resend.com/contacts", {
      method: "POST",
      headers,
      body: JSON.stringify(createBody),
    });

    if (createRes.ok) {
      return { ok: true };
    }

    let createErr = null;
    try {
      createErr = await createRes.json();
    } catch (_) {}

    // Contact may already exist — add to segment by email
    const addRes = await fetch(
      `https://api.resend.com/contacts/${encodeURIComponent(email)}/segments/${RESEND_FOUNDING_FREE_SEGMENT_ID}`,
      { method: "POST", headers }
    );

    if (addRes.ok) {
      return { ok: true };
    }

    let addErr = null;
    try {
      addErr = await addRes.json();
    } catch (_) {}

    console.error("resend enroll failed", {
      createStatus: createRes.status,
      createErr,
      addStatus: addRes.status,
      addErr,
    });
    return {
      ok: false,
      error: `Resend enroll failed (create ${createRes.status}, add ${addRes.status})`,
    };
  } catch (err) {
    console.error("resend enroll network error", err);
    return { ok: false, error: "Resend network error" };
  }
}

async function handleSubscribe(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400, origin);
  }

  const name = body.name != null ? String(body.name).trim() : "";
  const email = body.email != null ? String(body.email).trim().toLowerCase() : "";
  const webhookUrl = body.webhookUrl != null ? String(body.webhookUrl).trim() : "";
  const senderKey = body.senderKey != null ? String(body.senderKey) : "";

  if (!email || !isValidEmail(email)) {
    return json({ ok: false, error: "Valid email is required" }, 400, origin);
  }
  if (!webhookUrl || !isHttpsUrl(webhookUrl)) {
    return json({ ok: false, error: "webhookUrl must be a valid https URL" }, 400, origin);
  }
  if (!senderKey || senderKey.length < 8) {
    return json({ ok: false, error: "senderKey must be at least 8 characters" }, 400, origin);
  }

  let encrypted;
  try {
    encrypted = await encryptSecret(senderKey, env);
  } catch (err) {
    console.error("encrypt failed", err);
    return json({ ok: false, error: "Server encryption not configured" }, 500, origin);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO subscribers (email, name, webhook_url, sender_key_encrypted, updated_at, active)
       VALUES (?, ?, ?, ?, datetime('now'), 1)
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name,
         webhook_url = excluded.webhook_url,
         sender_key_encrypted = excluded.sender_key_encrypted,
         updated_at = datetime('now'),
         active = 1`
    )
      .bind(email, name || null, webhookUrl, encrypted)
      .run();
  } catch (err) {
    console.error("subscribe upsert failed", err);
    return json({ ok: false, error: "Database error" }, 500, origin);
  }

  // Also enroll Founding Free when RESEND_API_KEY is set (email fan-out path)
  const resend = await enrollResendFoundingFree(email, name, env);

  // Never return sender key
  return json(
    {
      ok: true,
      resend:
        resend.skipped
          ? { enrolled: false, skipped: true, note: "Set Worker secret RESEND_API_KEY" }
          : { enrolled: Boolean(resend.ok), error: resend.error || null },
    },
    200,
    origin
  );
}

async function postWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function attemptPost(sub, payload, env) {
  let senderKey;
  try {
    senderKey = await decryptSecret(sub.sender_key_encrypted, env);
  } catch (err) {
    return { status: 0, ok: false, error: "decrypt_failed", detail: "" };
  }
  const opts = {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${senderKey}`,
      "X-Automation-Key": senderKey,
    },
    body: payload,
  };
  try {
    const res = await postWithTimeout(sub.webhook_url, opts, 8000);
    let detail = "";
    if (!res.ok) { try { detail = (await res.text()).slice(0, 300); } catch {} }
    return { status: res.status, ok: res.ok, error: res.ok ? null : `http_${res.status}`, detail };
  } catch (err) {
    const msg = err && err.name === "AbortError" ? "timeout" : "network_error";
    return { status: 0, ok: false, error: msg, detail: "" };
  }
}

// Retryable in the background: Cursor automation rate limit (400 "rate limit"), 429, 5xx, network/timeout
function isRetryable(r) {
  if (!r || r.ok || r.error === "decrypt_failed") return false;
  return r.status === 0 || r.status === 429 || r.status >= 500 || /rate limit/i.test(r.detail || "");
}

async function deliverOne(sub, alertBody, env) {
  const payload = typeof alertBody === "string" ? alertBody : JSON.stringify(alertBody);
  let result = await attemptPost(sub, payload, env);
  // One quick retry on 5xx or network/timeout; longer retries happen in the background
  if (!result.ok && (result.status >= 500 || result.status === 0)) {
    result = await attemptPost(sub, payload, env);
  }
  if (!result.ok) {
    console.error("deliver failed (first pass)", { email: sub.email, status: result.status, error: result.error });
    return { email: sub.email, status: result.status, error: result.error, detail: result.detail || "", payload };
  }
  return null;
}

async function logOutcome(env, row) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS deliver_log (id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT, email TEXT, outcome TEXT, status INTEGER, attempts INTEGER, detail TEXT, created_at TEXT DEFAULT (datetime('now')))`
    ).run();
    await env.DB.prepare(
      `INSERT INTO deliver_log (job, email, outcome, status, attempts, detail) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(row.job, row.email, row.outcome, row.status, row.attempts, (row.detail || "").slice(0, 300)).run();
  } catch (err) {
    console.error("deliver_log write failed", err);
  }
}

// One Durable Object per (job, target): retries every ~4s via alarms until success or deadline (~2 min)
export class DeliverRetry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const job = await request.json();
    await this.state.storage.put("job", { ...job, attempts: 0 });
    await this.state.storage.setAlarm(Date.now() + job.intervalMs);
    return new Response("queued");
  }
  async alarm() {
    const job = await this.state.storage.get("job");
    if (!job) return;
    let sub = null;
    try {
      sub = await this.env.DB.prepare(
        `SELECT email, webhook_url, sender_key_encrypted FROM subscribers WHERE active = 1 AND lower(email) = ?`
      ).bind(String(job.email).toLowerCase()).first();
    } catch (err) {
      console.error("retry load sub failed", err);
    }
    const attempts = (job.attempts || 0) + 1;
    if (!sub || !hasUsableWebhook(sub)) {
      await logOutcome(this.env, { job: job.job, email: job.email, outcome: "gave_up_no_webhook", status: 0, attempts, detail: "" });
      await this.state.storage.deleteAll();
      return;
    }
    const r = await attemptPost(sub, job.payload, this.env);
    const retryable = job.retryAll ? !r.ok : isRetryable(r);
    const nextAt = Date.now() + job.intervalMs;
    if (r.ok || !retryable || nextAt > job.deadline) {
      const outcome = r.ok ? "delivered" : retryable ? "gave_up_deadline" : "gave_up_nonretryable";
      console.log("deliver retry final", { job: job.job, email: job.email, outcome, status: r.status, attempts });
      await logOutcome(this.env, { job: job.job, email: job.email, outcome, status: r.status, attempts, detail: r.detail });
      await this.state.storage.deleteAll();
      return;
    }
    await this.state.storage.put("job", { ...job, attempts });
    await this.state.storage.setAlarm(nextAt);
  }
}

async function handleDeliver(request, env, origin, ctx) {
  const auth = request.headers.get("Authorization") || "";
  const expected = env.DELIVER_TOKEN;
  if (!expected || auth !== `Bearer ${expected}`) {
    return json({ ok: false, error: "Unauthorized" }, 401, origin);
  }

  let alertBody;
  try {
    alertBody = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400, origin);
  }

  // Optional allowlist: { emails: ["a@x.com","b@y.com"], SIGNAL: "..." }
  // When present, only those subscribers get the webhook. Omit = all active (legacy).
  let allowEmails = null;
  if (alertBody && Array.isArray(alertBody.emails)) {
    allowEmails = alertBody.emails
      .map((e) => String(e || "").trim().toLowerCase())
      .filter(Boolean);
  }
  // Never forward the allowlist field to subscriber bots
  const { emails: _emailsIgnored, ...deliverPayload } = alertBody && typeof alertBody === "object" ? alertBody : {};
  const payloadForBots = allowEmails ? deliverPayload : alertBody;

  let rows;
  try {
    const result = await env.DB.prepare(
      `SELECT email, webhook_url, sender_key_encrypted FROM subscribers WHERE active = 1`
    ).all();
    rows = result.results || [];
  } catch (err) {
    console.error("load subscribers failed", err);
    return json({ ok: false, error: "Database error" }, 500, origin);
  }

  if (allowEmails && allowEmails.length) {
    const want = new Set(allowEmails);
    rows = rows.filter((r) => want.has(String(r.email || "").trim().toLowerCase()));
  }

  // Skip email-only rows (no usable webhook) so they don't spam decrypt/network errors
  const webhookRows = rows.filter(hasUsableWebhook);
  const skipped = rows.length - webhookRows.length;

  const failed = [];
  let delivered = 0;

  // Test-only knobs (DELIVER_TOKEN-gated): retryAllFailures treats any failure as retryable; retryWindowMs caps the window
  const retryAll = Boolean(alertBody && alertBody.retryAllFailures === true);
  const windowMs = Math.min(Math.max(Number(alertBody && alertBody.retryWindowMs) || 120000, 10000), 120000);
  const { retryAllFailures: _ra, retryWindowMs: _rw, ...cleanForBots } = payloadForBots && typeof payloadForBots === "object" ? payloadForBots : {};
  const botBody = payloadForBots && typeof payloadForBots === "object" ? cleanForBots : payloadForBots;

  const jobId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const outcomes = await Promise.all(webhookRows.map((sub) => deliverOne(sub, botBody, env)));
  const retrying = [];
  for (const fail of outcomes) {
    if (!fail) { delivered += 1; continue; }
    const { payload, ...pub } = fail;
    const willRetry = Boolean(env.DELIVER_RETRY) && (retryAll || isRetryable(fail));
    failed.push({ ...pub, retrying: willRetry });
    if (willRetry) {
      retrying.push(fail.email);
      const stub = env.DELIVER_RETRY.get(env.DELIVER_RETRY.idFromName(`${jobId}:${fail.email}`));
      const p = stub.fetch("https://retry/start", {
        method: "POST",
        body: JSON.stringify({ job: jobId, email: fail.email, payload, intervalMs: 4000, deadline: Date.now() + windowMs, retryAll }),
      }).catch((err) => console.error("retry enqueue failed", { email: fail.email, err: String(err) }));
      if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    }
  }

  return json(
    {
      ok: true,
      delivered,
      failed,
      skipped,
      total: rows.length,
      webhookTargets: webhookRows.length,
      job: jobId,
      retrying,
      retryWindowMs: retrying.length ? windowMs : 0,
      filtered: Boolean(allowEmails && allowEmails.length),
      emails: allowEmails,
    },
    200,
    origin
  );
}

/* ---- Private GEX board (Basic Auth, served by Worker) ---- */
const BOARD_MAX_BYTES = 1000000;
const BOARD_KEEP = 200;
const BOARD_USER = "fern";
const BOARD_H15_KEEP = 30;
const boardTrim = (env, table = "board_hist15") => env.DB.prepare(`DELETE FROM ${table} WHERE bucket NOT IN (SELECT bucket FROM ${table} ORDER BY ts DESC, bucket DESC LIMIT ?)`).bind(BOARD_H15_KEEP);
// History slots: 09:30 ET then every 15 min through 16:00. Each slot holds the board AT the mark,
// or else the latest board published before it on the same day.
function boardSlotsBetween(aTs, bTs) {
  const a = Date.parse(aTs), b = Date.parse(bTs), out = [];
  if (!(a < b)) return out;
  const days = new Set([String(aTs).slice(0, 10), String(bTs).slice(0, 10)]);
  const om = /([+-]\d{2}:\d{2})$/.exec(aTs) || /([+-]\d{2}:\d{2})$/.exec(bTs), off = om ? om[1] : "-04:00";
  for (const d of days) for (let m = 570; m <= 960; m += 15) {
    const hm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const e = Date.parse(`${d}T${hm}:00${off}`);
    if (e > a && e <= b) out.push({ key: `${d}T${hm}`, day: d, epoch: e });
  }
  return out;
}
function boardSlotStmts(env, prevTs, prevBody, newTs, newBody, now, table = "board_hist15") {
  const stmts = [];
  for (const sl of boardSlotsBetween(prevTs, newTs)) {
    let ts, body;
    if (newBody && Date.parse(newTs) === sl.epoch) { ts = newTs; body = newBody; }
    else if (prevBody && String(prevTs).slice(0, 10) === sl.day) { ts = prevTs; body = prevBody; }
    else continue;
    let d; try { d = JSON.parse(body); } catch { continue; }
    if (!d || typeof d !== "object") continue;
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO ${table} (bucket, ts, received_at, summary, body) VALUES (?, ?, ?, ?, ?)`).bind(sl.key, ts, now, boardSummary(d), body));
  }
  return stmts;
}
function boardSummary(d) {
  const pick = ["generated_et", "generated_label", "spot", "net_gex", "regime", "wall_L", "wall_R", "mm_magnet", "flip", "green_count", "box_count"];
  const o = {}; for (const k of pick) if (d[k] !== undefined) o[k] = d[k];
  return JSON.stringify(o);
}
async function boardEnsure(env) {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS board_latest (id INTEGER PRIMARY KEY CHECK (id = 1), ts TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS board_history (ts TEXT PRIMARY KEY, received_at TEXT NOT NULL, body TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS board_hist15 (bucket TEXT PRIMARY KEY, ts TEXT NOT NULL, received_at TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS board_sym_latest (sym TEXT PRIMARY KEY, ts TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS board_qqq_hist15 (bucket TEXT PRIMARY KEY, ts TEXT NOT NULL, received_at TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS board_shadow_hist15 (bucket TEXT PRIMARY KEY, ts TEXT NOT NULL, received_at TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL)"),
  ]);
}
let boardReady = false;
async function boardInit(env) { if (!boardReady) { await boardEnsure(env); boardReady = true; } }
function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const n = Math.max(a.length, b.length);
  let r = a.length ^ b.length;
  for (let i = 0; i < n; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}
const PRIV_HEADERS = {
  "Cache-Control": "no-store, private",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
function privResp(body, status, type, extra) {
  return new Response(body, { status, headers: { "Content-Type": type, ...PRIV_HEADERS, ...(extra || {}) } });
}
function boardAuthOk(request, env) {
  const pw = env.BOARD_PASSWORD;
  if (!pw) return false;
  const h = request.headers.get("Authorization") || "";
  return safeEq(h, "Basic " + btoa(`${BOARD_USER}:${pw}`));
}
async function handleBoardPut(request, env, origin) {
  const key = env.BOARD_PUBLISH_KEY;
  const auth = request.headers.get("Authorization") || "";
  if (!key || !safeEq(auth, `Bearer ${key}`)) return json({ ok: false, error: "Unauthorized" }, 401, origin);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > BOARD_MAX_BYTES) return json({ ok: false, error: "Too large" }, 413, origin);
  let data; try { data = JSON.parse(text); } catch { return json({ ok: false, error: "Invalid JSON" }, 400, origin); }
  if (!data || typeof data !== "object" || Array.isArray(data)) return json({ ok: false, error: "JSON object required" }, 400, origin);
  const ts = await boardStoreLive(env, data);
  return json({ ok: true, ts, bytes: text.length }, 200, origin);
}
// Live write path shared by PUT /api/board and the GexFeed DO when FEED_MODE=live.
async function boardStoreLive(env, data) {
  const now = new Date().toISOString();
  const ts = typeof data.generated_et === "string" ? data.generated_et : now;
  const body = JSON.stringify(data);
  await boardInit(env);
  const stmts = [
    env.DB.prepare("INSERT INTO board_latest (id, ts, received_at, body) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, received_at = excluded.received_at, body = excluded.body").bind(ts, now, body),
  ];
  const prev = await env.DB.prepare("SELECT ts, body FROM board_latest WHERE id = 1").first();
  const slots = prev ? boardSlotStmts(env, prev.ts, prev.body, ts, body, now) : [];
  if (slots.length) stmts.push(...slots, boardTrim(env));
  await env.DB.batch(stmts);
  return ts;
}
GEX_H.storeLive = boardStoreLive;
// Non-SPY live boards (QQQ): D1 board_sym_latest row keyed by symbol + board_<sym>_hist15. Never touches board_latest/board_hist15.
const SYM_TABLES = { QQQ: "board_qqq_hist15" };
async function boardStoreSym(env, sym, data, body) {
  const table = SYM_TABLES[sym]; if (!table) throw new Error("unknown symbol " + sym);
  const now = new Date().toISOString(), ts = typeof data.generated_et === "string" ? data.generated_et : now;
  await boardInit(env);
  const prev = await env.DB.prepare("SELECT ts, body FROM board_sym_latest WHERE sym = ?").bind(sym).first();
  const stmts = [env.DB.prepare("INSERT INTO board_sym_latest (sym, ts, received_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(sym) DO UPDATE SET ts = excluded.ts, received_at = excluded.received_at, body = excluded.body").bind(sym, ts, now, body)];
  const slots = prev ? boardSlotStmts(env, prev.ts, prev.body, ts, body, now, table) : [];
  if (slots.length) stmts.push(...slots, boardTrim(env, table));
  await env.DB.batch(stmts);
  return ts;
}
GEX_H.storeSym = boardStoreSym;
// SPY snapshots (written from the GexFeed DO tick). Retention: SNAP_KEEP_DAYS, purged once per trading day.
const SNAP_KEEP_DAYS = 90;
// SPY uses board_snap_min/board_snap_evt (unchanged); other symbols use board_snap_min_<sym>/board_snap_evt_<sym>.
const SNAP_SYMS = { SPY: "", QQQ: "_qqq" };
const snapInit = {};
async function snapTables(env, sym = "SPY") {
  const T = SNAP_SYMS[sym]; if (T === undefined) throw new Error("unknown snap sym");
  if (snapInit[sym]) return; await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS board_snap_min${T} (date TEXT NOT NULL, hm TEXT NOT NULL, ts TEXT NOT NULL, green INTEGER, body TEXT NOT NULL, PRIMARY KEY (date, hm))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS board_snap_evt${T} (date TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, green INTEGER, body TEXT NOT NULL, PRIMARY KEY (ts, kind))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS board_snap_evt${T}_date ON board_snap_evt${T} (date)`),
  ]); snapInit[sym] = true;
}
GEX_H.snapWrite = async (env, rows, purge, sym = "SPY") => {
  await snapTables(env, sym); const T = SNAP_SYMS[sym];
  const stmts = rows.map(([sql, ...a]) => env.DB.prepare(sql).bind(...a));
  if (purge) { const cut = new Date(Date.now() - SNAP_KEEP_DAYS * 864e5).toISOString().slice(0, 10);
    stmts.push(env.DB.prepare(`DELETE FROM board_snap_min${T} WHERE date < ? AND date NOT LIKE 'test-%'`).bind(cut), env.DB.prepare(`DELETE FROM board_snap_evt${T} WHERE date < ? AND date NOT LIKE 'test-%'`).bind(cut)); }
  if (stmts.length) await env.DB.batch(stmts);
};
async function snapRead(env, url, rest) {
  const q = k => url.searchParams.get(k), J = (o, s = 200) => privResp(JSON.stringify(o), s, "application/json; charset=utf-8");
  const sym = (q("sym") || "SPY").toUpperCase(), T = SNAP_SYMS[sym];
  if (T === undefined) return J({ ok: false, error: "sym must be one of " + Object.keys(SNAP_SYMS).join(",") }, 400);
  await snapTables(env, sym);
  const date = q("date"), okD = d => /^(test-)?\d{4}-\d{2}-\d{2}$/.test(d || "");
  if (rest === "/snaps" || rest === "/snaps/dates") {
    const { results } = await env.DB.prepare(`SELECT date, COUNT(*) n, MIN(hm) first, MAX(hm) last FROM board_snap_min${T} GROUP BY date ORDER BY date DESC`).all();
    const ev = (await env.DB.prepare(`SELECT date, COUNT(*) n FROM board_snap_evt${T} GROUP BY date`).all()).results;
    const em = Object.fromEntries(ev.map(r => [r.date, r.n]));
    return J({ ok: true, sym, dates: results.map(r => ({ ...r, events: em[r.date] || 0 })), extra_event_dates: ev.filter(r => !results.some(x => x.date === r.date)) });
  }
  if (rest === "/snaps/min") {
    if (!okD(date)) return J({ ok: false, error: "date=YYYY-MM-DD required" }, 400);
    const t = q("t");
    if (!t) { const { results } = await env.DB.prepare(`SELECT hm, ts, green FROM board_snap_min${T} WHERE date = ? ORDER BY hm`).bind(date).all(); return J({ ok: true, sym, date, minutes: results }); }
    if (!/^\d{2}:\d{2}$/.test(t)) return J({ ok: false, error: "t=HH:MM" }, 400);
    const r = await env.DB.prepare(`SELECT body FROM board_snap_min${T} WHERE date = ? AND hm = ?`).bind(date, t).first();
    return r ? privResp(r.body, 200, "application/json; charset=utf-8") : J({ ok: false, error: "no snapshot" }, 404);
  }
  if (rest === "/snaps/events") {
    const ts = q("ts");
    if (ts) { const r = await env.DB.prepare(`SELECT body FROM board_snap_evt${T} WHERE ts = ? AND kind LIKE ? ORDER BY kind LIMIT 1`).bind(ts, (q("kind") || "").replace(/[%_]/g, "") + "%").first();
      return r ? privResp(r.body, 200, "application/json; charset=utf-8") : J({ ok: false, error: "no event" }, 404); }
    const kp = (q("kind") || "").replace(/[%_]/g, "") + "%", full = q("body") === "1" ? ", body" : "";
    const { results } = okD(date) ? await env.DB.prepare(`SELECT date, ts, kind, green${full} FROM board_snap_evt${T} WHERE date = ? AND kind LIKE ? ORDER BY ts LIMIT 2000`).bind(date, kp).all()
      : await env.DB.prepare(`SELECT date, ts, kind, green${full} FROM board_snap_evt${T} WHERE kind LIKE ? ORDER BY ts DESC LIMIT 200`).bind(kp).all();
    return J({ ok: true, sym, events: results });
  }
  return null;
}
GEX_H.slotStmts = (env, table, prevTs, prevBody, newTs, newBody, now) => boardSlotStmts(env, prevTs, prevBody, newTs, newBody, now, table);
GEX_H.shadowBatch = async (env, slots) => { await boardInit(env); await env.DB.batch([...slots, boardTrim(env, "board_shadow_hist15")]); };

/* ---- short edge/isolate cache for board reads (auth is checked BEFORE any cache lookup) ---- */
const MICRO = new Map();
async function cachedRead(ctx, key, ttlS, produce) {
  const hit = MICRO.get(key), t = Date.now();
  if (hit && hit.exp > t) return hit;
  const ck = new Request("https://board-cache.invalid" + key);
  let cache = null; try { cache = caches.default; } catch {}
  if (cache) {
    try {
      const r = await cache.match(ck);
      if (r) { const v = { status: r.status, type: r.headers.get("Content-Type"), body: await r.text(), exp: t + ttlS * 1000 }; MICRO.set(key, v); return v; }
    } catch {}
  }
  const v = await produce(); v.exp = t + ttlS * 1000;
  if (v.status === 200) {
    if (MICRO.size > 200) MICRO.clear();
    MICRO.set(key, v);
    if (cache) { const p = cache.put(ck, new Response(v.body, { headers: { "Content-Type": v.type, "Cache-Control": `public, max-age=${ttlS}` } })).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(p); }
  }
  return v;
}
const BOARD_TTL_S = 3;   // viewers poll every 4 s; the feed writes every 5 s
function gexStub(env) { return env.GEX_FEED.get(env.GEX_FEED.idFromName("spy")); }   // SPY keeps its original instance name/state
const SYM_FEEDS = new Set(["QQQ"]);
function symStub(env, sym) {   // one DO instance per extra symbol; the header tells a fresh instance which symbol it is
  const st = env.GEX_FEED.get(env.GEX_FEED.idFromName(sym));
  return { fetch: (u, init = {}) => st.fetch(u, { ...init, headers: { ...(init.headers || {}), "x-gex-sym": sym } }) };
}
function reqSym(url) { const s = String(url.searchParams.get("sym") || "").toUpperCase(); return SYM_FEEDS.has(s) ? s : null; }
// Bearer API for extra symbols: GET /api/board/sym/QQQ[/status|/history15], POST /api/board/sym/QQQ/run[?store=1] | /ensure
async function handleSymApi(request, env, ctx, path) {
  if (!bearerOk(request, env)) return privResp(JSON.stringify({ ok: false, error: "Unauthorized" }), 401, "application/json");
  const m = /^\/api\/board\/sym\/([A-Za-z]+)(\/[a-z0-9]+)?$/.exec(path), sym = m && m[1].toUpperCase(), sub = (m && m[2]) || "";
  if (!m || !SYM_FEEDS.has(sym)) return privResp(JSON.stringify({ ok: false, error: "Not found" }), 404, "application/json");
  const stub = symStub(env, sym), url = new URL(request.url);
  if (request.method === "GET" && sub === "") { const r = await stub.fetch("https://gex/latest"); return privResp(await r.text(), r.status, "application/json"); }
  if (request.method === "GET" && sub === "/status") { const r = await stub.fetch("https://gex/status"); return privResp(await r.text(), r.status, "application/json"); }
  if (request.method === "POST" && sub === "/run") { const r = await stub.fetch("https://gex/run?store=" + (url.searchParams.get("store") === "1" ? "1" : "0")); MICRO.clear(); return privResp(await r.text(), r.status, "application/json"); }
  if (request.method === "POST" && sub === "/ensure") { const r = await stub.fetch("https://gex/ensure"); return privResp(await r.text(), r.status, "application/json"); }
  if (request.method === "GET" && sub === "/history15") {
    await boardInit(env);
    const { results } = await env.DB.prepare(`SELECT bucket, ts, summary FROM ${SYM_TABLES[sym]} ORDER BY bucket DESC LIMIT 50`).all();
    return privResp(JSON.stringify({ rows: results.map(r => ({ bucket: r.bucket, ts: r.ts, ...JSON.parse(r.summary) })) }), 200, "application/json");
  }
  return privResp(JSON.stringify({ ok: false, error: "Not found" }), 404, "application/json");
}
// Private page reads for ?sym=QQQ (same response shapes as the SPY routes).
async function symBoardRead(env, url, rest, ctx, sym) {
  const table = SYM_TABLES[sym]; await boardInit(env);
  if (rest === "/latest") {
    const ts = url.searchParams.get("ts");
    const v = await cachedRead(ctx, `/b/${sym}/latest?ts=` + encodeURIComponent(ts || ""), ts ? 60 : BOARD_TTL_S, async () => {
      const row = ts ? await env.DB.prepare(`SELECT body FROM ${table} WHERE ts = ?`).bind(ts).first() : await env.DB.prepare("SELECT body FROM board_sym_latest WHERE sym = ?").bind(sym).first();
      return row ? { status: 200, type: "application/json; charset=utf-8", body: row.body } : { status: 404, type: "application/json", body: JSON.stringify({ ok: false, error: `No ${sym} data yet` }) };
    });
    return privResp(v.body, v.status, v.type);
  }
  if (rest === "/history") {
    const v = await cachedRead(ctx, `/b/${sym}/history`, 10, async () => {
      const { results } = await env.DB.prepare(`SELECT bucket, ts FROM ${table} WHERE length(bucket) = 16 ORDER BY bucket DESC LIMIT ?`).bind(BOARD_KEEP).all();
      return { status: 200, type: "application/json; charset=utf-8", body: JSON.stringify({ runs: results.map(r => r.ts), slots: results.map(r => r.bucket) }) };
    });
    return privResp(v.body, v.status, v.type);
  }
  if (rest === "/history15") {
    const L = await env.DB.prepare("SELECT ts, body FROM board_sym_latest WHERE sym = ?").bind(sym).first();
    if (L) { const fill = boardSlotStmts(env, L.ts, L.body, new Date().toISOString(), null, new Date().toISOString(), table); if (fill.length) await env.DB.batch([...fill, boardTrim(env, table)]); }
    const lim = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
    const before = url.searchParams.get("before");
    const q = before
      ? env.DB.prepare(`SELECT bucket, ts, summary FROM ${table} WHERE length(bucket) = 16 AND bucket < ? ORDER BY bucket DESC LIMIT ?`).bind(before, lim + 1)
      : env.DB.prepare(`SELECT bucket, ts, summary FROM ${table} WHERE length(bucket) = 16 ORDER BY bucket DESC LIMIT ?`).bind(lim + 1);
    const { results } = await q.all();
    const more = results.length > lim, rows = results.slice(0, lim).map(r => ({ bucket: r.bucket, ts: r.ts, ...JSON.parse(r.summary) }));
    return privResp(JSON.stringify({ rows, next: more ? rows[rows.length - 1].bucket : null }), 200, "application/json; charset=utf-8");
  }
  return privResp("Not found", 404, "text/plain");
}
async function shadowLatest(env, ctx, slug) {
  const v = await cachedRead(ctx, `/${slug}/shadow/latest`, BOARD_TTL_S, async () => {
    const r = await gexStub(env).fetch("https://gex/latest");
    return { status: r.status, type: "application/json; charset=utf-8", body: await r.text() };
  });
  return privResp(v.body, v.status, v.type);
}
function bearerOk(request, env) {
  const key = env.BOARD_PUBLISH_KEY, auth = request.headers.get("Authorization") || "";
  return Boolean(key) && safeEq(auth, `Bearer ${key}`);
}
async function handleShadowApi(request, env, ctx, path) {
  if (!bearerOk(request, env)) return privResp(JSON.stringify({ ok: false, error: "Unauthorized" }), 401, "application/json");
  const stub = gexStub(env), url = new URL(request.url);
  if (request.method === "GET" && path === "/api/board/shadow") return shadowLatest(env, ctx, "api");
  if (request.method === "GET" && path === "/api/board/shadow/status") { const r = await stub.fetch("https://gex/status"); return privResp(await r.text(), r.status, "application/json"); }
  if (request.method === "POST" && path === "/api/board/shadow/run") { const r = await stub.fetch("https://gex/run" + url.search); MICRO.clear(); return privResp(await r.text(), r.status, "application/json"); }
  if (request.method === "POST" && path === "/api/board/shadow/snaptest") { const r = await stub.fetch("https://gex/snaptest"); return privResp(await r.text(), r.status, "application/json"); }
  if (request.method === "DELETE" && path === "/api/board/shadow/snaptest") { await snapTables(env); await env.DB.batch([env.DB.prepare("DELETE FROM board_snap_min WHERE date LIKE 'test-%'"), env.DB.prepare("DELETE FROM board_snap_evt WHERE date LIKE 'test-%'")]); return privResp('{"ok":true}', 200, "application/json"); }
  if (request.method === "POST" && path === "/api/board/shadow/ensure") { const r = await stub.fetch("https://gex/ensure"); return privResp(await r.text(), r.status, "application/json"); }
  if (request.method === "GET" && path === "/api/board/shadow/history15") {
    await boardInit(env);
    const { results } = await env.DB.prepare("SELECT bucket, ts, summary FROM board_shadow_hist15 ORDER BY bucket DESC LIMIT 50").all();
    return privResp(JSON.stringify({ rows: results.map(r => ({ bucket: r.bucket, ts: r.ts, ...JSON.parse(r.summary) })) }), 200, "application/json");
  }
  return privResp(JSON.stringify({ ok: false, error: "Not found" }), 404, "application/json");
}
async function handlePrivateBoard(request, env, url, rest, ctx) {
  if (!boardAuthOk(request, env)) {
    return privResp("Unauthorized", 401, "text/plain; charset=utf-8", { "WWW-Authenticate": 'Basic realm="board", charset="UTF-8"' });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return privResp("Method not allowed", 405, "text/plain");
  if (rest === "") return privResp(null, 301, "text/plain", { Location: url.pathname + "/" });
  if (rest === "/") return privResp(BOARD_HTML, 200, "text/html; charset=utf-8");
  if (rest === "/shadow" || rest === "/shadow/latest") return shadowLatest(env, ctx, "b");
  const xs = reqSym(url);
  if (xs && (rest === "/latest" || rest === "/history" || rest === "/history15")) return symBoardRead(env, url, rest, ctx, xs);
  if (rest.startsWith("/snaps")) { const r = await snapRead(env, url, rest); if (r) return r; }
  await boardInit(env);
  if (rest === "/latest") {
    const ts = url.searchParams.get("ts");
    const v = await cachedRead(ctx, "/b/latest?ts=" + encodeURIComponent(ts || ""), ts ? 60 : BOARD_TTL_S, async () => {
      const row = ts
        ? (await env.DB.prepare("SELECT body FROM board_hist15 WHERE ts = ?").bind(ts).first()) || (await env.DB.prepare("SELECT body FROM board_history WHERE ts = ?").bind(ts).first())
        : await env.DB.prepare("SELECT body FROM board_latest WHERE id = 1").first();
      return row ? { status: 200, type: "application/json; charset=utf-8", body: row.body } : { status: 404, type: "application/json", body: JSON.stringify({ ok: false, error: "No board yet" }) };
    });
    return privResp(v.body, v.status, v.type);
  }
  if (rest === "/history") {
    const v = await cachedRead(ctx, "/b/history", 10, async () => {
      const { results } = await env.DB.prepare("SELECT bucket, ts FROM board_hist15 WHERE length(bucket) = 16 ORDER BY bucket DESC LIMIT ?").bind(BOARD_KEEP).all();
      return { status: 200, type: "application/json; charset=utf-8", body: JSON.stringify({ runs: results.map(r => r.ts), slots: results.map(r => r.bucket) }) };
    });
    return privResp(v.body, v.status, v.type);
  }
  if (rest === "/history15") {
    // Fill slots that passed since the last push (pushes may have stopped).
    const L = await env.DB.prepare("SELECT ts, body FROM board_latest WHERE id = 1").first();
    if (L) {
      const fill = boardSlotStmts(env, L.ts, L.body, new Date().toISOString(), null, new Date().toISOString());
      if (fill.length) await env.DB.batch([...fill, boardTrim(env)]);
    }
    const lim = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
    const before = url.searchParams.get("before");
    const q = before
      ? env.DB.prepare("SELECT bucket, ts, summary FROM board_hist15 WHERE length(bucket) = 16 AND bucket < ? ORDER BY bucket DESC LIMIT ?").bind(before, lim + 1)
      : env.DB.prepare("SELECT bucket, ts, summary FROM board_hist15 WHERE length(bucket) = 16 ORDER BY bucket DESC LIMIT ?").bind(lim + 1);
    const { results } = await q.all();
    const more = results.length > lim, rows = results.slice(0, lim).map(r => ({ bucket: r.bucket, ts: r.ts, ...JSON.parse(r.summary) }));
    return privResp(JSON.stringify({ rows, next: more ? rows[rows.length - 1].bucket : null }), 200, "application/json; charset=utf-8");
  }
  return privResp("Not found", 404, "text/plain");
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === "GET" && (path === "/api/health" || path === "/health")) {
      return json({ ok: true }, 200, origin);
    }

    if (request.method === "POST" && path === "/api/subscribe") {
      return handleSubscribe(request, env, origin);
    }

    if (request.method === "POST" && path === "/api/deliver") {
      return handleDeliver(request, env, origin, ctx);
    }

    if (path.startsWith("/api/board/shadow")) {
      return handleShadowApi(request, env, ctx, path);
    }

    if (path.startsWith("/api/board/sym/")) {
      return handleSymApi(request, env, ctx, path);
    }

    if (request.method === "PUT" && path === "/api/board") {
      return handleBoardPut(request, env, origin);
    }

    const slug = env.BOARD_SLUG;
    if (slug && slug.length >= 16) {
      const pre = `/b/${slug}`;
      if (url.pathname === pre || url.pathname.startsWith(pre + "/")) {
        return handlePrivateBoard(request, env, url, url.pathname.slice(pre.length), ctx);
      }
    }

    return json({ ok: false, error: "Not found" }, 404, origin);
  },
  // Cron backstop: re-arm the GexFeed alarm if it is missing (DO decides session vs next start).
  async scheduled(event, env, ctx) {
    if (!env.GEX_FEED) return;
    ctx.waitUntil(gexStub(env).fetch("https://gex/stalecheck").then(r => r.text()).then(t => console.log("gexfeed stalecheck", t)).catch(e => console.error("stalecheck failed", String(e))));
    ctx.waitUntil(gexStub(env).fetch("https://gex/ensure").then(r => r.text()).then(t => console.log("gexfeed ensure", t)).catch(e => console.error("gexfeed ensure failed", String(e))));
    for (const s of SYM_FEEDS) ctx.waitUntil(symStub(env, s).fetch("https://gex/ensure").then(r => r.text()).then(t => console.log("gexfeed ensure " + s, t)).catch(e => console.error("gexfeed ensure failed " + s, String(e))));
  },
};
