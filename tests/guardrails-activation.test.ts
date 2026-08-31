import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  captureGuardrailsPolicy,
  guardrailsPolicyProtectsProvider,
  leaseCapturedGuardrailsRuntimeSnapshot,
  leaseActiveGuardrailsRuntimeSnapshot,
  setGuardrailsRuntimeModuleLoaderForTests,
} from "../src/guardrails/activation";
import { guardrailsPolicyRevision } from "../src/guardrails/runtime";
import { admitGuardrailsRuntime } from "../src/guardrails/turn";
import {
  clearGuardrailsTelemetryForTests,
  guardrailsActivity,
} from "../src/guardrails/telemetry";
import type { OcxConfig } from "../src/types";

afterEach(() => {
  setGuardrailsRuntimeModuleLoaderForTests();
  clearGuardrailsTelemetryForTests();
});

const STATIC_RUNTIME_IMPORT_RE =
  /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;

function resolveLocalImport(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function firstStaticPackagePath(entry: string, packageName: string): string[] | null {
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const start = resolve(repoRoot, entry);
  const previous = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const source = readFileSync(current, "utf8");
    STATIC_RUNTIME_IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STATIC_RUNTIME_IMPORT_RE.exec(source)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
        const chain: string[] = [specifier];
        let node: string | null = current;
        while (node) {
          chain.push(node.slice(repoRoot.length + 1));
          node = previous.get(node) ?? null;
        }
        return chain.reverse();
      }
      const next = resolveLocalImport(specifier, current);
      if (!next || previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  return null;
}

test("disabled Responses path has no static route to re2-wasm", () => {
  const path = firstStaticPackagePath("src/server/responses/core.ts", "re2-wasm");
  expect(path === null ? "clean" : path.join(" -> ")).toBe("clean");
});

test("captured Guardrails provider policy is immutable and detached from live config", () => {
  const config = {
    guardrails: {
      enabled: true,
      providerScope: {
        mode: "selected",
        providerIds: ["protected"],
      },
    },
  } as OcxConfig;
  const captured = captureGuardrailsPolicy(config);

  expect(captured).toBeDefined();
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.isFrozen(captured?.providerScope)).toBe(true);
  expect(captured?.providerScope?.mode === "selected"
    && Object.isFrozen(captured.providerScope.providerIds)).toBe(true);

  config.guardrails = {
    enabled: false,
    providerScope: {
      mode: "selected",
      providerIds: ["excluded"],
    },
  };
  expect(guardrailsPolicyProtectsProvider(captured, "protected")).toBe(true);
  expect(guardrailsPolicyProtectsProvider(captured, "excluded")).toBe(false);
});

test("known excluded provider skips the dynamic runtime import", async () => {
  const config = {
    guardrails: {
      enabled: true,
      providerScope: {
        mode: "selected",
        providerIds: ["protected"],
      },
    },
  } as OcxConfig;
  const captured = captureGuardrailsPolicy(config);
  let importCount = 0;
  setGuardrailsRuntimeModuleLoaderForTests(async () => {
    importCount += 1;
    return import("../src/guardrails/runtime");
  });

  expect(await leaseCapturedGuardrailsRuntimeSnapshot(
    config,
    captured,
    "excluded",
  )).toBeUndefined();
  expect(importCount).toBe(0);
});

test("unknown or selected provider remains fail-safe protected", async () => {
  const config = {
    guardrails: {
      enabled: true,
      providerScope: {
        mode: "selected",
        providerIds: ["protected"],
      },
    },
  } as OcxConfig;
  const captured = captureGuardrailsPolicy(config);
  let importCount = 0;
  setGuardrailsRuntimeModuleLoaderForTests(async () => {
    importCount += 1;
    return import("../src/guardrails/runtime");
  });

  expect(guardrailsPolicyProtectsProvider(captured, undefined)).toBe(true);
  expect(guardrailsPolicyProtectsProvider(captured, "provider/model")).toBe(true);
  const unknownLease = await leaseCapturedGuardrailsRuntimeSnapshot(
    config,
    captured,
    undefined,
  );
  expect(unknownLease).toBeDefined();
  unknownLease?.release();

  const selectedLease = await leaseCapturedGuardrailsRuntimeSnapshot(
    config,
    captured,
    "protected",
  );
  expect(selectedLease).toBeDefined();
  selectedLease?.release();
  expect(importCount).toBe(2);
});

test("Guardrails admission keeps one policy generation across the first async import boundary", async () => {
  const config = {
    guardrails: {
      enabled: true,
      mode: "enforce",
      failurePolicy: "block",
      disabledBuiltinRuleIds: ["credentials.url_with_creds"],
    },
  } as OcxConfig;
  const admittedPolicy = structuredClone(config.guardrails!);
  let releaseImport!: () => void;
  const importGate = new Promise<void>(resolve => {
    releaseImport = resolve;
  });
  setGuardrailsRuntimeModuleLoaderForTests(async () => {
    await importGate;
    return import("../src/guardrails/runtime");
  });

  const pending = leaseActiveGuardrailsRuntimeSnapshot(config);
  config.guardrails = {
    enabled: false,
    mode: "detect",
    failurePolicy: "passthrough",
  };
  releaseImport();

  const lease = await pending;
  expect(lease).toBeDefined();
  expect(lease?.snapshot.enabled).toBe(true);
  expect(lease?.snapshot.mode).toBe("enforce");
  expect(lease?.snapshot.failurePolicy).toBe("block");
  expect(lease?.snapshot.policyRevision).toBe(guardrailsPolicyRevision(admittedPolicy));
  lease?.release();

  expect(await leaseActiveGuardrailsRuntimeSnapshot(config)).toBeUndefined();
});

test("Guardrails admission keeps the captured failure policy when config mutates during import", async () => {
  const config = {
    guardrails: {
      enabled: true,
      mode: "enforce",
      failurePolicy: "passthrough",
    },
  } as OcxConfig;
  let rejectImport!: (error: Error) => void;
  const importGate = new Promise<never>((_resolve, reject) => {
    rejectImport = reject;
  });
  setGuardrailsRuntimeModuleLoaderForTests(() => importGate);

  const pending = admitGuardrailsRuntime(config);
  config.guardrails = {
    enabled: true,
    mode: "detect",
    failurePolicy: "block",
  };
  rejectImport(new Error("synthetic import failure"));

  const admission = await pending;
  expect(admission.lease).toBeUndefined();
  expect(admission.snapshot).toBeUndefined();
  expect(admission.passthroughFailure).toBe(true);
  expect(guardrailsActivity({ result: "passthrough" })).toMatchObject({
    totalMatching: 1,
    events: [expect.objectContaining({
      surface: "responses",
      mode: "enforce",
      result: "passthrough",
      registryGeneration: 0,
      count: 1,
      ruleIds: [],
      categoryIds: [],
      severity: "high",
    })],
  });
});
