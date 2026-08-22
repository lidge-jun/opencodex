/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import StorageWorkspace, { type StorageReport } from "../src/components/storage-workspace/StorageWorkspace";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let active: Root | null = null;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (active) {
    const root = active;
    active = null;
    await act(async () => { root.unmount(); });
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function report(reclaimableBytes = 65536): StorageReport {
  return {
    codexHome: "/home/user/.codex",
    generatedAt: 1,
    total: { bytes: 1024, fileCount: 1 },
    buckets: [],
    codexLogs: {
      generatedAt: 1,
      externalSqliteHome: false,
      snapshot: "checkpointed",
      files: { databaseBytes: 8192, walBytes: 0, shmBytes: 0 },
      schema: { state: "compatible" },
      capabilities: {
        inspection: { state: "supported" },
        protection: { state: "supported" },
        reclaim: { state: "supported" },
      },
      protection: { desiredMode: "off", observedMode: "off", state: "off" },
      metrics: {
        totalRows: 10,
        rowsByLevel: { INFO: 10 },
        traceRows: 0,
        traceShare: 0,
        topTargets: [],
        pageSize: 4096,
        pageCount: 100,
        freelistPages: reclaimableBytes === 0 ? 0 : 16,
        reclaimableBytes,
        estimatedLogBytes: null,
      },
    },
  } satisfies StorageReport;
}

async function mount(
  value: StorageReport,
  onAction?: (action: unknown) => void,
  logGuardBusy = false,
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  active = root;
  await act(async () => {
    root.render(
      <LanguageProvider>
        <StorageWorkspace
          report={value}
          locale="en"
          logGuardBusy={logGuardBusy}
          onLogGuardAction={onAction}
        />
      </LanguageProvider>,
    );
  });
  return container;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click(); });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => testWindow.setTimeout(resolve, 0));
  });
}

test("compact requires an explicit second confirmation before emitting the mutation action", async () => {
  const actions: unknown[] = [];
  const container = await mount(report(), action => actions.push(action));

  const compact = container.querySelector<HTMLElement>('[data-testid="log-guard-compact"]');
  expect(compact).not.toBeNull();
  if (!compact) return;
  await click(compact);
  expect(actions).toEqual([]);

  const confirm = container.querySelector<HTMLElement>('[data-testid="log-guard-compact-confirm"]');
  expect(confirm).not.toBeNull();
  if (!confirm) return;
  await click(confirm);
  expect(actions).toEqual([{ action: "compact" }]);
});

