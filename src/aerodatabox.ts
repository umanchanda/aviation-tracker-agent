import type {
  AeroDataBoxAirportFids,
  AeroDataBoxAirportFlight,
  AeroDataBoxFlight,
  Env,
  FlightState,
} from "./types";

/**
 * Fetches the current status for a single flight number from AeroDataBox.
 * Uses the "today" flight-number lookup endpoint, which returns an array
 * because a flight number can map to multiple legs/dates.
 */
export async function fetchFlightStatus(
  env: Env,
  flightNumber: string,
): Promise<FlightState | null> {
  const url = `https://${env.AERODATABOX_HOST}/flights/number/${encodeURIComponent(
    flightNumber,
  )}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-RapidAPI-Key": env.AERODATABOX_API_KEY,
      "X-RapidAPI-Host": env.AERODATABOX_HOST,
    },
  });

  if (!res.ok) {
    console.error(
      `AeroDataBox request failed for ${flightNumber}: ${res.status} ${await safeText(res)}`,
    );
    return null;
  }

  const data = (await res.json()) as AeroDataBoxFlight[];
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  // Prefer the leg that is currently active/most recent; fall back to first entry.
  const flight = data[0];
  if (!flight) return null;
  return normalizeFlight(flightNumber, flight);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

function normalizeFlight(
  flightNumber: string,
  flight: AeroDataBoxFlight,
): FlightState {
  const scheduledDeparture = flight.departure?.scheduledTime?.utc;
  const actualDeparture = flight.departure?.actualTime?.utc;
  const scheduledArrival = flight.arrival?.scheduledTime?.utc;
  const actualArrival = flight.arrival?.actualTime?.utc;

  const delayMinutes = computeDelayMinutes(scheduledDeparture, actualDeparture);

  return {
    flightNumber,
    status: flight.status ?? "Unknown",
    departureAirport:
      flight.departure?.airport?.iata ?? flight.departure?.airport?.icao,
    arrivalAirport:
      flight.arrival?.airport?.iata ?? flight.arrival?.airport?.icao,
    scheduledDeparture,
    actualDeparture,
    scheduledArrival,
    actualArrival,
    delayMinutes,
    lastUpdated: new Date().toISOString(),
  };
}

function computeDelayMinutes(
  scheduled?: string,
  actual?: string,
): number | undefined {
  if (!scheduled || !actual) return undefined;
  const diffMs = new Date(actual).getTime() - new Date(scheduled).getTime();
  if (Number.isNaN(diffMs)) return undefined;
  return Math.round(diffMs / 60000);
}

/** Reads the last-known state for a flight from KV, if any. */
export async function getStoredState(
  env: Env,
  key: string,
): Promise<FlightState | null> {
  const raw = await env.FLIGHT_STATE_KV.get(kvKey(key));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FlightState;
  } catch {
    return null;
  }
}

/** Persists the latest state for a flight to KV under the given key. */
export async function storeState(
  env: Env,
  key: string,
  state: FlightState,
): Promise<void> {
  await env.FLIGHT_STATE_KV.put(kvKey(key), JSON.stringify(state));
}

function kvKey(key: string): string {
  return `flight:${key.toUpperCase()}`;
}

/**
 * Fetches the airport FIDS feed (departures + arrivals), normalized into
 * FlightState plus a KV-safe instance key that disambiguates same
 * flight-number recurrences by scheduled departure date.
 */
async function fetchAirportFids(
  env: Env,
  airportIata: string,
): Promise<Array<{ key: string; state: FlightState; flight: AeroDataBoxAirportFlight }>> {
  const url = `https://${env.AERODATABOX_HOST}/flights/airports/iata/${encodeURIComponent(
    airportIata,
  )}?withLeg=true&withCancelled=false&withCargo=false&withPrivate=false`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-RapidAPI-Key": env.AERODATABOX_API_KEY,
      "X-RapidAPI-Host": env.AERODATABOX_HOST,
    },
  });

  if (!res.ok) {
    console.error(
      `AeroDataBox FIDS request failed for ${airportIata}: ${res.status} ${await safeText(res)}`,
    );
    return [];
  }

  const data = (await res.json()) as AeroDataBoxAirportFids;
  const flights = [...(data.departures ?? []), ...(data.arrivals ?? [])];

  const results: Array<{ key: string; state: FlightState; flight: AeroDataBoxAirportFlight }> = [];
  for (const flight of flights) {
    if (!flight.number) continue;
    const state = normalizeAirportFlight(flight);
    const dateStamp = (state.scheduledDeparture ?? state.scheduledArrival ?? "unknown").slice(
      0,
      10,
    );
    const key = `${state.flightNumber}:${state.departureAirport ?? "?"}:${dateStamp}`;
    results.push({ key, state, flight });
  }
  return results;
}

/**
 * Fetches the airport FIDS feed and returns only flights operated by the
 * given airline (matched by IATA or ICAO code), normalized into FlightState.
 */
export async function fetchAirlineFlightsAtAirport(
  env: Env,
  airportIata: string,
  airlineIata: string,
): Promise<Array<{ key: string; state: FlightState }>> {
  const flights = await fetchAirportFids(env, airportIata);
  return flights
    .filter(
      ({ flight }) =>
        flight.airline?.iata?.toUpperCase() === airlineIata.toUpperCase() ||
        flight.airline?.icao?.toUpperCase() === airlineIata.toUpperCase(),
    )
    .map(({ key, state }) => ({ key, state }));
}

/**
 * Fetches the origin airport's FIDS feed and returns only flights arriving
 * at the given destination airport (matched by IATA or ICAO code),
 * optionally further restricted to a specific airline.
 */
export async function fetchRouteFlights(
  env: Env,
  originIata: string,
  destinationIata: string,
  airlineIata?: string,
): Promise<Array<{ key: string; state: FlightState }>> {
  const flights = await fetchAirportFids(env, originIata);
  return flights
    .filter(({ state, flight }) => {
      const matchesDestination =
        state.arrivalAirport?.toUpperCase() === destinationIata.toUpperCase();
      if (!matchesDestination) return false;
      if (!airlineIata) return true;
      return (
        flight.airline?.iata?.toUpperCase() === airlineIata.toUpperCase() ||
        flight.airline?.icao?.toUpperCase() === airlineIata.toUpperCase()
      );
    })
    .map(({ key, state }) => ({ key, state }));
}

function normalizeAirportFlight(flight: AeroDataBoxAirportFlight): FlightState {
  const scheduledDeparture = flight.departure?.scheduledTime?.utc;
  const actualDeparture = flight.departure?.actualTime?.utc;
  const scheduledArrival = flight.arrival?.scheduledTime?.utc;
  const actualArrival = flight.arrival?.actualTime?.utc;

  return {
    flightNumber: flight.number ?? "UNKNOWN",
    status: flight.status ?? "Unknown",
    departureAirport:
      flight.departure?.airport?.iata ?? flight.departure?.airport?.icao,
    arrivalAirport: flight.arrival?.airport?.iata ?? flight.arrival?.airport?.icao,
    scheduledDeparture,
    actualDeparture,
    scheduledArrival,
    actualArrival,
    delayMinutes: computeDelayMinutes(scheduledDeparture, actualDeparture),
    lastUpdated: new Date().toISOString(),
  };
}
