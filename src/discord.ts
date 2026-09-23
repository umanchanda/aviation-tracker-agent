import type { ChangeType, DetectedChange, Env } from "./types";

const COLOR_BY_TYPE: Record<ChangeType, number> = {
  DEPARTED: 0x2ecc71, // green
  ARRIVED: 0x3498db, // blue
  DIVERTED: 0xe74c3c, // red
  DELAYED: 0xf39c12, // orange
  STATUS_CHANGED: 0x95a5a6, // grey
};

/**
 * Sends a structured embed alert to the configured Discord webhook.
 * Throws if the webhook request fails so the caller can log/report it.
 */
export async function sendDiscordAlert(
  env: Env,
  change: DetectedChange,
  summary: string,
): Promise<void> {
  const { current } = change;

  const fields = [
    { name: "Status", value: current.status, inline: true },
    {
      name: "Route",
      value:
        current.departureAirport && current.arrivalAirport
          ? `${current.departureAirport} -> ${current.arrivalAirport}`
          : "Unknown",
      inline: true,
    },
  ];

  if (current.delayMinutes !== undefined) {
    fields.push({
      name: "Delay",
      value: `${current.delayMinutes} min`,
      inline: true,
    });
  }

  const payload = {
    embeds: [
      {
        title: `✈️ Flight ${current.flightNumber}: ${change.type.replace("_", " ")}`,
        description: summary,
        color: COLOR_BY_TYPE[change.type],
        fields,
        timestamp: current.lastUpdated,
        footer: { text: "Aviation Tracker Agent" },
      },
    ],
  };

  await postWithRetry(env.DISCORD_WEBHOOK_URL, payload);
}

const MAX_RETRIES = 3;

/** Posts to the Discord webhook, retrying on 429 using the server's retry_after. */
async function postWithRetry(
  url: string,
  payload: unknown,
  attempt = 1,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (res.status === 429 && attempt <= MAX_RETRIES) {
    const body = await res.json().catch(() => ({}) as { retry_after?: number });
    const retryAfterMs = Math.ceil(((body as { retry_after?: number }).retry_after ?? 1) * 1000);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    return postWithRetry(url, payload, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(
      `Discord webhook failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
}
