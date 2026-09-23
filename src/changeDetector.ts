import type { ChangeType, DetectedChange, FlightState } from "./types";

const SIGNIFICANT_DELAY_MINUTES = 15;

/**
 * Compares the previous and current flight state and returns a list of
 * detected changes worth alerting on. Returns an empty array if nothing
 * meaningful changed since the last poll.
 */
export function detectChanges(
  previous: FlightState | null,
  current: FlightState,
): DetectedChange[] {
  const changes: DetectedChange[] = [];

  if (!previous) {
    // First time we've seen this flight; only alert if it's already in a
    // notable state (avoids spamming on the very first poll for "Scheduled").
    if (isNotableStatus(current.status)) {
      changes.push({ type: statusToChangeType(current.status), previous, current });
    }
    return changes;
  }

  if (previous.status !== current.status) {
    changes.push({ type: statusToChangeType(current.status), previous, current });
  }

  if (!previous.diverted && current.diverted) {
    changes.push({ type: "DIVERTED", previous, current });
  }

  const prevDelay = previous.delayMinutes ?? 0;
  const currDelay = current.delayMinutes ?? 0;
  if (
    currDelay >= SIGNIFICANT_DELAY_MINUTES &&
    currDelay !== prevDelay &&
    !changes.some((c) => c.type === "DELAYED")
  ) {
    changes.push({ type: "DELAYED", previous, current });
  }

  return changes;
}

function isNotableStatus(status: string): boolean {
  const s = status.toLowerCase();
  return (
    s.includes("depart") ||
    s.includes("arriv") ||
    s.includes("divert") ||
    s.includes("cancel") ||
    s.includes("delay")
  );
}

function statusToChangeType(status: string): ChangeType {
  const s = status.toLowerCase();
  if (s.includes("depart")) return "DEPARTED";
  if (s.includes("arriv")) return "ARRIVED";
  if (s.includes("divert")) return "DIVERTED";
  if (s.includes("delay")) return "DELAYED";
  return "STATUS_CHANGED";
}
