# AISPYALERTS API (Cloudflare Worker)

D1-backed subscribe + webhook fan-out for AISPYALERTS.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | — | `{ ok: true }` |
| `POST` | `/api/subscribe` | CORS origins | Upsert subscriber (`name?`, `email`, `webhookUrl`, `senderKey`) |
| `POST` | `/api/deliver` | `Bearer DELIVER_TOKEN` | Fan-out alert JSON to all active webhooks |
| `OPTIONS` | `*` | — | CORS preflight |

Sender keys are AES-GCM encrypted at rest (`ENCRYPTION_KEY`). They are never returned in API responses.

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

# Secrets (generate a 32-byte key for ENCRYPTION_KEY)
#   openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put DELIVER_TOKEN

npm run deploy
```

After deploy, copy the `*.workers.dev` URL into the landing page:

```js
const API_BASE = "https://aispyalerts-api.<account>.workers.dev";
```

in `/index.html`.

## Send an alert (CLI)

```bash
export API_BASE="https://aispyalerts-api.<account>.workers.dev"
export DELIVER_TOKEN="your-deliver-token"
npm run send-alert -- '{"symbol":"SPY","side":"buy","note":"example"}'
```

## Local dev

```bash
npm run db:migrate:local
# Set secrets via .dev.vars (ENCRYPTION_KEY, DELIVER_TOKEN) — never commit that file
npm run dev
```
