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
  parseIntegrationMutationPlan,
  previewIntegrationMutation,
  previewIntegrationRestore,
  restoreIntegration,
  toggleIntegration,
  type IntegrationJournalEnvelope,
} from "../src/pages/integrations/integration-api";

const originalFetch = globalThis.fetch;

test("all registered export clients include Cline in file integrations", () => {
  expect(FILE_INTEGRATION_CLIENTS).toEqual([
    "opencode", "pi", "omp", "hermes", "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode", "prime", "aside", "raycast", "omo", "cline", "kilo",
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

const plan = {
  version: 1 as const,
  clientId: "pi" as const,
  operation: "apply" as const,
  state: "absent" as const,
  foreignEdit: "none" as const,
  changes: [
    { kind: "add" as const, path: "providers.opencodex" },
    { kind: "snapshot" as const, path: "$snapshot" },
    { kind: "ownership" as const, path: "$ownership" },
    { kind: "journal" as const, path: "$journal" },
  ],
  fingerprint: "p1:0123456789abcdef0123456789abcdef",
  canApply: true,
  willChange: true,
};

test("preview and mutation adapters send exact bound methods and bodies", async () => {
  const controller = new AbortController();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).includes("/preview")) return Response.json(String(input).includes("restore")
      ? { ...plan, operation: "restore", clientId: "pi" }
      : plan);
    return Response.json({
      ok: true,
      clientId: "pi",
      changed: true,
      state: "current",
      opId: "op-2",
      message: "ok",
    });
  }) as typeof fetch;

  const applyPlan = await previewIntegrationMutation("", "pi", "apply", controller.signal);
  const restorePlan = await previewIntegrationRestore("", "op-2", true, controller.signal);
  await toggleIntegration("", "pi", {
    enabled: true,
    signal: controller.signal,
    binding: { operation: applyPlan.operation, planFingerprint: applyPlan.fingerprint },
  });
  await restoreIntegration("", {
    opId: "op-2",
    confirmDrift: true,
    signal: controller.signal,
    binding: { operation: restorePlan.operation, planFingerprint: restorePlan.fingerprint },
  });

  expect(requests).toHaveLength(4);
  expect(requests[0]).toMatchObject({ url: "/api/client-integrations/preview" });
  expect(requests[0].init).toMatchObject({ method: "POST", body: JSON.stringify({ clientId: "pi", operation: "apply" }) });
  expect(requests[1]).toMatchObject({ url: "/api/client-integrations/restore/preview" });
  expect(requests[2]).toMatchObject({ url: "/api/client-integrations/pi" });
  expect(requests[2].init).toMatchObject({
    method: "PUT",
    body: JSON.stringify({ enabled: true, operation: "apply", planFingerprint: plan.fingerprint }),
    signal: controller.signal,
  });
  expect(new Headers(requests[2].init?.headers).get("Content-Type")).toBe("application/json");
  expect(requests[3]).toMatchObject({ url: "/api/client-integrations/restore" });
  expect(requests[3].init).toMatchObject({
    method: "POST",
    body: JSON.stringify({ opId: "op-2", confirmDrift: true, operation: "restore", planFingerprint: plan.fingerprint }),
    signal: controller.signal,
  });
});

test.each([
  { ...plan, extra: "raw-value" },
  { ...plan, operation: "refresh" },
  { ...plan, fingerprint: "bad" },
  { ...plan, changes: [{ kind: "add", path: "/home/private/config" }] },
  { ...plan, changes: [{ kind: "add", path: "providers.opencodex" }, { kind: "add", path: "providers.opencodex" }] },
  { ...plan, changes: Array.from({ length: 257 }, (_, index) => ({ kind: "add", path: `models.${index}` })) },
])("strict preview parser rejects malformed or private data", body => {
  expect(() => parseIntegrationMutationPlan(body)).toThrow(IntegrationApiError);
});

test("stale mutation errors expose only a newly validated plan", async () => {
  globalThis.fetch = (async () => Response.json({
    code: "integration_preview_stale",
    error: "stale",
    plan: { ...plan, fingerprint: "p1:22222222222222222222222222222222" },
  }, { status: 409 })) as typeof fetch;
  const error = await toggleIntegration("", "pi", {
    enabled: true,
    binding: { operation: "apply", planFingerprint: plan.fingerprint },
  }).catch(cause => cause as IntegrationApiError);
  expect(error.stalePlan?.fingerprint).toBe("p1:22222222222222222222222222222222");

  globalThis.fetch = (async () => Response.json({
    code: "integration_preview_stale", plan: { ...plan, rawValue: "private" },
  }, { status: 409 })) as typeof fetch;
  await expect(toggleIntegration("", "pi", {
    enabled: true,
    binding: { operation: "apply", planFingerprint: plan.fingerprint },
  })).rejects.toMatchObject({ status: 502, body: { code: "invalid_integration_preview_response" } });
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

  const error = await toggleIntegration("", "opencode", { enabled: false }).catch(cause => cause);

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

test("scoped Aside details reject malformed status fields before controls consume them", async () => {
  const valid = { clientId: "aside", profileId: 2, current: false, enabled: true, state: "current", installed: true,
    configPath: "/fixture/u/2/models.json", snapshotCount: 1, retentionDegraded: false };
  for (const bad of [{ state: "unknown" }, { installed: "yes" }, { snapshotCount: NaN }, { profileId: 1 }]) {
    globalThis.fetch = (async () => Response.json({ ...valid, ...bad })) as typeof fetch;
    await expect(loadIntegrationState("http://fixture", "aside", undefined, 2)).rejects.toMatchObject({
      body: { code: "invalid_aside_profile_response" },
    });
  }
});

test("bulk Aside refusals retain operation-specific recovery fields", async () => {
  globalThis.fetch = (async () => Response.json({ ok: false, message: "partial", results: [
    { clientId: "aside", profileId: 2, ok: false, state: "conflict", reason: "write_failed",
      message: "write failed", snapshotPath: "/backup/profile-2", residual: true },
  ] }, { status: 207 })) as typeof fetch;
  await expect(toggleIntegration("http://fixture", "aside", { enabled: true })).rejects.toMatchObject({ body: {
    results: [{ profileId: 2, reason: "write_failed", snapshotPath: "/backup/profile-2", residual: true }],
  } });
});

test.each([
  { ok: false, results: [{ profileId: 2, ok: true }] },
  { ok: false, results: [] },
  { ok: true, results: [{ profileId: 0, ok: true }, { profileId: 2, ok: false }] },
])("bulk Aside rejects a contradictory aggregate result: $ok / $results", async body => {
  globalThis.fetch = (async () => Response.json(body, { status: body.ok ? 200 : 207 })) as typeof fetch;

  await expect(toggleIntegration("http://fixture", "aside", { enabled: true })).rejects.toMatchObject({
    status: 502,
    body: { code: "invalid_aside_profile_response" },
  });
});
