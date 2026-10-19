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

/* ---- Public GEX board (additive) ---- */
const BOARD_MAX_BYTES = 1000000;
const BOARD_KEEP = 200;
async function boardEnsure(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS board_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL)").run();
}
function boardResp(body, status, origin, maxAge) {
  return new Response(body, { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    ...corsHeaders(origin) } });
}
function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function handleBoardPut(request, env, origin) {
  const key = env.BOARD_PUBLISH_KEY;
  const auth = request.headers.get("Authorization") || "";
  if (!key || !safeEq(auth, `Bearer ${key}`)) return json({ ok: false, error: "Unauthorized" }, 401, origin);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > BOARD_MAX_BYTES) return json({ ok: false, error: "Too large" }, 413, origin);
  let data; try { data = JSON.parse(text); } catch { return json({ ok: false, error: "Invalid JSON" }, 400, origin); }
  if (!data || typeof data !== "object" || Array.isArray(data)) return json({ ok: false, error: "JSON object required" }, 400, origin);
  const now = new Date().toISOString();
  const ts = typeof data.generated_et === "string" ? data.generated_et : now;
  await boardEnsure(env);
  await env.DB.prepare("INSERT INTO board_snapshots (ts, received_at, body) VALUES (?, ?, ?)").bind(ts, now, JSON.stringify(data)).run();
  await env.DB.prepare("DELETE FROM board_snapshots WHERE id NOT IN (SELECT id FROM board_snapshots ORDER BY id DESC LIMIT ?)").bind(BOARD_KEEP).run();
  return json({ ok: true, ts, bytes: text.length }, 200, origin);
}
async function handleBoardLatest(url, env, origin) {
  await boardEnsure(env);
  const ts = url.searchParams.get("ts");
  const row = ts
    ? await env.DB.prepare("SELECT body FROM board_snapshots WHERE ts = ? ORDER BY id DESC LIMIT 1").bind(ts).first()
    : await env.DB.prepare("SELECT body FROM board_snapshots ORDER BY id DESC LIMIT 1").first();
  if (!row) return json({ ok: false, error: "No board yet" }, 404, origin);
  return boardResp(row.body, 200, origin, ts ? 300 : 15);
}
async function handleBoardHistory(env, origin) {
  await boardEnsure(env);
  const { results } = await env.DB.prepare("SELECT DISTINCT ts FROM board_snapshots ORDER BY ts DESC LIMIT ?").bind(BOARD_KEEP).all();
  return boardResp(JSON.stringify({ runs: results.map(r => r.ts) }), 200, origin, 15);
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

    if (request.method === "PUT" && path === "/api/board") {
      return handleBoardPut(request, env, origin);
    }

    if (request.method === "GET" && path === "/api/board/latest") {
      return handleBoardLatest(url, env, origin);
    }

    if (request.method === "GET" && path === "/api/board/history") {
      return handleBoardHistory(env, origin);
    }

    return json({ ok: false, error: "Not found" }, 404, origin);
  },
};
