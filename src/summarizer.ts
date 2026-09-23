import type { DetectedChange, Env } from "./types";

/**
 * Uses Workers AI (Llama 3.1 8B Instruct) to turn a detected flight change
 * into a short, natural-language summary suitable for a Discord alert.
 * Falls back to a templated summary if the model call fails.
 */
export async function summarizeChange(
  env: Env,
  change: DetectedChange,
): Promise<string> {
  const prompt = buildPrompt(change);

  try {
    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
      messages: [
        {
          role: "system",
          content:
            "You are an aviation operations assistant. Write a single, concise " +
            "sentence (under 30 words) summarizing a flight status change for " +
            "an alert notification. Be factual, no hashtags, no emojis.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 80,
    });

    const text =
      typeof response === "object" && response !== null && "response" in response
        ? String((response as { response?: unknown }).response ?? "").trim()
        : "";

    return text || fallbackSummary(change);
  } catch (err) {
    console.error("Workers AI summarization failed:", err);
    return fallbackSummary(change);
  }
}

function buildPrompt(change: DetectedChange): string {
  const { current } = change;
  const parts = [
    `Flight ${current.flightNumber} changed status to "${current.status}".`,
  ];
  if (current.departureAirport && current.arrivalAirport) {
    parts.push(`Route: ${current.departureAirport} -> ${current.arrivalAirport}.`);
  }
  if (current.delayMinutes && current.delayMinutes > 0) {
    parts.push(`Delay: ${current.delayMinutes} minutes.`);
  }
  if (current.diverted && current.diversionAirport) {
    parts.push(`Diverted to ${current.diversionAirport}.`);
  }
  return parts.join(" ");
}

function fallbackSummary(change: DetectedChange): string {
  const { current } = change;
  const route =
    current.departureAirport && current.arrivalAirport
      ? ` (${current.departureAirport} -> ${current.arrivalAirport})`
      : "";
  return `Flight ${current.flightNumber}${route} status changed to ${current.status}.`;
}
