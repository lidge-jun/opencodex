/**
 * #5261: opencodex must not be able to lock a user out of Codex.
 *
 * The reported machine was a Windows 11 install whose proxy had stopped. The routing
 * opencodex had written to `~/.codex/config.toml` stayed on disk across a reboot, so Codex's
 * own built-in openai provider kept resolving to a loopback port nothing was listening on,
 * and the user was stopped at sign-in with no mention of opencodex on screen.
 *
 * Nothing here starts a proxy, binds a port, or touches a real Codex home. That is the point:
 * these are exactly the transforms recovery must be able to run while the proxy is dead, so a
 * test that needed one running would be testing the wrong state.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OCX_ROUTING_MARKER_LINE,
  OCX_SECTION_MARKER,
  hasInjectedCodexRouting,
  hasInjectedOpenaiBaseUrl,
} from "../../src/codex/injected-marker";
import { missingOwnedCatalogPath, setRootOpenaiBaseUrl, setRootRealtimeWsBaseUrl } from "../../src/codex/inject/config-toml";
import { stripOpencodexConfig } from "../../src/codex/inject/remove";
import { deadProxyRoutingAdviceLines, missingCodexCatalogLines } from "../../src/cli/status";
import { findCommand } from "../../src/cli/registry";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/** A Windows catalog path as TOML stores it: a basic string doubles the separators (#1798). */
const WINDOWS_CATALOG = JSON.stringify(String.raw`C:\Users\example\.codex\opencodex-catalog.json`);

/** The loopback target the reported install was on. */
const TARGET = {
  baseUrl: "http://127.0.0.1:10100/v1",
  requiresAdmissionToken: false,
  tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
} as const;

/** The reported file, reconstructed: routing on disk, proxy gone. `marker` is the ownership line. */
function lockedOutConfig(marker: string): string {
  return [
    'model = "gpt-5.5"',
    `model_catalog_json = ${WINDOWS_CATALOG}`,
    marker,
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    marker,
    'experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"',
    "",
    "[features]",
    "fast_mode = true",
    "",
  ].join("\n");
}

