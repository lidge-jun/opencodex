/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CompatibilityMatrix from "../src/pages/CompatibilityMatrix";
import { clearClientResourceStoresForTests } from "../src/client-resource";

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;
let testWindow: Window;

const API_BASE = "http://127.0.0.1:4096";

const STATUS_AVAILABLE = {
  projectionAvailable: true,
  subjectCount: 1,
  verdictCount: 1,
  observationCount: 0,
  eventCount: 2,
  builtAtMs: 1_700_000_000_000,
};

const SUBJECTS = {
  subjects: [{ subjectId: "subject-alpha", subjectKind: "protocol" }],
  hasMore: false,
};

const SUBJECT_DETAIL = {
  subject: {
    subjectKind: "protocol",
    subjectSchemaVersion: 1,
    inboundProtocol: "openai-chat",
  },
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

function verdictPage(eventIds: string[]) {
  return {
    verdicts: [{
      projectionKey: "k1",
      subjectId: "subject-alpha",
      evidenceLayer: "protocol_conformance",
      suiteId: "responses-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest-a",
      projectionSpecVersion: "cl-02.v1",
      verdict: "VERIFIED",
      asOf: 1_700_000_000_100,
      scenarioManifestDigests: [],
      claimSourceDigest: null,
      contributingEventIds: eventIds,
      contradictingEventIds: [],
      notes: [],
    }],
    hasMore: true,
    nextCursor: "cursor-2",
  };
}

type FetchOptions = {
  failLoadMoreOnce?: boolean;
  partialEvents?: boolean;
};

function installLabFetch(opts: FetchOptions = {}) {
  const requests: string[] = [];
  let loadMoreAttempts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/api/lab/status")) return Response.json(STATUS_AVAILABLE);
    if (url.includes("/api/lab/verdicts")) {
      if (url.includes("cursor=cursor-2")) {
        loadMoreAttempts += 1;
        if (opts.failLoadMoreOnce && loadMoreAttempts === 1) {
          return new Response("unavailable", { status: 503 });
        }
        return Response.json({ verdicts: [], hasMore: false });
      }
      return Response.json(verdictPage(opts.partialEvents ? ["e1", "missing-event"] : ["e1"]));
    }
    if (url.includes("/api/lab/subjects/subject-alpha")) return Response.json(SUBJECT_DETAIL);
    if (url.includes("/api/lab/subjects")) return Response.json(SUBJECTS);
    if (url.includes("/api/lab/observations")) return Response.json({ observations: [], hasMore: false });
    if (url.includes("/api/lab/events/e1")) return Response.json(EVENT_DETAIL);
    if (url.includes("/api/lab/events/missing-event")) return new Response("gone", { status: 404 });
    if (url.includes("/api/lab/artifacts/")) return new Response("gone", { status: 404 });
    if (url.includes("/api/lab/production-signals")) return new Response("gone", { status: 404 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { requests };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/#models/compatibility" });
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const keys = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(
    keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof keys)[number], PropertyDescriptor | undefined>;
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
    if (previousLanguageDescriptor) {
      Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
    }
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
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

async function renderMatrix(): Promise<{ root: Root; container: HTMLDivElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<LanguageProvider><CompatibilityMatrix apiBase={API_BASE} /></LanguageProvider>);
  });
  return { root, container };
}

test("load-more failures stay visible and a retry can recover", async () => {
  const { requests } = installLabFetch({ failLoadMoreOnce: true });
  const { root, container } = await renderMatrix();
  await waitFor(() => container.querySelector(".lab-load-more button") !== null);
  const button = container.querySelector(".lab-load-more button") as HTMLButtonElement;
  await act(async () => { button.click(); });
  await waitFor(() => container.querySelector(".notice-err")?.textContent?.includes(String(503)) ?? false);
  expect(container.textContent).toContain("Verified");
  expect(container.querySelector(".lab-load-more button")).not.toBeNull();

  await act(async () => {
    (container.querySelector(".lab-load-more button") as HTMLButtonElement).click();
  });
  await waitFor(() => container.querySelector(".notice-err") === null);
  await waitFor(() => container.querySelector(".lab-load-more button") === null);
  expect(requests.filter(url => url.includes("/api/lab/verdicts") && url.includes("cursor=cursor-2"))).toHaveLength(2);
  expect(container.textContent).toContain("Verified");
  await act(async () => root.unmount());
});

test("verdict detail reports when referenced evidence events are only partially available", async () => {
  installLabFetch({ partialEvents: true });
  const { root, container } = await renderMatrix();
  await waitFor(() => container.querySelector('button[data-verdict-detail="k1"]') !== null);
  const button = container.querySelector('button[data-verdict-detail="k1"]') as HTMLButtonElement;
  await act(async () => { button.click(); });
  await waitFor(() => container.querySelector(".lab-detail-pane")?.textContent?.includes("Evidence events (1/2)") ?? false);
  expect(container.querySelector(".lab-detail-pane")?.textContent).toContain("Evidence events (1/2)");
  await act(async () => root.unmount());
});
