# Raxion

Raxion is a standalone autonomous recruiting operations system for recruitment agencies. It parses job briefs, sources LinkedIn candidates, scores and enriches them, drafts outreach for Telegram approval, sends through Unipile during configured sending windows, qualifies replies with Claude, and exposes a Mission Control dashboard over Express.

## Stack

- Node.js + Express
- Supabase Postgres
- Anthropic Claude via `src/integrations/claude.js` using `claude-sonnet-4-20250514`
- Unipile for LinkedIn and email operations
- Telegram Bot API
- Zoho Recruit
- Apify for enrichment

## Setup

1. Copy `.env.example` to `.env` and fill every required value.
2. Install dependencies with `npm install`.
3. Run the Supabase migrations in `supabase/migrations/` in order.
4. Start the app with `npm start`.
5. Set `SERVER_BASE_URL` to the public app URL so Unipile webhook registration points to the correct routes.

## Environment Variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `ANTHROPIC_API_KEY`
- `UNIPILE_DSN`
- `UNIPILE_API_KEY`
- `UNIPILE_LINKEDIN_ACCOUNT_ID`
- `UNIPILE_EMAIL_ACCOUNT_ID`
- `APIFY_API_KEY`
- `APIFY_ACTOR_ID`
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_ACCOUNTS_URL`
- `ZOHO_API_BASE`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `PORT`
- `SERVER_BASE_URL`
- `SENDER_NAME`
- `REPLY_TO_EMAIL`

## Runtime Overview

- `index.js` boots Express, the dashboard server, the live Unipile webhook router, the Telegram bot, the inbox monitor, schema checks, and the orchestrator cron.
- `src/services/outreachSequencer.js` runs jobs sequentially and only gates the actual send phase on the job sending window.
- `src/services/candidateSourcing.js` handles sourcing and scoring.
- `src/services/enrichmentService.js` enriches shortlisted candidates.
- `src/services/approvalService.js` validates drafts, queues approvals, and executes approved sends.
- `src/services/replyHandler.js` processes inbound LinkedIn or email replies.
- `src/webhooks/unipileWebhooks.js` is the active Unipile webhook router.
- `src/dashboard/` contains the dashboard server, client script, and styles.

## Notes

- All Claude calls are expected to flow through `src/integrations/claude.js`.
- The dashboard uses the current runtime tables from `supabase/migrations/002_raxion_extensions.sql`, plus later migrations for assets, send windows, and templates.
- The deprecated singular webhook file is intentionally removed; the active route is `src/webhooks/unipileWebhooks.js`.
