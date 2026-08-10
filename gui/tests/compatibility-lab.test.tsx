/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import CompatibilityMatrix from "../src/pages/CompatibilityMatrix";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import {
  buildMatrixRows,
  filterVerdicts,
  parseArtifactMetadata,
  parseEventsPage,
  parseLabEvent,
  parseObservationDto,
  parseSubjectDetail,
  parseVerdictPage,
  shortSubjectId,
  verdictQueryFromFilters,
} from "../src/pages/compatibility-matrix-shared";
import {
  fetchAllSubjects,
  fetchLabStatus,
  fetchVerdictDetail,
  LabDataContractError,
} from "../src/pages/compatibility-matrix-api";
import { modelsTabHash, readModelsTab } from "../src/pages/models-tab";
import { resolveAppHashChange } from "../src/app-routing";

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;
let testWindow: Window;

const API_BASE = "http://127.0.0.1:4096";

const STATUS_AVAILABLE = {
  projectionAvailable: true,
  subjectCount: 2,
  verdictCount: 3,
  observationCount: 4,
  eventCount: 5,
  builtAtMs: 1_700_000_000_000,
};

const VERDICTS_PAGE_1 = {
  verdicts: [
    {
      projectionKey: "k1",
      subjectId: "subject-alpha",
      evidenceLayer: "protocol_conformance",
      suiteId: "responses-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest-a",
      projectionSpecVersion: "cl-02.v1",
      verdict: "VERIFIED",
      asOf: 1_700_000_000_100,
      scenarioManifestDigests: ["scenario-digest"],
      claimSourceDigest: null,
      contributingEventIds: ["e1"],
      contradictingEventIds: [],
      notes: [],
    },
    {
      projectionKey: "k2",
      subjectId: "subject-alpha",
      evidenceLayer: "live_route_compatibility",
      suiteId: "live-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest-b",
      projectionSpecVersion: "cl-02.v1",
      verdict: "PROBED",
      asOf: 1_700_000_000_200,
      scenarioManifestDigests: [],
      claimSourceDigest: null,
      contributingEventIds: ["e2"],
      contradictingEventIds: [],
      notes: [],
    },
  ],
  hasMore: true,
  nextCursor: "cursor-2",
};

const VERDICTS_PAGE_2 = {
  verdicts: [
    {
      projectionKey: "k3",
      subjectId: "subject-beta",
      evidenceLayer: "task_effectiveness",
      suiteId: "task-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest-c",
      projectionSpecVersion: "cl-02.v1",
      verdict: "BLOCKED",
      asOf: 1_700_000_000_300,
      scenarioManifestDigests: [],
      claimSourceDigest: null,
      contributingEventIds: [],
      contradictingEventIds: [],
      notes: [],
    },
  ],
  hasMore: false,
};

const SUBJECTS = {
  subjects: [
    { subjectId: "subject-alpha", subjectKind: "protocol" },
    { subjectId: "subject-beta", subjectKind: "route" },
  ],
  hasMore: false,
};

const SUBJECT_DETAIL = {
  subject: {
    subjectKind: "protocol",
    subjectSchemaVersion: 1,
    inboundProtocol: "openai-chat",
  },
};

const OBSERVATIONS = {
  observations: [
    {
      eventId: "obs-1",
      subjectId: "subject-alpha",
      evidenceLayer: "protocol_conformance",
      suiteId: "responses-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest-a",
      scenarioId: "scenario-1",
      scenarioVersion: "1",
      scenarioManifestDigest: "scenario-digest",
      outcome: "pass",
      completedAt: 1_700_000_000_050,
      executionMode: "fixture",
      excluded: false,
      exclusionReason: null,
    },
  ],
  hasMore: false,
};

const EVENT_DETAIL = {
  event: {
    eventKind: "observation",
    eventId: "e1",
    recordedAt: 1_700_000_000_040,
    producer: "lab",
    producerVersion: "1",
    subjectId: "subject-alpha",
    evidenceLayer: "protocol_conformance",
    suiteId: "responses-core",
    outcome: "pass",
    excluded: false,
    exclusionReason: null,
  },
};

