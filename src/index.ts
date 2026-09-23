import {
  fetchAirlineFlightsAtAirport,
  fetchFlightStatus,
  fetchRouteFlights,
  getStoredState,
  storeState,
} from "./aerodatabox";
import { detectChanges } from "./changeDetector";
import { sendDiscordAlert } from "./discord";
import { summarizeChange } from "./summarizer";
import type { DetectedChange, Env, FlightState } from "./types";

export default {
  /**
   * Cron entry point: polls every tracked flight, diffs against last-known
   * state in KV, and dispatches a Discord alert for each detected change.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(pollAllFlights(env));
  },

  /**
   * HTTP entry point, useful for manual runs (`wrangler dev`) and health
   * checks. GET /run triggers an immediate poll cycle.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      ctx.waitUntil(pollAllFlights(env));
      return new Response("Poll cycle triggered\n", { status: 202 });
    }
    return new Response("Aviation Tracker Agent is running.\n", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function pollAllFlights(env: Env): Promise<void> {
  await Promise.all([
    pollTrackedFlightNumbers(env),
    pollTrackedAirline(env),
    pollTrackedRoutes(env),
  ]);
}

async function pollTrackedFlightNumbers(env: Env): Promise<void> {
  const flightNumbers = env.TRACKED_FLIGHTS.split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  const results = await Promise.allSettled(
    flightNumbers.map((flightNumber) => pollFlight(env, flightNumber)),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`Failed to process ${flightNumbers[i]}:`, result.reason);
    }
  }
}

async function pollFlight(env: Env, flightNumber: string): Promise<void> {
  const [previous, current] = await Promise.all([
    getStoredState(env, flightNumber),
    fetchFlightStatus(env, flightNumber),
  ]);

  if (!current) {
    console.warn(`No status returned for ${flightNumber}; skipping.`);
    return;
  }

  await processChangesAndStore(env, flightNumber, previous, current);
}

/**
 * Airline-wide tracking: polls FIDS at each configured airport and processes
 * every flight operated by TRACKED_AIRLINE_IATA. No-op if not configured.
 */
async function pollTrackedAirline(env: Env): Promise<void> {
  const airlineIata = env.TRACKED_AIRLINE_IATA?.trim();
  const airports = env.TRACKED_AIRPORTS?.split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  if (!airlineIata || !airports || airports.length === 0) return;

  const results = await Promise.allSettled(
    airports.map((airport) => pollAirlineAtAirport(env, airport, airlineIata)),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`Failed to process airport ${airports[i]}:`, result.reason);
    }
  }
}

async function pollAirlineAtAirport(
  env: Env,
  airport: string,
  airlineIata: string,
): Promise<void> {
  const flights = await fetchAirlineFlightsAtAirport(env, airport, airlineIata);

  // Process flights concurrently; sequential awaits risked exceeding the
  // waitUntil() time budget when many flights match at a busy airport.
  const results = await Promise.allSettled(
    flights.map(async ({ key, state }) => {
      const previous = await getStoredState(env, key);
      await processChangesAndStore(env, key, previous, state);
    }),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`Failed to process ${flights[i]?.key}:`, result.reason);
    }
  }
}

/**
 * Route tracking: polls FIDS at each origin airport in TRACKED_ROUTES and
 * processes only flights arriving at the paired destination airport (optionally
 * restricted to TRACKED_AIRLINE_IATA). Routes are formatted "ORIG-DEST", e.g.
 * "MDW-DEN,MDW-LAS". No-op if TRACKED_ROUTES is not configured.
 */
async function pollTrackedRoutes(env: Env): Promise<void> {
  const routes = env.TRACKED_ROUTES?.split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  if (!routes || routes.length === 0) return;

  const results = await Promise.allSettled(
    routes.map((route) => pollRoute(env, route)),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`Failed to process route ${routes[i]}:`, result.reason);
    }
  }
}

async function pollRoute(env: Env, route: string): Promise<void> {
  const [origin, destination] = route.split("-").map((s) => s.trim());
  if (!origin || !destination) {
    console.error(`Invalid route "${route}"; expected format "ORIG-DEST".`);
    return;
  }

  const airlineIata = env.TRACKED_AIRLINE_IATA?.trim() || undefined;
  const flights = await fetchRouteFlights(env, origin, destination, airlineIata);

  const results = await Promise.allSettled(
    flights.map(async ({ key, state }) => {
      const previous = await getStoredState(env, key);
      await processChangesAndStore(env, key, previous, state);
    }),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`Failed to process ${flights[i]?.key}:`, result.reason);
    }
  }
}

async function processChangesAndStore(
  env: Env,
  key: string,
  previous: FlightState | null,
  current: FlightState,
): Promise<void> {
  const changes: DetectedChange[] = detectChanges(previous, current);

  for (const change of changes) {
    const summary = await summarizeChange(env, change);
    try {
      await sendDiscordAlert(env, change, summary);
    } catch (err) {
      console.error(`Failed to send Discord alert for ${key}:`, err);
    }
  }

  await storeState(env, key, current);
}
