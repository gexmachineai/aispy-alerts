# AISPYALERTS

One-page landing site for AI-agent-ready trading alerts, plus a Cloudflare Worker API for email (BCC) subscriptions.

Static site: index.html, styles.css, assets/ (GitHub Pages).
API: worker/ (Cloudflare Workers + D1 + Resend).

## Local preview

Run: python3 -m http.server 8080
Then open http://localhost:8080

## Subscribe form (email-first)

The landing form collects:

- Name (optional)
- Email (required)

On submit it POSTs JSON `{ name, email }` to API_BASE + /api/subscribe.
The Worker upserts D1 and, when `RESEND_API_KEY` is set, creates/upserts the
contact in Resend and adds them to the **Founding Free** segment used by
Alert Spreader BCC fan-out.

Webhook URL / sender key fields were removed from the site. The Worker still
accepts those fields optionally for legacy use; `/api/deliver` webhook fan-out
is **deprecated** (email-only rows are skipped).

Set const API_BASE in index.html after deploying the Worker
(example: https://aispyalerts-api.<account>.workers.dev).

The X follow CTA for free alerts is kept.

## Worker API (worker/)

Full steps are in worker/README.md:

1. wrangler login
2. Create D1 DB and set database_id in wrangler.toml
3. Run remote schema migrate
4. Set Worker secrets: `RESEND_API_KEY` (required for BCC enroll),
   `DELIVER_TOKEN` (legacy deliver), `ENCRYPTION_KEY` (legacy webhook keys only)
5. Deploy the Worker
6. Paste the workers.dev URL into API_BASE in index.html

Endpoints: GET /api/health, POST /api/subscribe, POST /api/deliver (legacy Bearer DELIVER_TOKEN).

## Security

- Never commit secrets to Pages or this repo.
- No keys or tokens belong in the static GitHub Pages site.
- Legacy sender keys (if ever posted) are AES-GCM encrypted at rest.

## Brand

Logo: assets/logo.jpeg
Theme: dark background, neon green accents.
