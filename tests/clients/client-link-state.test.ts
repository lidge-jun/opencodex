import { afterEach, expect, test } from "bun:test";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import {
  childLinkMarkerPath,
  clearClientLinkState,
  isChildInitiatedLink,
  recordChildInitiatedLink,
  clientLinkStatePath,
  ClientLinkStateError,
  readClientLinkState,
  writeClientLinkState,
  type ClientLinkState,
} from "../../src/client/link-state";

let home: TempHome | undefined;

afterEach(() => {
  home?.remove();
  home = undefined;
});

function fixture(): ClientLinkState {
  return {
    linkId: "lnk_0123456789abcdef",
    alias: "home.example.test",
    hubHostKeyFingerprint: "SHA256:ABCDEFGHIJKLMNOP",
    peerListenerPort: 1,
    tunnelPort: 1024,
  };
}

test("client link sidecar round-trips with private POSIX permissions", () => {
  home = createTempHome("ocx-client-link-state-");
  const path = clientLinkStatePath(home.configDir);
  writeClientLinkState(fixture(), path);
  expect(readClientLinkState(path)).toEqual(fixture());
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(home.path("link")).mode & 0o777).toBe(0o700);
  }
});

test("client link sidecar rejects unknown fields, invalid ports, fingerprints, and JSON", () => {
  home = createTempHome("ocx-client-link-state-invalid-");
  const path = clientLinkStatePath(home.configDir);
  const base = fixture();
  writeClientLinkState(base, path);
  const invalid: unknown[] = [
    { ...base, extra: true },
    { ...base, tunnelPort: 1023 },
    { ...base, hubHostKeyFingerprint: "not-a-fingerprint" },
  ];
  for (const value of invalid) {
    writeFileSync(path, JSON.stringify(value));
    expect(() => readClientLinkState(path)).toThrow(ClientLinkStateError);
  }
  writeFileSync(path, "{");
  expect(() => readClientLinkState(path)).toThrow(ClientLinkStateError);
});

test("client link sidecar clear is owner checked", () => {
  home = createTempHome("ocx-client-link-state-owner-");
  const path = clientLinkStatePath(home.configDir);
  writeClientLinkState(fixture(), path);
  expect(clearClientLinkState("lnk_fedcba9876543210", path)).toBe(false);
  expect(existsSync(path)).toBe(true);
  expect(clearClientLinkState(fixture().linkId, path)).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(clearClientLinkState(fixture().linkId, path)).toBe(false);
});

test("a join leaves a marker that outlives a lost sidecar and is removed with it", () => {
  // Without the marker a Child-initiated link whose sidecar went missing would look
  // Home-initiated, and the relay would forward it without a tunnel ownership proof.
  home = createTempHome("ocx-client-link-marker-");
  const path = clientLinkStatePath(home.configDir);
  const marker = childLinkMarkerPath(home.configDir);
  expect(isChildInitiatedLink("lnk_0123456789abcdef", marker)).toBe(false);
  writeClientLinkState(fixture(), path);
  expect(isChildInitiatedLink("lnk_0123456789abcdef", marker)).toBe(true);
  expect(isChildInitiatedLink("lnk_fedcba9876543210", marker)).toBe(false);
  if (process.platform !== "win32") expect(statSync(marker).mode & 0o777).toBe(0o600);
  expect(clearClientLinkState("lnk_0123456789abcdef", path)).toBe(true);
  expect(existsSync(marker)).toBe(false);
  // An unreadable marker fails closed.
  writeFileSync(marker, "{not json");
  expect(isChildInitiatedLink("lnk_fedcba9876543210", marker)).toBe(true);
});

test("a join made before markers existed gets one at start while its sidecar is intact", () => {
  home = createTempHome("ocx-client-link-legacy-");
  const path = clientLinkStatePath(home.configDir);
  const marker = childLinkMarkerPath(home.configDir);
  writeClientLinkState(fixture(), path);
  unlinkSync(marker); // what a 2.67.0 join left behind
  recordChildInitiatedLink("lnk_fedcba9876543210", path, marker);
  expect(existsSync(marker)).toBe(false); // another link's id records nothing
  recordChildInitiatedLink("lnk_0123456789abcdef", path, marker);
  unlinkSync(path);
  expect(isChildInitiatedLink("lnk_0123456789abcdef", marker)).toBe(true);
});
