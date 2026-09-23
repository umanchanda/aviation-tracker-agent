// Shared types for flight state, AeroDataBox API responses, and Env bindings.

export interface Env {
  FLIGHT_STATE_KV: KVNamespace;
  AI: Ai;
  TRACKED_FLIGHTS: string;
  TRACKED_AIRLINE_IATA: string;
  TRACKED_AIRPORTS: string;
  TRACKED_ROUTES: string;
  AERODATABOX_HOST: string;
  AERODATABOX_API_KEY: string;
  DISCORD_WEBHOOK_URL: string;
}

/** Normalized flight status we persist in KV and diff between polls. */
export interface FlightState {
  flightNumber: string;
  status: string;
  departureAirport?: string;
  arrivalAirport?: string;
  scheduledDeparture?: string;
  actualDeparture?: string;
  scheduledArrival?: string;
  actualArrival?: string;
  delayMinutes?: number;
  diverted?: boolean;
  diversionAirport?: string;
  lastUpdated: string;
}

/** Minimal shape of the fields we use from AeroDataBox's flight-status response. */
export interface AeroDataBoxFlight {
  number?: string;
  status?: string;
  departure?: {
    airport?: { iata?: string; icao?: string; name?: string };
    scheduledTime?: { utc?: string };
    actualTime?: { utc?: string };
  };
  arrival?: {
    airport?: { iata?: string; icao?: string; name?: string };
    scheduledTime?: { utc?: string };
    actualTime?: { utc?: string };
  };
}

/** Minimal shape of a single flight entry from the AeroDataBox airport FIDS response. */
export interface AeroDataBoxAirportFlight {
  number?: string;
  status?: string;
  airline?: { name?: string; iata?: string; icao?: string };
  departure?: {
    airport?: { iata?: string; icao?: string };
    scheduledTime?: { utc?: string };
    actualTime?: { utc?: string };
  };
  arrival?: {
    airport?: { iata?: string; icao?: string };
    scheduledTime?: { utc?: string };
    actualTime?: { utc?: string };
  };
}

export interface AeroDataBoxAirportFids {
  departures?: AeroDataBoxAirportFlight[];
  arrivals?: AeroDataBoxAirportFlight[];
}

/** Categories of change we detect between the previous and current FlightState. */
export type ChangeType =
  | "DEPARTED"
  | "ARRIVED"
  | "DIVERTED"
  | "DELAYED"
  | "STATUS_CHANGED";

export interface DetectedChange {
  type: ChangeType;
  previous: FlightState | null;
  current: FlightState;
}
