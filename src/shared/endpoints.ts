/**
 * Single source of truth for the custom API endpoints this client uses.
 *
 * Every custom service is exposed through the same gateway that serves
 * Outline (outline-selfhost/gateway/Caddyfile — the matching single place on
 * the server side), so a service is fully described by its path prefix here.
 * Add new services (e.g. a meeting summarizer) as new entries.
 */
export const SERVICE_PATHS = {
  /** Realtime meeting transcription WebSocket (outline-selfhost/stt-server). */
  stt: "/stt",
} as const;

export type ServiceName = keyof typeof SERVICE_PATHS;

/** Build a service URL on the Outline gateway, e.g. https origin -> wss URL. */
export function deriveServiceUrl(
  outlineOrigin: string,
  service: ServiceName,
  scheme: "ws" | "http" = "ws",
): string {
  const url = new URL(outlineOrigin);
  const secure = url.protocol === "https:";
  url.protocol = scheme === "ws" ? (secure ? "wss:" : "ws:") : url.protocol;
  url.pathname = SERVICE_PATHS[service];
  return url.toString();
}
