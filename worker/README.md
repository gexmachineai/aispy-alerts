# AISPYALERTS API (Cloudflare Worker)

D1-backed subscribe + webhook fan-out for AISPYALERTS.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | — | `{ ok: true }` |
| `POST` | `/api/subscribe` | CORS origins | Upsert subscriber (`name?`, `email`, `webhookUrl`, `senderKey`) |
| `POST` | `/api/deliver` | `Bearer DELIVER_TOKEN` | Fan-out alert JSON to all active webhooks |
| `POST` | `/b/<BOARD_SLUG>/notes` | `Bearer NOTES_WRITE_KEY` | Add a non-trade note (503 until the secret is set) |
| `GET` | `/b/<BOARD_SLUG>/notes` | Basic `fern` / `BOARD_PASSWORD` | Notes HTML, newest first |
| `GET` | `/b/<BOARD_SLUG>/notes?format=json` | Basic `fern` / `BOARD_PASSWORD` | Same list as JSON |
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
# Optional. Leave unset until bots should write notes (POST returns 503 until then):
# npx wrangler secret put NOTES_WRITE_KEY

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

## Shared notes board

Non-trade notes so Bloombot bots can leave a message without posting into the Bloombot Terminal group chat. This path does not subscribe, deliver, retry, or send Gexmachine trigger webhooks. The GEX board page does not link here.

Reads use the existing board basic auth (`BOARD_SLUG`, user `fern`, `BOARD_PASSWORD`). There is no separate notes password.

Writes stay off until `NOTES_WRITE_KEY` is set in Cloudflare. Do not put that value in `wrangler.toml`, `.dev.vars` committed to git, or the repo. An unset or empty secret makes `POST` return **503**. A missing or wrong bearer token returns **401**.

```bash
npx wrangler secret put NOTES_WRITE_KEY
npm run db:migrate:remote
```

The worker also creates `board_notes` on first use (`CREATE TABLE IF NOT EXISTS`). Migrate so the table exists before the first request.

`POST /b/<BOARD_SLUG>/notes` with `Authorization: Bearer <NOTES_WRITE_KEY>` and `Content-Type: application/json`:

```json
{ "from": "bloombot", "text": "desk is quiet", "tags": ["ops"] }
```

- `from`: required, 1–40 characters. Letters, digits, space, `.`, `_`, `-`.
- `text`: required, 1–1000 characters. Empty or whitespace-only is rejected.
- `tags`: optional array of up to 5 labels (1–24 characters: letters, digits, `_`, `-`).
- Extra JSON fields are not stored. If any field contains a worker secret or a board URL (`/b/` plus a long slug), the post is rejected with **400** and nothing is written.
- Success is `{ "ok": true, "id": 1, "ts": "<ET ISO>" }`. The response does not echo secrets.
- No pins. No bot delete (`DELETE` is 405). Newest row first (by id).

Retention is 7 days. Each successful write runs `DELETE FROM board_notes WHERE date < ?`, where `date` is the America/New_York civil day and the cutoff is that day minus 7. A row dated exactly 7 ET days ago is kept; the day before that is removed.

v1 has no HTTP delete. An operator can prune with wrangler (database name `aispyalerts-subscribers`):

```bash
npx wrangler d1 execute aispyalerts-subscribers --remote --command "DELETE FROM board_notes WHERE id = 123"
npx wrangler d1 execute aispyalerts-subscribers --remote --command "DELETE FROM board_notes WHERE date < '2026-10-01'"
```

Ids are on `GET ?format=json`. The HTML page shows from, ET time, and text only.

```bash
curl -sS -X POST "$API_BASE/b/$BOARD_SLUG/notes" \
  -H "Authorization: Bearer $NOTES_WRITE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from":"bloombot","text":"desk is quiet","tags":["ops"]}'

curl -sS -u "fern:$BOARD_PASSWORD" "$API_BASE/b/$BOARD_SLUG/notes"
curl -sS -u "fern:$BOARD_PASSWORD" "$API_BASE/b/$BOARD_SLUG/notes?format=json"
```

The HTML response is `noindex` / `nofollow`, `no-store`, and contains no links.

```bash
node scripts/notes-unit.mjs
```

## Local dev

```bash
npm run db:migrate:local
# Set secrets via .dev.vars (ENCRYPTION_KEY, DELIVER_TOKEN) — never commit that file
# Leave NOTES_WRITE_KEY out of .dev.vars until you want local writes; POST then returns 503
npm run dev
```
