# Raxion Project Handoff

## What Raxion Is

Raxion is an AI recruiting agent for recruitment agencies.

In plain English, it is a backend system that helps a recruiter do the following:

- take in a job brief
- understand that brief with Claude
- search for candidates on LinkedIn through Unipile
- score those candidates against the brief
- start outreach across LinkedIn and email
- watch for replies
- classify replies and continue the conversation
- qualify interested candidates
- alert the recruiter in Telegram
- show all of this in a dashboard

It is designed to run as one standalone Node.js app, not as a collection of microservices.

## What Is Already Built

The current system already has the main backbone in place.

### 1. Core app runtime

The app starts from `index.js` and currently does all of this:

- loads environment variables
- connects to Supabase
- starts the Express server
- mounts the dashboard routes
- mounts the Unipile webhook routes
- starts the Telegram bot
- starts the inbox monitor
- starts cron jobs for outreach sequencing

This means the product is already structured like a working autonomous recruiting backend, not just a mockup.

### 2. Dashboard

There is a working server-rendered dashboard.

It is available locally on port `3001` and was confirmed live during this session.

The dashboard currently includes pages for:

- Overview
- Campaigns
- Candidates
- Inbox
- Activity

It reads live data from Supabase and shows operational state, rather than being static sample UI.

### 3. Supabase database schema

The database layer is already designed and migrated through `supabase/migrations/001_raxion_schema.sql`.

The current schema includes tables for:

- job briefs
- candidates
- outreach logs
- reply logs
- qualification state
- daily limits
- inbound leads
- webhook logs
- error logs
- settings

So the project already has a real persistence model for the recruiting workflow.

### 4. AI prompt architecture

Claude usage is centralized properly.

All Claude calls go through `src/integrations/claude.js`, and prompts are stored in `src/prompts/`.

This is good because it keeps the AI behavior consistent and makes prompt changes easier without scattering prompt logic across the codebase.

### 5. Candidate sourcing

The system can already:

- take a job brief
- generate a LinkedIn search query
- search profiles through Unipile
- fetch profile details
- score candidates with Claude
- store candidates in Supabase
- respect daily profile visit limits
- notify the recruiter in Telegram when sourcing completes

This means the sourcing flow is implemented, not just planned.

### 6. Outreach sequencing

There is already a sequencer that moves candidates through outreach steps.

The current logic supports:

- LinkedIn connection request
- opening LinkedIn DM after connection
- LinkedIn follow-up DM
- fallback email outreach
- marking no-response candidates as cold

The system also tracks daily invite limits and reads limits from settings in the database.

### 7. Reply handling and qualification

Incoming replies are already processed.

The current reply logic can:

- classify a candidate reply with Claude
- log the reply
- detect interest
- detect not interested
- detect maybe later
- detect referral
- detect questions
- send an appropriate follow-up response
- move interested candidates into qualification

There is also a qualification engine and candidate qualification state in the database.

### 8. Recruiter notifications

Telegram is already wired into the product.

The system currently uses Telegram for:

- startup notifications
- sourcing completion alerts
- inbound lead alerts
- candidate qualification alerts
- recruiter command handling

This gives the recruiter an operational control layer outside the dashboard.

### 9. External integrations

The project is already connected conceptually and in code to:

- Supabase
- Anthropic Claude
- Unipile
- Telegram
- Zoho Recruit

Zoho support is already present in the dashboard actions and API logic for sending a candidate into Zoho Recruit.

## What We Verified In This Session

We verified the following:

- the environment file is being read correctly
- the Supabase credentials now work
- the app starts successfully
- the inbox monitor starts
- the app logs that it is listening on port `3001`
- the dashboard returns `HTTP 200`
- the dashboard was opened locally in the browser

So the current repo is not just code on disk. It is capable of starting and serving the live dashboard in the current environment.

## Current Product Shape In Simple English

Right now, Raxion is best described as:

"A functional backend-first recruiting agent with a live admin dashboard, real integrations, database persistence, AI-driven decision making, and automated outreach logic."

It is beyond the idea stage and beyond the pure prototype stage.

However, it is still at the stage where the next phase should focus on tightening the product into a production-grade recruiting operating system.

## What Seems To Be Working Conceptually Right Now

The intended workflow appears to be:

1. A recruiter provides a job brief.
2. Raxion parses the brief into structured data.
3. Raxion sources candidate profiles from LinkedIn.
4. Raxion scores and stores those candidates.
5. Raxion sends outreach in stages.
6. Raxion watches for replies via webhook/inbox flows.
7. Raxion classifies replies and continues the conversation.
8. Raxion qualifies strong candidates.
9. Raxion alerts the recruiter.
10. The recruiter reviews everything in the dashboard and can push candidates into Zoho.

That end-to-end story already exists in the architecture and code.

## Likely Next Phase

The next phase should probably not be "build the basic product."

That part largely exists already.

The next phase is more likely to be:

- hardening the workflow
- improving reliability and error recovery
- closing gaps in the recruiter UX
- tightening candidate state transitions
- improving observability and auditability
- making webhook and sequencing behavior more robust
- adding operational controls and safeguards
- refining prompt quality and qualification behavior
- improving deployment readiness

## Recommended Framing For The Next AI Assistant

Use this framing:

"We already have a working standalone AI recruiting backend called Raxion. It runs on Node.js + Express, uses Supabase for data, Claude for AI decisions, Unipile for LinkedIn/email actions, Telegram for recruiter alerts, and Zoho Recruit as a downstream ATS integration. The dashboard is server-rendered and live locally. We are now entering the next phase, which should focus on strengthening, refining, and operationalizing the system rather than inventing the initial architecture from scratch."

## Important File Landmarks

If the next assistant needs to inspect the project, these are the main places to start:

- `README.md`
- `index.js`
- `src/dashboard/server.js`
- `src/integrations/claude.js`
- `src/integrations/unipile.js`
- `src/services/jobBriefParser.js`
- `src/services/candidateSourcing.js`
- `src/services/outreachSequencer.js`
- `src/services/replyHandler.js`
- `src/services/qualificationEngine.js`
- `src/telegram/commandHandler.js`
- `supabase/migrations/001_raxion_schema.sql`

## Final Summary

Raxion currently has a real working foundation.

It already has:

- the main backend runtime
- the database schema
- the dashboard
- the AI prompt structure
- sourcing
- outreach sequencing
- reply handling
- qualification flow
- Telegram alerts
- Zoho handoff support

The next phase should treat the product as an existing system that needs refinement, reliability, product polish, and production readiness.