const ARTIFACT_DETAIL = {
  artifact: {
    digest: "digest-a",
    artifactClass: "suite_manifest",
    mediaType: "application/json",
    byteCount: 120,
    status: "present",
    lastError: null,
  },
};

type FetchOptions = {
  unavailable?: boolean;
  incompatible?: boolean;
  empty?: boolean;
  malformedVerdicts?: boolean;
  trackRequests?: string[];
};

function installLabFetch(opts: FetchOptions = {}) {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") return new Response("method not allowed", { status: 405 });
    requests.push(url);
    opts.trackRequests?.push(url);

    if (url.endsWith("/api/lab/status")) {
      if (opts.incompatible) return Response.json({ projectionAvailable: true, projectionIncompatible: true });
      if (opts.unavailable) return Response.json({ projectionAvailable: false });
      return Response.json(STATUS_AVAILABLE);
    }
    if (url.includes("/api/lab/verdicts")) {
      if (opts.malformedVerdicts) return Response.json({ verdicts: [{ subjectId: "x" }] });
      if (opts.empty) return Response.json({ verdicts: [], hasMore: false });
      if (url.includes("cursor=cursor-2")) return Response.json(VERDICTS_PAGE_2);
      return Response.json(VERDICTS_PAGE_1);
    }
    if (url.includes("/api/lab/subjects/subject-alpha")) return Response.json(SUBJECT_DETAIL);
    if (url.includes("/api/lab/subjects")) return Response.json(SUBJECTS);
    if (url.includes("/api/lab/observations")) return Response.json(OBSERVATIONS);
    if (url.includes("/api/lab/events/e1")) return Response.json(EVENT_DETAIL);
    if (url.includes("/api/lab/events/e2")) return Response.json({ event: { ...EVENT_DETAIL.event, eventId: "e2" } });
    if (url.includes("/api/lab/artifacts/digest-a")) return Response.json(ARTIFACT_DETAIL);
    if (url.includes("/api/lab/artifacts/scenario-digest")) {
      return Response.json({ artifact: { ...ARTIFACT_DETAIL.artifact, digest: "scenario-digest", artifactClass: "scenario_manifest" } });
    }
    if (url.includes("/api/models")) return Response.json([]);
    if (url.includes("/api/provider-context-caps")) return Response.json({ providers: {} });
    if (url.includes("/api/providers")) return Response.json([]);
    if (url.includes("/api/selected-models")) return Response.json({});
    if (url.includes("/api/combos")) return Response.json([]);
    if (url.includes("/api/config")) return Response.json(null);
    if (url.includes("/api/routing-profiles")) return Response.json([]);
    if (url.includes("/api/routing-analytics")) return Response.json(null);
    if (url.includes("/api/shadow-call-settings")) return Response.json({ enabled: false });
    if (url.includes("/api/v2")) return new Response(null, { status: 404 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { requests };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/#models" });
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const keys = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as Record<(typeof keys)[number], PropertyDescriptor | undefined>;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  restoreGlobals = () => {
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    if (previousLanguageDescriptor) Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
  };
});

afterEach(() => {
  restoreGlobals?.();
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
  }
}

async function renderMatrix(active = true): Promise<{ root: Root; container: HTMLDivElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<LanguageProvider><CompatibilityMatrix apiBase={API_BASE} active={active} /></LanguageProvider>);
  });
  return { root, container };
}

async function mountModels(hash = "#models"): Promise<{ root: Root; container: HTMLDivElement }> {
  testWindow.location.hash = hash;
  const { createRoot } = await import("react-dom/client");
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<LanguageProvider><Models apiBase={API_BASE} /></LanguageProvider>); });
  await act(async () => { await Promise.resolve(); });
  return { root, container };
}

