/** API contract types (schema 1.0). Mirrors backend/src/service.py and domain/*. */

export type HazardStateName =
  | "UNKNOWN"
  | "REPORTED"
  | "CORROBORATED"
  | "CONFLICTED"
  | "STALE"
  | "RECENTLY_CLEAR_REPORTED";

export type ObservationKind = "WATER_OBSERVED" | "ROAD_BLOCKED_REPORTED" | "NO_WATER_OBSERVED" | "UNSURE";

export type ClientMode = "LOCAL_DEMO" | "AWS_DEMO" | "LIVE_PILOT";

export interface Status {
  build: string;
  appMode: string;
  clientMode: ClientMode;
  modeLabel: string;
  provenance: string;
  serverTime: string;
  policyVersion: string;
  freshnessMinutes: number;
  pollSeconds: number;
  capabilities: { routing: string; reviewerActions: boolean; textExtraction: string; weather: string; dynamicRouting?: string };
  demo: { clockOffsetMinutes: number; simulateRouteProviderFailure: boolean } | null;
}

export interface Evaluation {
  state: HazardStateName;
  reasonCode: string;
  restricts: boolean;
  policyVersion: string;
  evaluatedAt: string;
  freshSources: { positive: number; negative: number };
  effectiveObservationIds: string[];
  lastKnownPositiveAt: string | null;
  latestObservationAt: string | null;
  clearReviewedAt: string | null;
  nextTransitionAt: string | null;
}

export type DepthLevel = "ankle" | "knee" | "waist" | "submerged";

/** User claims attached to the evidence in effect - never measurements. */
export interface Claims {
  highestDepthClaim: DepthLevel | null;
  depthClaimCount: number;
  stalledVehiclesClaimedMax: number | null;
  basis: "user_claim";
}

export interface HazardItem extends Evaluation {
  hotspotId: string;
  displayName: string;
  revision: number;
  claims: Claims;
}

export interface HazardsSnapshot {
  generatedAt: string;
  modeLabel: string;
  provenance: string;
  hazards: HazardItem[];
}

export interface LineString {
  type: "LineString";
  coordinates: [number, number][];
}

export interface HotspotFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
  properties: {
    id: string;
    displayName: string;
    displayNameHi: string;
    roadLevel: string;
    verification: string;
    geometrySource: string;
    reviewNotes: string;
    centroid: [number, number];
    bypassAnchors?: { name: string; coordinates: [number, number] }[];
  };
}

export interface Place {
  name: string;
  coordinates: [number, number];
}

export interface HotspotsView {
  corridor: {
    corridorId: string;
    displayName: string;
    geometryVersion: string;
    provider: string;
    profile: string;
    retrievedAt: string;
    verification: string;
    reviewNotes: string;
  };
  pairs: { id: string; origin: Place; destination: Place }[];
  hotspots: { type: "FeatureCollection"; features: HotspotFeature[] };
  landmarks: { name: string; nameHi: string; coordinates: [number, number] }[];
  pilotRadiusM: number;
}

export interface RejectionReason {
  code: string;
  hotspotId?: string;
  state?: HazardStateName;
}

export interface RouteStep {
  instruction: string;
  name: string;
  type: string;
  modifier: string | null;
  location: [number, number];
  distanceM: number;
  durationS: number;
  lanes: { indications: string[]; valid: boolean }[] | null;
}

export type Vehicle = "two_wheeler" | "auto" | "car" | "suv" | "ev";

export interface RouteOption {
  steps: RouteStep[];
  id: string;
  label: string;
  roadNames: string[];
  geometry: LineString;
  distanceM: number;
  durationS: number;
  source: string;
  sourceTime: string;
  admissible: boolean;
  rejectionReasons: RejectionReason[];
}

export interface RouteDecision {
  decisionId: string;
  dataMode: string;
  snapshotId: string;
  revisions: Record<string, number>;
  states: Record<string, { state: HazardStateName; reasonCode: string }>;
  generatedAt: string;
  validUntil: string;
  coverage: {
    corridorId: string;
    label: string;
    geometryVersion: string;
    geometryVerification: string;
    assessedHotspots: string[];
    note: string;
  };
  pairId: string;
  baselineRouteId: string;
  selectedRouteId: string | null;
  extraMetres: number | null;
  extraSeconds: number | null;
  routes: RouteOption[];
  rejectedCandidates: { id: string; reasons: RejectionReason[] }[];
  explanationCodes: string[];
  vehicle: Vehicle;
  claims: Record<string, Claims>;
}

export interface CompareRequest {
  routePairId?: string;
  origin?: [number, number];
  destination?: [number, number];
  vehicle: Vehicle;
  /** Points where this rider's camera flagged possible water. Personal, never stored. */
  avoid?: [number, number][];
  /** Turn instruction language for live routes. */
  lang?: "en" | "hi";
}

export interface ReportDraft {
  method: "bedrock" | "rules";
  modelId: string | null;
  fallbackReason: string | null;
  location_matched: string | null;
  locationCandidates: string[];
  water_detected: boolean;
  negated: boolean;
  suggestedKind: ObservationKind;
  temporalReference: string;
  user_claimed_depth: { phrase: string; value: number | null; unit: string | null; level: DepthLevel | null } | null;
  needs_clarification: boolean;
  clarificationReasons: string[];
  inPilot: boolean;
  note: string;
}

export interface Weather {
  available: boolean;
  message?: string;
  provider?: string;
  kind?: string;
  currentPrecipitationMm?: number;
  currentIntervalS?: number;
  currentTime?: string;
  next3hPrecipitationMm?: number[];
  advisory?: boolean;
  note?: string;
}

export interface ObservationRequest {
  schemaVersion: "1.0";
  eventId: string;
  hotspotId: string;
  kind: ObservationKind;
  observedAt: string;
  location: { source: "selected_hotspot"; accuracyM: null };
  description: string | null;
  depthClaim?: { level: DepthLevel; sourcePhrase: string } | { value: number; unit: string; sourcePhrase: string } | null;
  stalledVehicles?: number | null;
  clientMode: ClientMode;
}

export interface ObservationResult {
  eventId: string;
  duplicate: boolean;
  hotspotId: string;
  revision: number;
  state: HazardStateName;
  reasonCode: string;
  receivedAt: string;
  provenance: string;
}

export interface EvidenceRow {
  eventId: string;
  kind: ObservationKind;
  observedAt: string;
  receivedAt: string;
  provenance: string;
  source: string;
  effective: boolean;
  fresh: boolean;
  description: string | null;
}

export interface EvidenceView extends Evaluation {
  hotspotId: string;
  revision: number;
  clearReview: { reviewedAt: string; reason: string; reviewer: string } | null;
  observations: EvidenceRow[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; retryable: boolean; requestId: string };
}

export const CORRIDOR_ID = "MINTO_CP";
