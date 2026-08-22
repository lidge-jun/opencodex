import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  inspectDesktop3pConfigLibrary,
  removeDesktop3pStandardPivot,
} from "../src/claude/desktop-3p";

function envFor(path: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: path };
}

function appliedFingerprint(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex").slice(0, 16);
}

test("an absent Desktop library is read-only and OFF is an idempotent no-op", () => {
  const library = join(mkdtempSync(join(tmpdir(), "ocx-desktop-remove-")), "missing");
  const options = { env: envFor(library) };
  expect(inspectDesktop3pConfigLibrary(options).kind).toBe("not_installed");
  expect(removeDesktop3pStandardPivot(options)).toMatchObject({ ok: true, changed: false, kind: "noop" });
  expect(existsSync(library)).toBe(false);
});

test("OFF selects a credential-free standard profile before deleting the owned profile and backup", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const id = "owned-profile";
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100",
    // Shape-only value: deliberately inert; never a credential.
    inferenceGatewayApiKey: "not-a-secret",
  }));
  writeFileSync(join(library, `${id}.json.bak`), "{}");

  const result = removeDesktop3pStandardPivot({ env: envFor(library), appliedFingerprint: appliedFingerprint(join(library, `${id}.json`)) });
  expect(result).toMatchObject({ ok: true, changed: true, kind: "removed" });
  expect(existsSync(join(library, `${id}.json`))).toBe(false);
  expect(existsSync(join(library, `${id}.json.bak`))).toBe(false);
  const metadata = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as { appliedId: string; entries: Array<{ id: string }> };
  expect(metadata.entries.map(entry => entry.id)).not.toContain(id);
  const standard = JSON.parse(readFileSync(join(library, `${metadata.appliedId}.json`), "utf8")) as Record<string, unknown>;
  expect(standard).toEqual({});
});

test("a selected path traversal id is refused without following it", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: "../outside", entries: [] }));
  const result = inspectDesktop3pConfigLibrary({ env: envFor(library) });
  expect(result).toMatchObject({ kind: "unsafe", reason: "unsafe_applied_id" });
  expect(removeDesktop3pStandardPivot({ env: envFor(library) }).kind).toBe("unsafe");
});

test("a selected foreign standard profile is never mutated, but owned residue can be cleaned", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const foreign = "foreign-standard";
  const owned = "owned-residue";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({
    appliedId: foreign,
    entries: [{ id: foreign, name: "someone-else" }, { id: owned, name: "opencodex" }],
  }));
  writeFileSync(join(library, `${foreign}.json`), "{}\n");
  writeFileSync(join(library, `${owned}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
  }));

  expect(inspectDesktop3pConfigLibrary({ env: envFor(library) })).toMatchObject({ kind: "foreign", appliedId: foreign });
  expect(removeDesktop3pStandardPivot({ env: envFor(library) })).toMatchObject({ ok: true, changed: true, kind: "removed" });
  expect(readFileSync(join(library, `${foreign}.json`), "utf8")).toBe("{}\n");
  expect(existsSync(join(library, `${owned}.json`))).toBe(false);
  expect(JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"))).toMatchObject({ appliedId: foreign, entries: [{ id: foreign }] });
});

test("an owned but drifted gateway profile can still be disabled", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const id = "drifted-owned";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
  }));
  writeFileSync(join(library, `${id}.json.bak`), "{}");

  expect(inspectDesktop3pConfigLibrary({ env: envFor(library), appliedFingerprint: "other" }).kind).toBe("gateway_drifted");
  // Missing/mismatched fingerprint must not trap OFF: the selected row is still our
  // owned gateway, so disable pivots to standard and deletes the credential-bearing files.
  const result = removeDesktop3pStandardPivot({ env: envFor(library), appliedFingerprint: "other" });
  expect(result).toMatchObject({ ok: true, changed: true, kind: "removed" });
  expect(existsSync(join(library, `${id}.json`))).toBe(false);
  expect(existsSync(join(library, `${id}.json.bak`))).toBe(false);
  const metadata = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as { appliedId: string; entries: Array<{ id: string; name: string }> };
  expect(metadata.entries.map(entry => entry.id)).not.toContain(id);
  expect(metadata.entries.some(entry => entry.name === "opencodex-standard")).toBe(true);
  expect(JSON.parse(readFileSync(join(library, `${metadata.appliedId}.json`), "utf8"))).toEqual({});
});

test("an owned gateway with no saved fingerprint is treated as drifted and can be disabled", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const id = "fingerprint-missing";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
  }));

  expect(inspectDesktop3pConfigLibrary({ env: envFor(library), appliedFingerprint: null }).kind).toBe("gateway_drifted");
  expect(removeDesktop3pStandardPivot({ env: envFor(library), appliedFingerprint: null })).toMatchObject({
    ok: true, changed: true, kind: "removed",
  });
  expect(existsSync(join(library, `${id}.json`))).toBe(false);
});

test("a delete interruption leaves the standard pivot selected and reports only residual paths", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const id = "owned-profile";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
  }));
  writeFileSync(join(library, `${id}.json.bak`), "{}");

  const result = removeDesktop3pStandardPivot({
    env: envFor(library),
    appliedFingerprint: appliedFingerprint(join(library, `${id}.json`)),
    unlink: path => {
      if (path.endsWith(".bak")) throw new Error("injected delete failure");
      unlinkSync(path);
    },
  });
  expect(result).toMatchObject({ ok: false, changed: true, kind: "cleanup_incomplete" });
  expect(result.residualPaths).toEqual([join(library, `${id}.json.bak`)]);
  const metadata = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as { appliedId: string };
  expect(JSON.parse(readFileSync(join(library, `${metadata.appliedId}.json`), "utf8"))).toEqual({});
});

test("interrupted cleanup prefers the selected opencodex row and reports another owned row as residue", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const selected = "selected-owned";
  const residual = "residual-owned";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({
    appliedId: selected,
    entries: [{ id: selected, name: "opencodex" }, { id: residual, name: "opencodex" }],
  }));
  for (const id of [selected, residual]) {
    writeFileSync(join(library, `${id}.json`), JSON.stringify({
      inferenceProvider: "gateway", inferenceCredentialKind: "static",
      inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
    }));
  }

  const result = removeDesktop3pStandardPivot({ env: envFor(library), appliedFingerprint: appliedFingerprint(join(library, `${selected}.json`)) });
  expect(result).toMatchObject({ ok: false, changed: true, kind: "cleanup_incomplete" });
  expect(existsSync(join(library, `${selected}.json`))).toBe(false);
  expect(result.residualPaths).toContain(join(library, `${residual}.json`));
});
