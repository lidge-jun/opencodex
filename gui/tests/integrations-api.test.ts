import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nContext, type TFn } from "../src/i18n/shared";
import IntegrationStateBadge from "../src/pages/integrations/IntegrationStateBadge";
import {
  FILE_INTEGRATION_CLIENTS,
  IntegrationApiError,
  loadIntegrationJournal,
  loadIntegrationState,
  loadIntegrationStates,
  restoreIntegration,
  toggleIntegration,
  type IntegrationJournalEnvelope,
} from "../src/pages/integrations/integration-api";

const originalFetch = globalThis.fetch;

test("DSH is a file integration client", () => {
  expect(FILE_INTEGRATION_CLIENTS).toEqual([
    "opencode", "pi", "omp", "hermes", "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode", "prime",
  ]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("GET adapters preserve the server state and journal contracts", async () => {
  const controller = new AbortController();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const journal: IntegrationJournalEnvelope = {
    operations: [{
      opId: "op-1",
      clientId: "hermes",
      kind: "restore",
      at: "2026-08-02T10:00:00.000Z",
      configPath: "/tmp/hermes.yaml",
      snapshot: "expired",
      undoable: false,
    }],
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/journal?client=hermes")) return Response.json(journal);
    if (url.endsWith("/hermes")) {
      return Response.json({
        clientId: "hermes",
        state: "unsafe",
        installed: true,
        configPath: "/tmp/hermes.yaml",
        reason: "unparseable",
        snapshotCount: 2,
        retentionDegraded: true,
      });
    }
    return Response.json({ clients: [] });
  }) as typeof fetch;

  const list = await loadIntegrationStates("/management", controller.signal);
  const state = await loadIntegrationState("/management", "hermes", controller.signal);
  const operations = await loadIntegrationJournal("/management", "hermes", controller.signal);

  expect(list).toEqual({ clients: [] });
  expect(state).toMatchObject({ state: "unsafe", reason: "unparseable", retentionDegraded: true });
  expect(operations).toEqual(journal);
  expect(requests.map(request => request.url)).toEqual([
    "/management/api/client-integrations",
    "/management/api/client-integrations/hermes",
    "/management/api/client-integrations/journal?client=hermes",
  ]);
  expect(requests.every(request => request.init?.signal === controller.signal)).toBe(true);
});

test("mutation adapters send the exact WP4 methods and bodies", async () => {
  const controller = new AbortController();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({
      ok: true,
      clientId: "pi",
      changed: true,
      state: "current",
      opId: "op-2",
      message: "ok",
    });
  }) as typeof fetch;

  await toggleIntegration("", "pi", true, controller.signal);
  await restoreIntegration("", "op-2", true, controller.signal);

  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({ url: "/api/client-integrations/pi" });
  expect(requests[0].init).toMatchObject({
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
    signal: controller.signal,
  });
  expect(new Headers(requests[0].init?.headers).get("Content-Type")).toBe("application/json");
  expect(requests[1]).toMatchObject({ url: "/api/client-integrations/restore" });
  expect(requests[1].init).toMatchObject({
    method: "POST",
    body: JSON.stringify({ opId: "op-2", confirmDrift: true }),
    signal: controller.signal,
  });
});

test("refusals route by reason and preserve manual recovery fields end to end", async () => {
  globalThis.fetch = (async () => Response.json({
    error: "integration mutation failed",
    code: "integration_mutation_failed",
    clientId: "opencode",
    state: "conflict",
    reason: "write_failed",
    message: "write failed after the snapshot was stored",
    snapshotPath: "/tmp/opencodex-snapshots/op-3.json",
    residual: true,
  }, { status: 500 })) as typeof fetch;

  const error = await toggleIntegration("", "opencode", false).catch(cause => cause);

  expect(error).toBeInstanceOf(IntegrationApiError);
  expect(error).toMatchObject({
    status: 500,
    message: "write failed after the snapshot was stored",
    refusal: {
      reason: "write_failed",
      state: "conflict",
      message: "write failed after the snapshot was stored",
      snapshotPath: "/tmp/opencodex-snapshots/op-3.json",
      residual: true,
    },
  });
  expect((error as IntegrationApiError).body.snapshotPath)
    .toBe("/tmp/opencodex-snapshots/op-3.json");
});

const BADGE_LABELS: Record<string, string> = {
  "integrations.state.notInstalled": "Not installed",
  "integrations.state.absent": "Not applied",
  "integrations.state.current": "Applied",
  "integrations.state.stale": "Update needed",
  "integrations.state.conflict": "Conflict",
  "integrations.state.unsafe": "Cannot verify",
};
const badgeT = ((key: string) => BADGE_LABELS[key] ?? key) as TFn;

test("the state badge exposes text shape and non-color semantics for every visual state", () => {
  const fixtures = [
    { state: "current", installed: false, visual: "not-installed", label: "Not installed", className: "badge-muted" },
    { state: "absent", installed: true, visual: "absent", label: "Not applied", className: "badge-muted" },
    { state: "current", installed: true, visual: "current", label: "Applied", className: "badge-green" },
    { state: "stale", installed: true, visual: "stale", label: "Update needed", className: "badge-amber" },
    { state: "conflict", installed: true, visual: "conflict", label: "Conflict", className: "integration-badge--danger" },
    { state: "unsafe", installed: true, visual: "unsafe", label: "Cannot verify", className: "integration-badge--danger-outline" },
  ] as const;

  for (const fixture of fixtures) {
    const markup = renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { locale: "en", setLocale: () => {}, t: badgeT } },
        createElement(IntegrationStateBadge, {
          id: `badge-${fixture.visual}`,
          state: fixture.state,
          installed: fixture.installed,
        }),
      ),
    );
    expect(markup).toContain(`id="badge-${fixture.visual}"`);
    expect(markup).toContain(`data-integration-state="${fixture.visual}"`);
    expect(markup).toContain(fixture.className);
    expect(markup).toContain(`>${fixture.label}</span>`);
  }
});
