/**
 * #4207: `ocx connect status` reported connected, catalog present and freshly synced, while
 * the installed Codex CLI exited before its first request because the downloaded catalog used
 * a reasoning level it does not know. Connection state proved the hub and the credential; it
 * never proved the selected local runtime could consume what was written.
 *
 * The gate fails closed: an incompatible catalog is refused before the write, so the previous
 * known-good file survives. It does not rewrite the hub's catalog into a local projection and
 * it does not touch running Codex processes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { catalogEffortCompatibility } from "../../src/codex/catalog/effort";
import {
  assertClientCatalogCompatible,
  assessClientCatalogCompatibility,
  ClientCatalogIncompatibleError,
} from "../../src/client/catalog-compatibility";
import { repoPath } from "../helpers/repo-root";

/** The shape the hub publishes: a model row with a reasoning ladder. */
function catalogBody(levels: string[], slug = "gpt-5.6-sol", defaultLevel?: string): string {
  return JSON.stringify({
    models: [{
      slug,
      supported_reasoning_levels: levels.map(effort => ({ effort })),
      ...(defaultLevel ? { default_reasoning_level: defaultLevel } : {}),
    }],
  });
}

/** Codex CLI 0.135.0's ladder, verbatim from the parse error in the issue. */
const OLD_CLI = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const NEW_CLI = new Set([...OLD_CLI, "max", "ultra"]);

describe("#4207 catalog effort compatibility", () => {
  test("reports the levels an older runtime would reject, without changing the catalog", () => {
    const models = JSON.parse(catalogBody(["low", "high", "max"])).models;
    const before = JSON.stringify(models);

    const result = catalogEffortCompatibility(models, OLD_CLI);

    expect(result.compatible).toBe(false);
    expect(result.unsupportedEfforts).toEqual(["max"]);
    expect(result.affectedModels).toEqual(["gpt-5.6-sol"]);
    // The clamp beside it mutates; this one must not, or the client would silently disagree
    // with hub truth.
    expect(JSON.stringify(models)).toBe(before);
  });

  test("a default level the runtime does not know is an incompatibility too", () => {
    // The CLI parses default_reasoning_level with the same enum, so a ladder that survives
    // the filter can still fail on the default alone.
    const models = JSON.parse(catalogBody(["low", "high"], "gpt-5.6-sol", "ultra")).models;
    const result = catalogEffortCompatibility(models, OLD_CLI);
    expect(result.compatible).toBe(false);
    expect(result.unsupportedEfforts).toEqual(["ultra"]);
  });

  test("a catalog the runtime fully supports is compatible", () => {
    const models = JSON.parse(catalogBody(["low", "high", "max"])).models;
    expect(catalogEffortCompatibility(models, NEW_CLI)).toEqual({
      compatible: true,
      unsupportedEfforts: [],
      affectedModels: [],
    });
  });

  test("an unobservable runtime ladder is not evidence of incompatibility", () => {
    const models = JSON.parse(catalogBody(["low", "max"])).models;
    expect(catalogEffortCompatibility(models, null).compatible).toBe(true);
  });
});

describe("#4207 client catalog gate", () => {
  test("the exact ladder from the report is refused", () => {
    const body = catalogBody(["low", "medium", "high", "xhigh", "max"]);

    expect(() => assertClientCatalogCompatible(body, { supportedEfforts: () => OLD_CLI }))
      .toThrow(ClientCatalogIncompatibleError);
  });

  test("the refusal names the level, both remedies, and what was preserved", () => {
    let thrown: unknown;
    try {
      assertClientCatalogCompatible(catalogBody(["low", "max"]), { supportedEfforts: () => OLD_CLI });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ClientCatalogIncompatibleError);
    const message = (thrown as Error).message;
    expect(message).toContain("max");
    // "Incompatible" alone is not actionable: the operator has to know which way out exists.
    expect(message).toContain("Upgrade the Codex CLI");
    expect(message).toContain("CODEX_CLI_PATH");
    expect(message).toContain("The previous catalog was kept");
    expect((thrown as ClientCatalogIncompatibleError).unsupportedEfforts).toEqual(["max"]);
  });

  test("a compatible catalog passes the gate", () => {
    expect(() => assertClientCatalogCompatible(
      catalogBody(["low", "high", "max"]),
      { supportedEfforts: () => NEW_CLI },
    )).not.toThrow();
  });

  test("an unverifiable runtime does not block the connection", () => {
    // A client machine may legitimately have no Codex CLI to observe. Refusing then would
    // block a working configuration on absent evidence rather than on an incompatibility.
    const assessment = assessClientCatalogCompatibility(catalogBody(["max"]), { supportedEfforts: () => null });
    expect(assessment.kind).toBe("unverified");
    expect(() => assertClientCatalogCompatible(catalogBody(["max"]), { supportedEfforts: () => null }))
      .not.toThrow();
  });

  test("an unreadable body is unverified, not blamed on the runtime", () => {
    // The hub client already rejects a malformed body with its own cause. Inventing a second
    // one here would repeat #4169, where a refusal named a cause the server never reported.
    const assessment = assessClientCatalogCompatibility("not json", { supportedEfforts: () => OLD_CLI });
    expect(assessment.kind).toBe("unverified");
  });

  test("both catalog downloads are gated, and the restore paths are not", () => {
    // connect and sync each write the hub's bytes to the same path; a gate on only one of them
    // still lets a sync replace a parseable catalog with an unparseable one.
    const source = readFileSync(repoPath("src", "client", "connect.ts"), "utf8");
    for (const written of ["catalog.body", "downloaded.body"]) {
      const write = source.indexOf(`atomicWriteFile(DEFAULT_CATALOG_PATH, ${written})`);
      expect(write).toBeGreaterThan(0);
      const gate = source.indexOf(`assertClientCatalogCompatible(${written}`);
      expect(gate).toBeGreaterThan(0);
      expect(gate).toBeLessThan(write);
    }
    // Restoring a catalog this machine previously accepted must not be gated on a runtime that
    // may since have changed — that would strand the client with no catalog at all.
    expect(source).toContain("atomicWriteFile(DEFAULT_CATALOG_PATH, snapshot.body)");
    expect(source.match(/assertClientCatalogCompatible\(/g)).toHaveLength(2);
  });
});
