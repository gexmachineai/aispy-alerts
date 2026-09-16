/**
 * AISPYALERTS API — email-first subscribe + legacy webhook deliver
 *
 * Primary path: POST /api/subscribe (email + optional name) → D1 + Resend
 *   "Founding Free" segment (BCC fan-out via Alert Spreader / Resend).
 * Legacy: POST /api/deliver still fans out to rows with a usable webhook;
 *   email-only rows (empty webhook_url / empty key) are skipped.
 *
 * Secrets: ENCRYPTION_KEY (base64 32 bytes; only needed for legacy webhook keys),
 *          DELIVER_TOKEN, RESEND_API_KEY (for contact + segment enroll on subscribe)
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
  // Legacy optional fields — ignored for email-first; stored empty when absent
  const webhookUrlRaw = body.webhookUrl != null ? String(body.webhookUrl).trim() : "";
  const senderKeyRaw = body.senderKey != null ? String(body.senderKey) : "";

  if (!email || !isValidEmail(email)) {
    return json({ ok: false, error: "Valid email is required" }, 400, origin);
  }

  let webhookUrl = "";
  let encrypted = "";

  // Optional legacy webhook path: if both provided and valid, persist them
  if (webhookUrlRaw || senderKeyRaw) {
    if (!webhookUrlRaw || !isHttpsUrl(webhookUrlRaw)) {
      return json({ ok: false, error: "webhookUrl must be a valid https URL" }, 400, origin);
    }
    if (!senderKeyRaw || senderKeyRaw.length < 8) {
      return json({ ok: false, error: "senderKey must be at least 8 characters" }, 400, origin);
    }
    webhookUrl = webhookUrlRaw;
    try {
      encrypted = await encryptSecret(senderKeyRaw, env);
    } catch (err) {
      console.error("encrypt failed", err);
      return json({ ok: false, error: "Server encryption not configured" }, 500, origin);
    }
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

  const resend = await enrollResendFoundingFree(email, name, env);

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

async function deliverOne(sub, alertBody, env) {
  let senderKey;
  try {
    senderKey = await decryptSecret(sub.sender_key_encrypted, env);
  } catch (err) {
    return { email: sub.email, status: 0, error: "decrypt_failed" };
  }

  const payload = typeof alertBody === "string" ? alertBody : JSON.stringify(alertBody);
  const opts = {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${senderKey}`,
    },
    body: payload,
  };

  async function attempt() {
    try {
      const res = await postWithTimeout(sub.webhook_url, opts, 8000);
      return { status: res.status, ok: res.ok, error: res.ok ? null : `http_${res.status}` };
    } catch (err) {
      const msg = err && err.name === "AbortError" ? "timeout" : "network_error";
      return { status: 0, ok: false, error: msg };
    }
  }

  let result = await attempt();
  // Retry once on 5xx or network/timeout
  if (!result.ok && (result.status >= 500 || result.status === 0)) {
    result = await attempt();
  }

  if (!result.ok) {
    console.error("deliver failed", { email: sub.email, status: result.status, error: result.error });
    return { email: sub.email, status: result.status, error: result.error };
  }
  return null;
}

async function handleDeliver(request, env, origin) {
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

  // Skip email-only rows (no usable webhook) so they don't spam decrypt/network errors
  const webhookRows = rows.filter(hasUsableWebhook);
  const skipped = rows.length - webhookRows.length;

  const failed = [];
  let delivered = 0;

  const outcomes = await Promise.all(webhookRows.map((sub) => deliverOne(sub, alertBody, env)));
  for (const fail of outcomes) {
    if (fail) failed.push(fail);
    else delivered += 1;
  }

  return json(
    {
      ok: true,
      delivered,
      failed,
      skipped,
      total: rows.length,
      webhookTargets: webhookRows.length,
    },
    200,
    origin
  );
}

export default {
  async fetch(request, env) {
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
      return handleDeliver(request, env, origin);
    }

    return json({ ok: false, error: "Not found" }, 404, origin);
  },
};