test("successful compact remains successful when the status refresh fails", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/storage/codex-logs/compact")) {
      return Response.json({ report: { stopReason: "complete" } });
    }
    if (url.endsWith("/api/storage/codex-logs")) {
      return new Response("refresh unavailable", { status: 503 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const container = await mount(report());
  const compact = container.querySelector<HTMLElement>('[data-testid="log-guard-compact"]');
  expect(compact).not.toBeNull();
  if (!compact) return;
  await click(compact);

  const confirm = container.querySelector<HTMLElement>('[data-testid="log-guard-compact-confirm"]');
  expect(confirm).not.toBeNull();
  if (!confirm) return;
  await click(confirm);
  await settle();

  expect(calls).toEqual([
    "POST /api/storage/codex-logs/compact",
    "GET /api/storage/codex-logs",
  ]);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("shared busy state uses action-neutral Log Guard text", async () => {
  const container = await mount(report(), undefined, true);
  expect(container.textContent).toContain("Applying Log Guard change…");
  expect(container.textContent).not.toContain("Applying protection");
});

test("compact errors do not claim that protection failed", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/storage/codex-logs/compact")) {
      return Response.json({ error: "unsupported_schema" }, { status: 409 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const container = await mount(report());
  const compact = container.querySelector<HTMLElement>('[data-testid="log-guard-compact"]');
  expect(compact).not.toBeNull();
  if (!compact) return;
  await click(compact);

  const confirm = container.querySelector<HTMLElement>('[data-testid="log-guard-compact-confirm"]');
  expect(confirm).not.toBeNull();
  if (!confirm) return;
  await click(confirm);
  await settle();

  const alert = container.querySelector<HTMLElement>('[role="alert"]');
  expect(alert?.textContent).toContain("not supported for this operation");
  expect(alert?.textContent).not.toContain("protection");
});

test("compact is hidden when the snapshot reports no reclaimable space", async () => {
  const container = await mount(report(0), () => {});
  expect(container.querySelector('[data-testid="log-guard-compact"]')).toBeNull();
});

test("compact is hidden when reclaim is unsupported", async () => {
  const value = report();
  value.codexLogs = {
    ...value.codexLogs!,
    capabilities: {
      ...value.codexLogs!.capabilities,
      reclaim: { state: "unsupported", reason: "unknown_schema" },
    },
  };
  const container = await mount(value, () => {});
  expect(container.querySelector('[data-testid="log-guard-compact"]')).toBeNull();
});

test("a successful compaction shows its report even when the refresh fails", async () => {
  // The mutation already succeeded, so its outcome must survive a failed GET.
  // pagesReclaimed and stopReason are included because bytes alone leave one
  // partial run indistinguishable from another (page_budget vs no_progress vs busy).
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/storage/codex-logs/compact")) {
      return Response.json({
        report: {
          pagesReclaimed: 318,
          logicalBytesReclaimed: 1302528,
          physicalDatabaseBytesReclaimed: 0,
          complete: false,
          stopReason: "page_budget",
        },
      });
    }
    return new Response("refresh unavailable", { status: 503 });
  }) as typeof fetch;

  const container = await mount(report());
  const compact = container.querySelector<HTMLElement>('[data-testid="log-guard-compact"]');
  if (!compact) throw new Error("compact button missing");
  await click(compact);
  const confirm = container.querySelector<HTMLElement>('[data-testid="log-guard-compact-confirm"]');
  if (!confirm) throw new Error("confirm button missing");
  await click(confirm);
  await settle();

  const result = container.querySelector('[data-testid="log-guard-compact-result"]');
  expect(result).not.toBeNull();
  expect(result?.textContent).toContain("318");
  expect(result?.textContent).toContain("page_budget");
});

test("the compaction report survives a refresh that retires the reclaim section", async () => {
  // A fully successful compaction drives reclaimableBytes to 0, which removes
  // the reclaim section. Nesting the result inside it hid the outcome in exactly
  // the best case.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/storage/codex-logs/compact")) {
      return Response.json({
        report: {
          pagesReclaimed: 512,
          logicalBytesReclaimed: 2097152,
          physicalDatabaseBytesReclaimed: 2097152,
          complete: true,
          stopReason: "complete",
        },
      });
    }
    return Response.json(report(0).codexLogs);
  }) as typeof fetch;

  const container = await mount(report());
  const compact = container.querySelector<HTMLElement>('[data-testid="log-guard-compact"]');
  if (!compact) throw new Error("compact button missing");
  await click(compact);
  const confirm = container.querySelector<HTMLElement>('[data-testid="log-guard-compact-confirm"]');
  if (!confirm) throw new Error("confirm button missing");
  await click(confirm);
  await settle();

  // The reclaim section is gone, but the result must not be.
  expect(container.querySelector('[data-testid="log-guard-reclaim"]')).toBeNull();
  const result = container.querySelector('[data-testid="log-guard-compact-result"]');
  expect(result).not.toBeNull();
  expect(result?.textContent).toContain("512");
});

test("a failed retry clears the previous success receipt", async () => {
  // A stale receipt rendered alongside the current error made the section
  // misreport the latest attempt.
  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/storage/codex-logs/compact")) {
      call += 1;
      return call === 1
        ? Response.json({ report: { pagesReclaimed: 7, logicalBytesReclaimed: 28672, physicalDatabaseBytesReclaimed: 0, complete: false, stopReason: "page_budget" } })
        : Response.json({ error: "busy" }, { status: 409 });
    }
    return new Response("refresh unavailable", { status: 503 });
  }) as typeof fetch;

  const container = await mount(report());
  const runCompact = async () => {
    const compact = container.querySelector<HTMLElement>('[data-testid="log-guard-compact"]');
    if (!compact) throw new Error("compact button missing");
    await click(compact);
    const confirm = container.querySelector<HTMLElement>('[data-testid="log-guard-compact-confirm"]');
    if (!confirm) throw new Error("confirm button missing");
    await click(confirm);
    await settle();
  };

  await runCompact();
  expect(container.querySelector('[data-testid="log-guard-compact-result"]')).not.toBeNull();

  await runCompact();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="log-guard-compact-result"]')).toBeNull();
});