function detailButton(container: HTMLDivElement, key = "k1"): HTMLButtonElement {
  return container.querySelector(`button[data-verdict-detail="${key}"]`) as HTMLButtonElement;
}

test("1. Models tab includes Compatibility", async () => {
  installLabFetch();
  const { root, container } = await mountModels();
  try { expect(container.querySelector("#models-tab-compatibility")).toBeTruthy(); }
  finally { await act(async () => root.unmount()); }
});

test("2. #models/compatibility resolves", () => {
  expect(readModelsTab("#models/compatibility")).toBe("compatibility");
  expect(modelsTabHash("compatibility")).toBe("models/compatibility");
  expect(resolveAppHashChange("models/compatibility").replaceTo).toBeNull();
});

test("3. refresh/bookmark behavior via models-tab roundtrip", () => {
  expect(resolveAppHashChange("lab").replaceTo).toBe("models/compatibility");
  expect(readModelsTab("#lab")).toBe("compatibility");
});

test("4. keyboard traversal covers four tabs in strip", async () => {
  installLabFetch();
  const { root, container } = await mountModels();
  try {
    const tabs = [...container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(tabs).toHaveLength(4);
    const routing = container.querySelector("#models-tab-routing") as HTMLButtonElement;
    await act(async () => { routing.click(); });
    routing.focus();
    await act(async () => { routing.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(document.activeElement?.id).toBe("models-tab-compatibility");
  } finally { await act(async () => root.unmount()); }
});

test("5. available projection renders data", async () => {
  installLabFetch();
  const { root, container } = await renderMatrix();
  await waitFor(() => container.textContent?.includes("Verified") ?? false);
  expect(container.querySelector(".lab-matrix tbody tr")).not.toBeNull();
  await act(async () => root.unmount());
});

test("6. unavailable projection is not shown as empty matrix", async () => {
  installLabFetch({ unavailable: true });
  const { root, container } = await renderMatrix();
  await waitFor(() => container.textContent?.includes("not available") ?? false);
  expect(container.querySelector(".lab-matrix")).toBeNull();
  await act(async () => root.unmount());
});

test("7. incompatible projection shows distinct state", async () => {
  installLabFetch({ incompatible: true });
  const { root, container } = await renderMatrix();
  await waitFor(() => container.textContent?.includes("incompatible") ?? false);
  expect(container.querySelector(".lab-matrix")).toBeNull();
  await act(async () => root.unmount());
});

test("8. empty projection shows empty state", async () => {
  installLabFetch({ empty: true });
  const { root, container } = await renderMatrix();
  await waitFor(() => container.textContent?.includes("No compatibility verdicts") ?? false);
  await act(async () => root.unmount());
});

test("9. verdict text rendering", async () => {
  installLabFetch();
  const { root, container } = await renderMatrix();
  await waitFor(() => container.textContent?.includes("Probed") ?? false);
  expect(container.textContent).toContain("Verified");
  await act(async () => root.unmount());
});

test("10. evidence layers render as separate columns", () => {
  const page = parseVerdictPage(VERDICTS_PAGE_1);
  const rows = buildMatrixRows(page.verdicts, SUBJECTS.subjects);
  expect(rows[0]!.byLayer.protocol_conformance).toHaveLength(1);
  expect(rows[0]!.byLayer.live_route_compatibility).toHaveLength(1);
  expect(rows[0]!.byLayer.task_effectiveness).toHaveLength(0);
});

test("11. exact subject picker filters through the API contract", () => {
  const query = verdictQueryFromFilters({
    layer: "protocol_conformance",
    verdict: "VERIFIED",
    subjectQuery: "subject-alpha",
    suiteId: "responses-core",
  });
  expect(query).toEqual({
    layer: "protocol_conformance",
    verdict: "VERIFIED",
    subjectId: "subject-alpha",
    suiteId: "responses-core",
  });
});

test("12. load more pagination appends rows", async () => {
  installLabFetch();
  const { root, container } = await renderMatrix();
  await waitFor(() => container.querySelector(".lab-load-more button") !== null);
  await act(async () => { (container.querySelector(".lab-load-more button") as HTMLButtonElement).click(); });
  await waitFor(() => container.textContent?.includes("Blocked") ?? false);
  await act(async () => root.unmount());
});

test("13. detail flow on selection uses a neutral evidence heading", async () => {
  installLabFetch();
  const { root, container } = await renderMatrix();
  await waitFor(() => detailButton(container) !== null);
  await act(async () => { detailButton(container).click(); });
  await waitFor(() => container.querySelector(".lab-detail-pane") !== null && !container.textContent?.includes("Loading…"));
  expect(container.textContent).toContain("Evidence events");
  await act(async () => root.unmount());
});

test("14. sanitized display has no payload_json fields", () => {
  expect(parseVerdictPage({ verdicts: [{ subjectId: "x", payload_json: "{}" }] }).verdicts).toEqual([]);
  const event = parseLabEvent({ event: { ...EVENT_DETAIL.event, payload_json: "{}" } });
  expect(event).not.toHaveProperty("payload_json");
});

test("15. artifact metadata only in detail pane", async () => {
  installLabFetch();
  const { root, container } = await renderMatrix();
  await waitFor(() => detailButton(container) !== null);
  await act(async () => { detailButton(container).click(); });
  await waitFor(() => container.textContent?.includes("Artifact metadata") ?? false);
  expect(container.textContent).toContain("suite_manifest");
  expect(container.textContent).toContain("Present");
  await act(async () => root.unmount());
});

test("16. inactive panel suppresses deferred and scheduled loads", async () => {
  const tracked: string[] = [];
  installLabFetch({ trackRequests: tracked });
  const { root } = await renderMatrix(false);
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });
  }
  expect(tracked.filter(url => url.includes("/api/lab/")).length).toBe(0);
  await act(async () => root.unmount());
});

