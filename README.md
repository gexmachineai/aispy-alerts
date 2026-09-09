# AISPYALERTS

One-page landing site for AI-agent-ready trading alerts, plus a Cloudflare Worker API for webhook subscriptions.

Static site: index.html, styles.css, assets/ (GitHub Pages).
API: worker/ (Cloudflare Workers + D1).

## Local preview

Run: python3 -m http.server 8080
Then open http://localhost:8080

## Subscribe form

The landing form collects:

- Name (optional)
- Email
- Webhook URL (must be https://)
- Sender key (password field, min 8 chars; stored encrypted server-side, never shown again)

On submit it POSTs JSON to API_BASE + /api/subscribe.
Set const API_BASE in index.html after deploying the Worker
(example: https://aispyalerts-api.<account>.workers.dev).
If API_BASE is empty, the form still validates client-side and shows a backend-not-configured message.

The X follow CTA for free alerts is kept.

## Worker API (worker/)

Full steps are in worker/README.md:

1. wrangler login
2. Create D1 DB and set database_id in wrangler.toml
3. Run remote schema migrate
4. Set Worker secrets ENCRYPTION_KEY and DELIVER_TOKEN
5. Deploy the Worker
6. Paste the workers.dev URL into API_BASE in index.html

Endpoints: GET /api/health, POST /api/subscribe, POST /api/deliver (Bearer DELIVER_TOKEN).

## Security

- Sender keys are AES-GCM encrypted at rest; never returned by the API.
- ENCRYPTION_KEY and DELIVER_TOKEN are Worker secrets.
- Never commit secrets to Pages or this repo.
- No keys or tokens belong in the static GitHub Pages site.

## Brand

Logo: assets/logo.jpeg
Theme: dark background, neon green accents.
