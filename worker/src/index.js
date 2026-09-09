/**
 * AISPYALERTS API — subscribe + deliver fan-out
 * Secrets: ENCRYPTION_KEY (base64 32 bytes), DELIVER_TOKEN
 * Binding: DB (D1)
 */

const ALLOWED_ORIGINS = new Set([
  "https://aispyalerts.com",
  "https://www.aispyalerts.com",
  "https://gexmachineai.github.io",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
]);

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

  // Never return sender key
  return json({ ok: true }, 200, origin);
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

  const failed = [];
  let delivered = 0;

  // Fan-out; one failure must not stop others
  const outcomes = await Promise.all(rows.map((sub) => deliverOne(sub, alertBody, env)));
  for (const fail of outcomes) {
    if (fail) failed.push(fail);
    else delivered += 1;
  }

  return json(
    {
      ok: true,
      delivered,
      failed,
      total: rows.length,
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