test("17. malformed parser payloads fail safely", () => {
  expect(parseVerdictPage(null).verdicts).toEqual([]);
  expect(parseSubjectDetail(null)).toBeNull();
  expect(parseObservationDto({ eventId: "x" })).toBeNull();
  expect(parseArtifactMetadata({ artifact: { digest: "x" } })).toBeNull();
  expect(shortSubjectId("abc")).toBe("abc");
});

test("18. no mutation requests are issued", async () => {
  const methods: string[] = [];
  installLabFetch();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    methods.push(init?.method ?? "GET");
    return original(input, init);
  }) as typeof fetch;
  const { root, container } = await renderMatrix();
  await waitFor(() => detailButton(container) !== null);
  expect(methods.every(method => method === "GET")).toBe(true);
  await act(async () => root.unmount());
});

test("19. selecting a verdict does not silently narrow the matrix to one suite", async () => {
  const { requests } = installLabFetch();
  const { root, container } = await renderMatrix();
  await waitFor(() => detailButton(container) !== null);
  const before = container.querySelectorAll(".lab-matrix tbody tr").length;
  const beforeRequests = requests.length;
  await act(async () => { detailButton(container).click(); });
  await waitFor(() => container.querySelector(".lab-detail-pane") !== null);
  const selectionRequests = requests.slice(beforeRequests);
  expect(selectionRequests.some(url => url.includes("/api/lab/verdicts") && url.includes("suiteId="))).toBe(false);
  expect(container.querySelectorAll(".lab-matrix tbody tr").length).toBe(before);
  await act(async () => root.unmount());
});

test("20. malformed successful API payloads reject instead of impersonating unavailable data", async () => {
  globalThis.fetch = (async () => Response.json({ nope: true })) as typeof fetch;
  const controller = new AbortController();
  await expect(fetchLabStatus(API_BASE, controller.signal)).rejects.toBeInstanceOf(LabDataContractError);
});