describe("Codex sign-in lockout behind a stopped proxy (#5261)", () => {
  test("routing written before the recovery hint existed is still recognized as ours", () => {
    const legacy = lockedOutConfig(OCX_SECTION_MARKER);
    expect(hasInjectedOpenaiBaseUrl(legacy)).toBe(true);
    expect(hasInjectedCodexRouting(legacy)).toBe(true);
  });

  test("the hint changes what we write, never what we recognize or remove", () => {
    const hinted = lockedOutConfig(OCX_ROUTING_MARKER_LINE);
    expect(hasInjectedOpenaiBaseUrl(hinted)).toBe(true);
    expect(hasInjectedCodexRouting(hinted)).toBe(true);
    // Byte-identical recovery from either marker: the two forms must not diverge, or an
    // install that upgraded mid-incident would restore differently from one that did not.
    expect(stripOpencodexConfig(hinted)).toBe(stripOpencodexConfig(lockedOutConfig(OCX_SECTION_MARKER)));
  });

  test("recovery removes every dead endpoint without a proxy, and keeps the user's own keys", () => {
    const restored = stripOpencodexConfig(lockedOutConfig(OCX_ROUTING_MARKER_LINE));
    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("experimental_realtime_ws_base_url");
    // The catalog pointer has to go with the routing. Left behind, it names a file only
    // opencodex maintains, and Codex fails on a missing model_catalog_json target.
    expect(restored).not.toContain("opencodex-catalog.json");
    expect(restored).not.toContain("Auto-injected by opencodex");
    expect(restored).toContain('model = "gpt-5.5"');
    expect(restored).toContain("[features]");
    expect(restored).toContain("fast_mode = true");
  });

  test("an install that predates the hint gains it on the next injection, and stays idempotent", () => {
    const legacy = lockedOutConfig(OCX_SECTION_MARKER);
    const markers = (content: string) => content.split("\n").filter(line => line.includes(OCX_SECTION_MARKER));
    expect(markers(legacy)).toEqual([OCX_SECTION_MARKER, OCX_SECTION_MARKER]);

    const first = setRootOpenaiBaseUrl(legacy, 10100);
    expect(first.keptUserBaseUrl).toBe(false);
    // Each writer refreshes only the marker it owns, so after the routing key alone the
    // realtime marker is still the legacy line. Refreshed in place, never appended.
    expect(markers(first.content)).toEqual([OCX_ROUTING_MARKER_LINE, OCX_SECTION_MARKER]);
    expect(setRootOpenaiBaseUrl(first.content, 10100).content).toBe(first.content);

    const both = setRootRealtimeWsBaseUrl(first.content, TARGET);
    expect(both.keptUserRealtimeWsBaseUrl).toBe(false);
    expect(markers(both.content)).toEqual([OCX_ROUTING_MARKER_LINE, OCX_ROUTING_MARKER_LINE]);
    expect(setRootRealtimeWsBaseUrl(both.content, TARGET).content).toBe(both.content);
  });

  test("a user's own root override is still left alone and gains no hint", () => {
    const userOwned = 'model = "gpt-5.5"\nopenai_base_url = "https://gateway.example/v1"\n';
    const result = setRootOpenaiBaseUrl(userOwned, 10100);
    expect(result.keptUserBaseUrl).toBe(true);
    expect(result.content).toBe(userOwned);
    expect(result.content).not.toContain("undo:");
  });

  test("a dead proxy on our own routing is told how to get Codex back without one", () => {
    const advice = deadProxyRoutingAdviceLines({ proxyUp: false, routingKind: "opencodex-local" });
    expect(advice.length).toBeGreaterThan(0);
    expect(advice.join(" ")).toContain("sign-in");
    expect(advice.join(" ")).toContain("ocx restore");
  });

  test("the advice stays silent when it would be wrong or unactionable", () => {
    // A live proxy is not this failure.
    expect(deadProxyRoutingAdviceLines({ proxyUp: true, routingKind: "opencodex-local" })).toEqual([]);
    // Routing we do not own: `ocx restore` would not remove it, so promising it would mislead.
    for (const routingKind of ["native", "custom-local", "custom-remote", "unknown"] as const) {
      expect(deadProxyRoutingAdviceLines({ proxyUp: false, routingKind })).toEqual([]);
    }
  });

  test("both recovery surfaces name a command the CLI actually has", () => {
    // Derived from the marker rather than restated, so renaming the command in one place and
    // not the other fails here instead of shipping a config file that names nothing.
    const named = /ocx ([a-z][a-z-]*)/.exec(OCX_ROUTING_MARKER_LINE)?.[1];
    expect(named).toBeTruthy();
    expect(findCommand(named!)).toBeDefined();
    expect(deadProxyRoutingAdviceLines({ proxyUp: false, routingKind: "opencodex-local" }).join(" "))
      .toContain(`ocx ${named}`);
  });
});

describe("a Codex catalog pointer whose file is gone (#5261)", () => {
  /** Builds a root config naming `catalogPath`, in the escaped form TOML actually stores. */
  const configNaming = (catalogPath: string) =>
    `model = "gpt-5.5"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n`;

  test("an owned catalog that is missing is reported, and one that exists is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-catalog-pointer-"));
    try {
      // Ownership is by basename, which is what injection already uses. Pinned here so the
      // detector cannot start disagreeing with the code that writes and strips the same line.
      const present = join(dir, "opencodex-catalog.json");
      writeFileSync(present, "{}");
      const absent = join(dir, "gone", "opencodex-catalog.json");

      expect(missingOwnedCatalogPath(configNaming(absent))).toBe(absent);
      expect(missingOwnedCatalogPath(configNaming(present))).toBeNull();
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("a catalog the user named is theirs, present or not", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-catalog-user-"));
    try {
      // Same missing file, a name we never write. Claiming it would put opencodex's recovery
      // advice in front of a problem that is not opencodex's to explain.
      const userOwned = join(dir, "gone", "my-catalog.json");
      expect(missingOwnedCatalogPath(configNaming(userOwned))).toBeNull();
      expect(missingOwnedCatalogPath('model = "gpt-5.5"\n')).toBeNull();
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("the report names the file and both ways out", () => {
    const lines = missingCodexCatalogLines("/somewhere/opencodex-catalog.json");
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join(" ");
    expect(joined).toContain("/somewhere/opencodex-catalog.json");
    // Regenerating and removing are different outcomes; the user picks, so both are offered.
    expect(joined).toContain("ocx start");
    expect(joined).toContain("ocx restore");
    expect(missingCodexCatalogLines(null)).toEqual([]);
  });

  test("the commands it names are real", () => {
    for (const name of ["start", "restore"]) expect(findCommand(name)).toBeDefined();
  });
});
