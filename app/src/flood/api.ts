/**
 * HTTP client for /v1. Every failure surfaces as an ApiFailure with the server's
 * error code - there is no silent fallback to mock data anywhere.
 */
import type {
  ApiErrorBody,
  EvidenceView,
  HazardsSnapshot,
  HotspotsView,
  CompareRequest,
  ObservationRequest,
  ObservationResult,
  ReportDraft,
  RouteDecision,
  Status,
  Weather,
} from "./contracts.ts";
import { CORRIDOR_ID } from "./contracts.ts";

export const API_BASE: string = import.meta.env?.VITE_API_BASE ?? "";
const TIMEOUT_MS = 10_000;

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = (err as Error).name === "AbortError";
    throw new ApiFailure(0, timedOut ? "TIMEOUT" : "NETWORK", timedOut ? "The server took too long." : "No connection.", true);
  } finally {
    clearTimeout(timer);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiFailure(res.status, "BAD_RESPONSE", "The server sent an unreadable response.", res.status >= 500);
  }
  if (!res.ok) {
    const e = (data as ApiErrorBody).error ?? { code: "HTTP_" + res.status, message: res.statusText, retryable: res.status >= 500, requestId: "" };
    throw new ApiFailure(res.status, e.code, e.message, e.retryable, e.requestId || res.headers.get("x-request-id") || undefined);
  }
  return data as T;
}

export const api = {
  status: () => request<Status>("GET", "/v1/status"),
  hotspots: () => request<HotspotsView>("GET", `/v1/hotspots?corridorId=${CORRIDOR_ID}`),
  hazards: () => request<HazardsSnapshot>("GET", `/v1/hazards?corridorId=${CORRIDOR_ID}`),
  evidence: (hotspotId: string) => request<EvidenceView>("GET", `/v1/hotspots/${encodeURIComponent(hotspotId)}/evidence`),
  compare: (req: CompareRequest) => request<RouteDecision>("POST", "/v1/routes/compare", { corridorId: CORRIDOR_ID, ...req }),
  weather: () => request<Weather>("GET", "/v1/weather"),
  geocode: (q: string) =>
    request<{ results: { name: string; address: string; coordinates: [number, number] }[]; attribution: string }>(
      "GET", `/v1/geocode?q=${encodeURIComponent(q)}`),
  draft: (text: string, contributor: string) =>
    request<ReportDraft>("POST", "/v1/report-drafts", { text }, { "x-demo-contributor": contributor }),
  submit: (body: ObservationRequest, contributor: string) =>
    request<ObservationResult>("POST", "/v1/observations", body, { "x-demo-contributor": contributor }),
};