test("21. subject pagination fails closed when the cursor does not advance", async () => {
  globalThis.fetch = (async () => Response.json({
    subjects: [{ subjectId: "subject-alpha", subjectKind: "protocol" }],
    hasMore: true,
    nextCursor: "same",
  })) as typeof fetch;
  const controller = new AbortController();
  await expect(fetchAllSubjects(API_BASE, controller.signal)).rejects.toBeInstanceOf(LabDataContractError);
});

test("22. verdict detail follows observation pagination and tolerates missing optional evidence", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/subjects/subject-alpha")) return Response.json(SUBJECT_DETAIL);
    if (url.includes("/observations") && url.includes("cursor=obs-2")) {
      return Response.json({ observations: [{ ...OBSERVATIONS.observations[0], eventId: "obs-2", scenarioId: "scenario-2" }], hasMore: false });
    }
    if (url.includes("/observations")) return Response.json({ ...OBSERVATIONS, hasMore: true, nextCursor: "obs-2" });
    if (url.includes("/events/e1")) return new Response("gone", { status: 404 });
    if (url.includes("/artifacts/")) return new Response("gone", { status: 404 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const verdict = parseVerdictPage(VERDICTS_PAGE_1).verdicts[0]!;
  const detail = await fetchVerdictDetail(API_BASE, verdict, new AbortController().signal);
  expect(detail.observations.map(row => row.scenarioId)).toEqual(["scenario-1", "scenario-2"]);
  expect(detail.events).toEqual([]);
  expect(detail.artifacts).toEqual([]);
  expect(requests.some(url => url.includes("cursor=obs-2"))).toBe(true);
});

test("parseEventsPage rejects malformed payloads", () => {
  expect(parseEventsPage(null).events).toEqual([]);
});

test("filterVerdicts applies client filters for suite id", () => {
  const page = parseVerdictPage(VERDICTS_PAGE_1);
  const filtered = filterVerdicts(page.verdicts, { layer: "", verdict: "", subjectQuery: "", suiteId: "responses-core" });
  expect(filtered).toHaveLength(1);
});

test("23. a slower previous detail request cannot overwrite the latest selection", async () => {
  installLabFetch();
  const baseFetch = globalThis.fetch;
  let e1Requested = false;
  let releaseE1: (() => void) | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/lab/events/e1")) {
      e1Requested = true;
      return new Promise<Response>(resolve => {
        releaseE1 = () => resolve(Response.json(EVENT_DETAIL));
      });
    }
    return baseFetch(input, init);
  }) as typeof fetch;

  const { root, container } = await renderMatrix();
  await waitFor(() => container.querySelectorAll("button[data-verdict-detail]").length >= 2);
  const buttons = [...container.querySelectorAll("button[data-verdict-detail]")] as HTMLButtonElement[];
  await act(async () => { buttons[0]!.click(); });
  await waitFor(() => e1Requested);
  await act(async () => { buttons[1]!.click(); });
  await waitFor(() => container.querySelector(".lab-detail-pane")?.textContent?.includes("e2") ?? false);
  releaseE1?.();
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30));
  });
  const paneText = container.querySelector(".lab-detail-pane")?.textContent ?? "";
  expect(paneText).toContain("e2");
  expect(paneText).not.toContain("e1");
  await act(async () => root.unmount());
});

test("24. refreshing the first page discards appended cursor pages", async () => {
  installLabFetch();
  const { root, container } = await renderMatrix();
  await waitFor(() => container.querySelector(".lab-load-more button") !== null);
  await act(async () => { (container.querySelector(".lab-load-more button") as HTMLButtonElement).click(); });
  await waitFor(() => container.querySelectorAll(".lab-detail-table tbody tr").length === 3);
  const refresh = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Refresh"));
  expect(refresh).toBeTruthy();
  await act(async () => { refresh!.click(); });
  await waitFor(() => container.querySelectorAll(".lab-detail-table tbody tr").length === 2);
  expect(container.textContent).not.toContain("Blocked");
  await act(async () => root.unmount());
});
