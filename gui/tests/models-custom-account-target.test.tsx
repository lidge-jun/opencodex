import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import { sidecarModelOptions } from "../src/pages/dashboard-shared";
import {
  activeModelOptions,
  modelDefaultAvailableForActiveSelection,
} from "../src/pages/models-shared";
import Models from "../src/pages/Models";

const originalFetch = globalThis.fetch;
let previousLanguage: unknown;

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
});

afterEach(() => {
  clearClientResourceStoresForTests();
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

test("the custom-model editor lazily selects a privacy-safe exact Codex account target", async () => {
  const domGlobals = ["document", "window", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previousDescriptors = Object.fromEntries(
    domGlobals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
  const randomUuidDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  // LAN HTTP dashboards may not expose secure-context-only randomUUID(). The
  // account-target write nonce must still use a valid UUID v4 via getRandomValues().
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));

  let root: Root | undefined;
  let accountOptionReads = 0;
  let failNextAccountCapability = false;
  let fullAccountReads = 0;
  let providerReads = 0;
  let omitNextTargetAttestation = false;
  let retargetNextDisplayOnlyPut = false;
  const posted: Array<Record<string, unknown>> = [];
  const legacyPosted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/models")) {
      return Response.json([
        {
          provider: "openai",
          id: "existing-preview",
          namespaced: "openai/existing-preview",
          disabled: false,
        },
        {
          provider: "openai",
          id: "orphaned-preview",
          namespaced: "openai/orphaned-preview",
          disabled: false,
          custom: true,
          customId: "orphaned",
          codexAccountTarget: "deleted-account",
          codexAccountTargetAvailable: false,
        },
      ]);
    }
    if (url.endsWith("/api/providers")) {
      providerReads += 1;
      return Response.json([{
        name: "openai",
        authMode: "forward",
        disabled: false,
        // A later refresh models a provider that no longer has canonical Codex-forward shape.
        supportsCodexAccountTarget: providerReads === 1,
      }]);
    }
    if (url.endsWith("/api/selected-models")) return Response.json({ selected: {}, available: {} });
    if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {}, value: 350_000 });
    if (url.endsWith("/api/codex-auth/account-target-options")) {
      accountOptionReads += 1;
      if (failNextAccountCapability) {
        failNextAccountCapability = false;
        return Response.json({ error: "old proxy" }, { status: 404 });
      }
      return Response.json({
        targets: [
          { target: "@main", isMain: true, label: "Codex App login", logLabel: "main", paused: false },
          { target: "pool-private-id", isMain: false, label: "Work", logLabel: "p123abc", paused: false },
          { target: "pool-private-id-2", isMain: false, label: "Work", logLabel: "p456def", paused: false },
        ],
      });
    }
    if (url.endsWith("/api/codex-auth/accounts")) {
      fullAccountReads += 1;
      return Response.json({ accounts: [] });
    }
    if (url.endsWith("/api/custom-models/account-target") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body);
      if (omitNextTargetAttestation) {
        omitNextTargetAttestation = false;
        return Response.json({
          id: "old-proxy-row",
          codexAccountTarget: body.codexAccountTarget,
        }, { status: 201 });
      }
      return Response.json({ id: "new-custom", ...body }, { status: 201 });
    }
    if (url.endsWith("/api/custom-models") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      legacyPosted.push(body);
      return Response.json({ id: "legacy-custom", ...body }, { status: 201 });
    }
    if (url.endsWith("/api/custom-models/orphaned/account-target") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      updated.push(body);
      if (omitNextTargetAttestation) {
        omitNextTargetAttestation = false;
        const { codexAccountTargetWriteNonce: _nonce, ...reflected } = body;
        return Response.json({
          id: "orphaned",
          codexAccountTarget: "deleted-account",
          ...reflected,
        });
      }
      if (retargetNextDisplayOnlyPut && !Object.hasOwn(body, "codexAccountTarget")) {
        retargetNextDisplayOnlyPut = false;
        return Response.json({
          id: "orphaned",
          codexAccountTarget: "pool-private-id",
          ...body,
        });
      }
      return Response.json({ id: "orphaned", ...body });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <Models apiBase="http://localhost" />
        </LanguageProvider>,
      );
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(accountOptionReads).toBe(0);
    expect(fullAccountReads).toBe(0);
    const orphanSwitch = container.querySelector<HTMLButtonElement>(
      'button[aria-label="openai/orphaned-preview"]',
    );
    expect(orphanSwitch?.disabled).toBe(true);
    expect(container.textContent).toContain("Previously selected account (unavailable)");
    expect(container.textContent).toContain("1/2 visible");
    expect(container.textContent).not.toContain("2/2 visible");

    const addButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add custom model"]');
    expect(addButton).not.toBeNull();
    await act(async () => {
      addButton!.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(accountOptionReads).toBe(1);
    expect(fullAccountReads).toBe(0);

    const targetSelect = container.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Codex account for this model"]',
    );
    expect(targetSelect).not.toBeNull();
    await act(async () => targetSelect!.click());
    const mainOption = [...testWindow.document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .find(button => button.textContent === "Main Account (main)");
    expect(mainOption).not.toBeUndefined();
    expect(testWindow.document.body.textContent).toContain("Work (p123abc)");
    expect(testWindow.document.body.textContent).toContain("Work (p456def)");
    expect(testWindow.document.body.textContent).not.toContain("pool-private-id");
    expect(testWindow.document.body.textContent).not.toContain("pool-private-id-2");
    await act(async () => mainOption!.click());

    const modelInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. qwen4-max-preview"]',
    )!;
    const setValue = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(modelInput, "new-preview");
      modelInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    const saveButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Add" && button.closest('[role="dialog"]'))!;
    failNextAccountCapability = true;
    await act(async () => {
      saveButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(posted).toHaveLength(0);
    expect(container.textContent).toContain("Failed to save custom model");
    omitNextTargetAttestation = true;
    await act(async () => {
      saveButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(posted).toHaveLength(1);
    expect(container.textContent).toContain("Failed to save custom model");
    await act(async () => {
      saveButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({
      provider: "openai",
      modelId: "new-preview",
      inputModalities: ["text"],
      codexAccountTarget: "@main",
    });
    expect(posted[1]?.codexAccountTargetWriteNonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.stringify(posted[1])).not.toContain("__main__");

    // The post-save refresh removes the server capability. A fresh row cannot offer a
    // selector merely because the provider is still named `openai`.
    expect(providerReads).toBeGreaterThanOrEqual(2);
    const secondAddButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add custom model"]')!;
    await act(async () => {
      secondAddButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(accountOptionReads).toBe(4);
    expect(container.querySelector(
      'button[role="combobox"][aria-label="Codex account for this model"]',
    )).toBeNull();
    const secondModelInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. qwen4-max-preview"]',
    )!;
    await act(async () => {
      setValue.call(secondModelInput, "automatic-preview");
      secondModelInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    const secondSaveButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Add" && button.closest('[role="dialog"]'))!;
    await act(async () => {
      secondSaveButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(legacyPosted).toHaveLength(1);
    expect(legacyPosted[0]).toMatchObject({
      provider: "openai",
      modelId: "automatic-preview",
      inputModalities: ["text"],
    });
    expect(legacyPosted[0]).not.toHaveProperty("codexAccountTarget");
    expect(legacyPosted[0]).not.toHaveProperty("codexAccountTargetWriteNonce");

    // An existing invalid/orphan binding stays repair-visible even when the provider no
    // longer supports new bindings; clearing it emits an explicit null and does not fetch
    // account metadata for an inapplicable provider.
    const orphanRow = orphanSwitch!.closest<HTMLElement>(".model-row-wrap")!;
    expect(orphanRow.tabIndex).toBe(0);
    expect(orphanRow.getAttribute("role")).toBe("group");
    expect(orphanRow.getAttribute("aria-label")).toContain("openai/orphaned-preview");
    await act(async () => {
      orphanRow.focus();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(testWindow.document.activeElement).toBe(orphanRow);
    const editButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Edit" && button.closest(".model-tip-actions"))!;
    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Delete" && button.closest(".model-tip-actions"));
    expect(deleteButton).not.toBeUndefined();
    await act(async () => {
      editButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    const repairSelect = container.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Codex account for this model"]',
    );
    expect(repairSelect).not.toBeNull();
    expect(accountOptionReads).toBe(4);
    const unchangedUpdateButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Update" && button.closest('[role="dialog"]'))!;
    failNextAccountCapability = true;
    await act(async () => {
      unchangedUpdateButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(updated).toHaveLength(0);
    expect(container.textContent).toContain("Failed to save custom model");
    expect(accountOptionReads).toBe(5);
    // A downgrade after the successful capability probe can echo the stored target, but
    // cannot echo the per-write nonce understood only by the feature-aware handler.
    omitNextTargetAttestation = true;
    await act(async () => {
      unchangedUpdateButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(updated).toHaveLength(1);
    expect(container.textContent).toContain("Failed to save custom model");
    expect(accountOptionReads).toBe(6);
    // A different writer may retarget the row after this modal opened. A display-only
    // edit attests the feature-aware mutation by nonce and must accept the authoritative
    // target reflected by the server instead of comparing it to the stale modal value.
    retargetNextDisplayOnlyPut = true;
    await act(async () => {
      unchangedUpdateButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(updated).toHaveLength(2);
    expect(updated[1]).not.toHaveProperty("codexAccountTarget");
    expect(updated[1]?.codexAccountTargetWriteNonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("Custom model updated");
    expect(accountOptionReads).toBe(7);

    const refreshedOrphanRow = container.querySelector<HTMLButtonElement>(
      'button[aria-label="openai/orphaned-preview"]',
    )!.closest<HTMLElement>(".model-row-wrap")!;
    await act(async () => {
      refreshedOrphanRow.focus();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    const refreshedEditButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Edit" && button.closest(".model-tip-actions"))!;
    await act(async () => {
      refreshedEditButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    const refreshedRepairSelect = container.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Codex account for this model"]',
    )!;
    await act(async () => refreshedRepairSelect.click());
    const automaticOption = [...testWindow.document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .find(button => button.textContent === "Automatic (provider Pool/Direct)")!;
    await act(async () => automaticOption.click());
    const updateButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Update" && button.closest('[role="dialog"]'))!;
    await act(async () => {
      updateButton.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 20));
    });
    expect(updated).toHaveLength(3);
    expect(updated[2]?.codexAccountTarget).toBeNull();
    expect(updated[2]?.codexAccountTargetWriteNonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(accountOptionReads).toBe(8);
  } finally {
    await act(async () => root?.unmount());
    if (randomUuidDescriptor) {
      Object.defineProperty(globalThis.crypto, "randomUUID", randomUuidDescriptor);
    } else {
      delete (globalThis.crypto as unknown as { randomUUID?: () => string }).randomUUID;
    }
    for (const key of domGlobals) {
      const descriptor = previousDescriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("an unavailable exact target stays repair-visible but leaves active and sidecar choices", () => {
  const rows = [{
    provider: "openai",
    id: "orphaned-preview",
    namespaced: "openai/orphaned-preview",
    disabled: false,
    custom: true,
    customId: "orphaned",
    codexAccountTarget: "deleted-account",
    codexAccountTargetAvailable: false,
  }];

  expect(activeModelOptions(rows, new Set(), {})).toEqual([]);
  expect(sidecarModelOptions(rows)).toEqual([]);
  expect(modelDefaultAvailableForActiveSelection(rows, "openai", "orphaned-preview")).toBe(false);
  expect(modelDefaultAvailableForActiveSelection(rows, "openai", "catalog-lagged-default")).toBe(true);
});
