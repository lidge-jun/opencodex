import { afterEach, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import {
  clearClientLinkState,
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
