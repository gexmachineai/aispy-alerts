#!/usr/bin/env node
/**
 * CLI: POST alert JSON to Worker /api/deliver
 * Env: API_BASE, DELIVER_TOKEN
 * Argv JSON or stdin JSON
 */

import { readFileSync } from "node:fs";

const apiBase = (process.env.API_BASE || "").replace(/\/+$/, "");
const token = process.env.DELIVER_TOKEN || "";

if (!apiBase) {
  console.error("API_BASE is required");
  process.exit(1);
}
if (!token) {
  console.error("DELIVER_TOKEN is required");
  process.exit(1);
}

async function readPayload() {
  const arg = process.argv.slice(2).join(" ").trim();
  if (arg) {
    if (arg.startsWith("@")) return readFileSync(arg.slice(1), "utf8");
    return arg;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    console.error("Provide JSON as argv or stdin");
    process.exit(1);
  }
  return text;
}

const raw = await readPayload();
let parsed;
try { parsed = JSON.parse(raw); } catch {
  console.error("Payload must be valid JSON");
  process.exit(1);
}

const res = await fetch(apiBase + "/api/deliver", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + token,
  },
  body: JSON.stringify(parsed),
});

const text = await res.text();
let data;
try { data = JSON.parse(text); } catch {
  console.error("HTTP " + res.status + ": " + text);
  process.exit(1);
}

if (!res.ok) {
  console.error("HTTP " + res.status + ":", data);
  process.exit(1);
}

console.log("Delivered: " + data.delivered + "/" + data.total);
if (data.failed && data.failed.length) {
  console.log("Failed:");
  for (const f of data.failed) {
    console.log("  - " + f.email + ": status=" + f.status + " error=" + f.error);
  }
  process.exitCode = 1;
} else {
  console.log("All deliveries succeeded.");
}
