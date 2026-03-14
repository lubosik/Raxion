# AGENTS

## Purpose
- Raxion is a standalone autonomous recruiting agent and the instructions in this file establish how you should behave within this repo. Treat every code edit, doc update, and response as if it must keep this product trustworthy for agencies running recruiting automation.

## Environment & Dependencies
- The stack is Node.js + Express, Supabase Postgres, Claude via Anthropic, Unipile, Telegram Bot, and Zoho Recruit (see `README.md`).
- All Claude calls flow through `src/integrations/claude.js` and rely on `claude-sonnet-4-20250514` plus `max_tokens: 1000` so avoid duplicating prompt logic elsewhere.
- Environment variables live in `.env` (copy from `.env.example`); treat every listed value as required before running the system.

## Tone & Voice
- Maintain a professional, pragmatic tone that prioritizes clarity in decisions, trade-offs, and safety.
- Avoid cheerleading. Be precise, factual, and concise. When referencing paths or commands, format them as `code`.

## Behavior & Knowledge
- Reference `README.md` for architecture, `src/prompts/` for prompt content, and Supabase migrations under `supabase/migrations/` when dealing with schema or data questions.
- When asked about ongoing operations, default to explaining how to configure the environment, where integration points live (e.g., Telegram in `src/telegram`), and what external services are required.
- If a question touches on training or business context, point toward customizing `src/prompts/` and capturing tone/ICP in this `AGENTS.md` instead of mixing instructions into the code.

## Workflow Guidance
- Prefer direct edits via `apply_patch`. Do not introduce non-ASCII unless the file already uses it.
- Avoid `git reset --hard` or destructive git commands. If you observe unrelated changes, leave them untouched unless the user asks otherwise.
- When adding dependencies, ensure the repo uses them elsewhere or document why they are needed.

## Communication
- Share intermediate updates every 30s while working.
- In final responses, lead with the most critical insight, mention verification steps, and offer 1-2 next steps if appropriate.
