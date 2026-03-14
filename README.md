# Raxion

Raxion is a standalone autonomous AI recruiting agent for recruitment agencies. It parses briefs, sources LinkedIn candidates, runs outreach sequences across LinkedIn and email, qualifies replies with Claude, alerts recruiters in Telegram, and exposes a Mission Control dashboard over Express.

## Stack

- Node.js + Express
- Supabase Postgres
- Unipile for LinkedIn and email account operations
- Anthropic Claude (`claude-sonnet-4-20250514`) for all AI logic
- Telegram Bot API
- Linux VPS target (Ubuntu), no serverless, no React, no build step

## Setup

1. Copy `.env.example` to `.env` and fill every required value.
2. Install dependencies with `npm install`.
3. Run the migration in `supabase/migrations/001_raxion_schema.sql` against your Supabase database.
4. Start the app with `npm start`.
5. Expose your VPS on the dashboard port and point Unipile webhooks to `https://your-domain-or-ip:3001/webhooks/unipile`.

## Environment Variables

- `UNIPILE_BASE_URL`: Base URL for your Unipile API workspace.
- `UNIPILE_ACCESS_TOKEN`: Unipile API bearer token.
- `UNIPILE_WEBHOOK_SECRET`: Shared secret used to verify incoming Unipile webhook signatures.
- `UNIPILE_ACCOUNT_ID`: The connected Unipile account used for outreach.
- `ANTHROPIC_API_KEY`: Anthropic API key for all Claude calls.
- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_KEY`: Supabase service-role key used by the backend.
- `TELEGRAM_BOT_TOKEN`: Telegram bot token for recruiter alerts and commands.
- `TELEGRAM_RECRUITER_CHAT_ID`: Telegram chat ID allowed to operate Raxion.
- `ZOHO_ACCESS_TOKEN`: OAuth access token for Zoho Recruit.
- `ZOHO_RECRUIT_BASE_URL`: Zoho Recruit API base URL. Default is `https://recruit.zoho.eu/recruit/v2`.
- `DASHBOARD_BASE_URL`: Public base URL used in notifications.
- `RAXION_PORT`: Express port. Default `3001`.

## Supabase Migration

Run the SQL in `supabase/migrations/001_raxion_schema.sql` using the Supabase SQL editor or your preferred migration flow. The migration creates all Raxion tables, indexes, and default settings values.

## Unipile Webhook Registration

1. In the Unipile dashboard, open your API project or connected account settings.
2. Register the webhook endpoint as `http://YOUR_VPS_IP:3001/webhooks/unipile` or your HTTPS domain equivalent.
3. Configure the same secret value in Unipile and `UNIPILE_WEBHOOK_SECRET`.
4. Confirm events for invitation accepted, invitation declined, and new messages are enabled.

## Running on Ubuntu VPS

1. Install Node.js 20+.
2. Clone the repo to the VPS.
3. Create `.env`.
4. Install dependencies.
5. Run behind `systemd`, `pm2`, or another Linux process manager.
6. Reverse proxy the app with Nginx if you want HTTPS termination.

## LinkedIn Rate Limit Guidance

- Keep daily LinkedIn invites at or below 30.
- Keep profile visits at or below 50 per day.
- The sequencer already reads those limits from `raxion_settings` and records usage in `daily_limits`.
- Do not raise limits aggressively on a new LinkedIn account. Warm up slowly and monitor acceptance and reply quality.

## Runtime Overview

- `index.js` boots the app, tests Supabase, starts the dashboard, webhook route, Telegram bot, inbox monitor, and cron jobs.
- `src/prompts/` contains every Claude prompt builder. No inline prompts are used elsewhere.
- `src/integrations/` isolates Supabase, Claude, Unipile, and Telegram integrations.
- `src/services/` contains brief parsing, sourcing, sequencing, reply handling, qualification logic, and settings access.
- `src/dashboard/` contains the server-rendered dashboard and the extracted design system CSS.

## Notes

- Raxion is standalone. It does not depend on Lexora tables or services.
- All Supabase writes go through the service-role client in `src/db/supabase.js`.
- All Claude calls are forced through `src/integrations/claude.js` using `claude-sonnet-4-20250514` and `max_tokens: 1000`.
- The Unipile wrapper supports SDK-first calls with REST fallbacks to keep the integration layer isolated.
