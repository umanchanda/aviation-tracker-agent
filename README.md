# Aviation Tracker Agent

Serverless, autonomous flight-tracking agent that runs on Cloudflare Workers.
Every 5 minutes (via Cron Trigger) it polls live flight telemetry from
AeroDataBox, diffs it against last-known state stored in Workers KV, and for
any meaningful change (departure, arrival, diversion, delay) it uses Workers
AI (`@cf/meta/llama-3-8b-instruct`) to write a short natural-language summary
and posts a structured alert to a Discord webhook.

## Project layout

```
src/
  index.ts          # scheduled()/fetch() entry points, orchestration
  aerodatabox.ts     # AeroDataBox API client + KV state read/write
  changeDetector.ts   # diff logic between previous/current flight state
  summarizer.ts        # Workers AI summary generation
  discord.ts            # Discord webhook embed dispatch
  types.ts               # Env bindings + shared interfaces
wrangler.toml
```

## Prerequisites

- Node.js 18+
- A Cloudflare account (Workers + Workers AI enabled)
- A RapidAPI account subscribed to the AeroDataBox API
- A Discord server with a webhook URL

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Authenticate Wrangler with Cloudflare:

   ```bash
   npx wrangler login
   ```

3. Create the KV namespace and copy the resulting IDs into `wrangler.toml`
   (`FLIGHT_STATE_KV` binding — replace `REPLACE_WITH_KV_NAMESPACE_ID` and
   `REPLACE_WITH_PREVIEW_KV_NAMESPACE_ID`):

   ```bash
   npx wrangler kv namespace create FLIGHT_STATE_KV
   npx wrangler kv namespace create FLIGHT_STATE_KV --preview
   ```

4. Edit `[vars]` in `wrangler.toml` to set `TRACKED_FLIGHTS` (comma-separated
   flight numbers, e.g. `AA100,UA200,DAL45`).

   To track an entire airline instead of specific flight numbers, set
   `TRACKED_AIRLINE_IATA` (e.g. `WN` for Southwest) and `TRACKED_AIRPORTS`
   (comma-separated IATA airport codes to poll, e.g. Southwest's hubs
   `MDW,DAL,HOU,LAS,PHX,BWI,DEN,ATL`). This mode polls each airport's FIDS
   feed and keeps only flights operated by the given airline. It costs one
   API call per airport per poll cycle (more quota usage than per-flight
   tracking), and can't realistically cover *every* flight an airline
   operates — pick the airports you care about. Set `TRACKED_AIRLINE_IATA`
   to `""` to disable this mode.

   To track a specific origin-destination route instead, set `TRACKED_ROUTES`
   (comma-separated `ORIG-DEST` pairs, e.g. `MDW-DEN,MDW-LAS`). This polls
   FIDS at each origin airport and keeps only flights arriving at the paired
   destination. If `TRACKED_AIRLINE_IATA` is also set, routes are further
   restricted to that airline. Set `TRACKED_ROUTES` to `""` to disable this
   mode.

5. Set secrets (never store these in `wrangler.toml`):

   ```bash
   npx wrangler secret put AERODATABOX_API_KEY
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```

   For local development, copy `.dev.vars.example` to `.dev.vars` and fill in
   the same two values — `.dev.vars` is gitignored.

## Local development

```bash
npm run dev
```

Then trigger a poll cycle manually:

```bash
curl http://localhost:8787/run
```

To simulate the cron trigger locally:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

## Deployment

```bash
npm run deploy
```

Check logs from the live worker (including scheduled runs):

```bash
npm run tail
```

## Notes

- KV is used here for simplicity (one small JSON blob per flight number). If
  you need richer querying (e.g. historical event logs, per-airline
  dashboards), swap `FLIGHT_STATE_KV` reads/writes in `aerodatabox.ts` for a
  D1 database instead.
- `changeDetector.ts` only alerts on the first poll if the flight is already
  in a notable state, to avoid spamming on "Scheduled" flights the very first
  time they're seen.
- Delay alerts fire once delay crosses 15 minutes (`SIGNIFICANT_DELAY_MINUTES`
  in `changeDetector.ts`); tune as needed.
