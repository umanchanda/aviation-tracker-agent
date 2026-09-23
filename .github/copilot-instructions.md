# aviation-tracker-agent

Serverless Cloudflare Worker that polls flight status via AeroDataBox, diffs against
last-known state in KV, and posts Discord alerts summarized by Workers AI.

## Architecture
- `src/index.ts` — `scheduled()` cron entry + `fetch()` handler (`GET /run` triggers a manual poll).
- `src/aerodatabox.ts` — AeroDataBox API client + KV read/write for flight state.
- `src/changeDetector.ts` — diffs previous vs. current `FlightState` into `DetectedChange[]`.
- `src/summarizer.ts` — Workers AI (`@cf/meta/llama-3.1-8b-instruct-fp8`) summary generation, with a templated fallback if the model call fails.
- `src/discord.ts` — posts a colored embed per change type, with retry-on-429 honoring Discord's `retry_after`.
- `src/types.ts` — `Env` bindings + shared interfaces.

## Tracking modes (all independent, all configured via `wrangler.toml` `[vars]`)
1. **Flight-number tracking** — `TRACKED_FLIGHTS` (comma-separated numbers, e.g. `AA100,UA200`).
2. **Airline-wide tracking** — `TRACKED_AIRLINE_IATA` + `TRACKED_AIRPORTS`. Polls FIDS at each airport, filters to that airline.
3. **Route tracking** — `TRACKED_ROUTES` (format `ORIG-DEST`, comma-separated, e.g. `EWR-LHR,LHR-EWR`). Polls the origin airport's FIDS, keeps flights arriving at the destination. Combine with `TRACKED_AIRLINE_IATA` to further restrict by airline.

Set any mode's var to `""` to disable it. Modes run concurrently in `pollAllFlights()`.

## KV key conventions
- Flight-number mode: key is the flight number itself (e.g. `AA100`).
- Airline/route mode: key is `${flightNumber}:${departureAirport}:${scheduledDateYYYYMMDD}` to disambiguate the same flight number recurring on different days.
- All keys are prefixed with `flight:` and upper-cased inside `aerodatabox.ts`'s `kvKey()`.

## AeroDataBox API notes
- No native "all flights for an airline" or "flights by route" endpoint exists — both are implemented by polling airport FIDS (`/flights/airports/iata/{code}`) and filtering client-side (see `fetchAirportFids` in `src/aerodatabox.ts`).
- FIDS calls are billed per airport per poll and can return many flights — avoid adding large airport lists without considering quota.

## Known pitfalls (already hit and fixed)
- Cloudflare Workers AI models get deprecated — if `summarizeChange` starts failing, check the model catalog (`https://developers.cloudflare.com/workers-ai/models/`) for a current replacement rather than assuming the code is wrong.
- Discord webhooks rate-limit at ~5 requests/2s — always send alerts through `postWithRetry` in `discord.ts`, never a bare `fetch`.
- Processing flights sequentially in a loop risks exceeding the `waitUntil()` time budget when many flights match — use `Promise.allSettled` for concurrent processing (see `pollAirlineAtAirport`, `pollRoute`).

## Deployment
- `npm run dev` — local dev server; `GET /run` on it triggers a manual poll.
- `npm run deploy` — `wrangler deploy`.
- `npm run tail` — stream live logs from the deployed worker (use this to verify alerts after any change to tracking config or summarization).
- Secrets (`AERODATABOX_API_KEY`, `DISCORD_WEBHOOK_URL`) are set via `wrangler secret put`, never committed. Local dev uses `.dev.vars` (gitignored).
- Cron schedule lives in `wrangler.toml`'s `[triggers]` block.
