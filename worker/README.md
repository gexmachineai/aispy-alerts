# AISPYALERTS API (Cloudflare Worker)

D1-backed **email-first** subscribe + Resend Founding Free segment enroll.
Legacy webhook fan-out (`/api/deliver`) remains but skips email-only rows.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | — | `{ ok: true }` |
| `POST` | `/api/subscribe` | CORS origins | Upsert subscriber (`name?`, `email`). Enrolls Resend **Founding Free** when `RESEND_API_KEY` is set. Optional legacy `webhookUrl` + `senderKey` still accepted. |
| `POST` | `/api/deliver` | `Bearer DELIVER_TOKEN` | **Deprecated.** Fan-out alert JSON to active rows with a usable webhook; empty webhook/key rows are skipped. |
| `OPTIONS` | `*` | — | CORS preflight |

Primary delivery is Resend BCC (Alert Spreader → Founding Free segment), not site webhooks.

## Deploy

```bash
cd worker
npm install
npx wrangler login

# Create D1 database and paste the id into wrangler.toml
npm run db:create
# Edit wrangler.toml: database_id = "<id from create output>"

# Apply schema
npm run db:migrate:remote
# Optional local: npm run db:migrate:local

# Secrets
npx wrangler secret put RESEND_API_KEY   # required for email BCC enroll
npx wrangler secret put DELIVER_TOKEN    # legacy /api/deliver
npx wrangler secret put ENCRYPTION_KEY   # legacy webhook sender keys only (openssl rand -base64 32)

npm run deploy
```

After deploy, copy the `*.workers.dev` URL into the landing page:

```js
const API_BASE = "https://aispyalerts-api.<account>.workers.dev";
```

in `/index.html`.

## Send an alert (CLI) — legacy webhook path

```bash
export API_BASE="https://aispyalerts-api.<account>.workers.dev"
export DELIVER_TOKEN="your-deliver-token"
npm run send-alert -- '{"symbol":"SPY","side":"buy","note":"example"}'
```

Prefer Alert Spreader → Resend BCC for SIGNAL email fan-out.

## Local dev

```bash
npm run db:migrate:local
# Set secrets via .dev.vars (RESEND_API_KEY, DELIVER_TOKEN, ENCRYPTION_KEY) — never commit that file
npm run dev
```
