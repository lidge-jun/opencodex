import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import * as os from "node:os";
import { parseClaimArgs, runServiceClaim, CLAIM_SCHEMA } from "../../src/service/claim";
import { ServiceOwnershipSubjectMismatchError, serviceStatePath, serviceStatePaths } from "../../src/service/state";
import type { ServiceOwnershipSubject } from "../../src/service/state";
import { createTempHome } from "../helpers/temp-home";

const VALID = [
  "--owner", "desktop",
  "--install-id", "install-a",
  "--expect-none",
  "--expect-revision", "0",
  "--expect-compatibility-token", "deadbeef",
];

describe("parseClaimArgs", () => {
  test("parses a full expect-none invocation", () => {
    const parsed = parseClaimArgs([...VALID, "--json"]);
    expect(parsed).toEqual({
      ok: true,
      args: {
        owner: "desktop",
        installId: "install-a",
        expectedSubject: { kind: "none", revision: 0 },
        compatibilityToken: "deadbeef",
        json: true,
      },
    });
  });

  test("parses an expect-owner invocation", () => {
    const parsed = parseClaimArgs([
      "--owner", "desktop",
      "--install-id", "install-a",
      "--expect-owner", "cli",
      "--expect-install-id", "npm-1",
      "--expect-generation", "4",
      "--expect-revision", "9",
      "--expect-compatibility-token", "cafe",
    ]);
    expect(parsed).toEqual({
      ok: true,
      args: {
        owner: "desktop",
        installId: "install-a",
        expectedSubject: {
          kind: "owned",
          ownership: { owner: "cli", installId: "npm-1", consentGeneration: 4 },
          revision: 9,
        },
        compatibilityToken: "cafe",
        json: false,
      },
    });
  });

  test("rejects missing flags, bad owners, mixed expect forms and unknown flags", () => {
    for (const argv of [
      [],
      ["--owner", "desktop"],
      VALID.slice(0, 4), // no expect form at all
      VALID.slice(0, 8), // token flag without a value
      ["--owner", "nobody", "--install-id", "install-a", "--expect-none", "--expect-revision", "0", "--expect-compatibility-token", "deadbeef"],
      [...VALID, "--expect-owner", "cli"], // both expect forms
      [...VALID, "--wat"],
      [...VALID, "positional"],
    ]) {
      expect(parseClaimArgs(argv).ok).toBe(false);
    }
  });
});

describe("runServiceClaim", () => {
  test("argument errors exit 64 with usage on stderr", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runServiceClaim(["--owner", "desktop"], {
      stdout: { log: value => lines.push(value) },
      stderr: { error: value => errors.push(value) },
    });
    expect(code).toBe(64);
    expect(lines).toEqual([]);
    expect(errors.join("\n")).toContain("Usage: ocx service claim");
  });

  test("a recorded claim prints one json document and exits 0", async () => {
    const lines: string[] = [];
    const ownership = { owner: "desktop", installId: "install-a", consentGeneration: 1 };
    const code = await runServiceClaim([...VALID, "--json"], {
      recordOwner: () => ({ kind: "owned", ownership, revision: 3 }),
      observeManagers: () => ({
        "service-registration": { status: "absent" },
        path: { status: "absent" },
      }),
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      schema: CLAIM_SCHEMA,
      ok: true,
      ownership,
      revision: 3,
    });
  });

  test("human output names the owner, install and generation", async () => {
    const lines: string[] = [];
    const code = await runServiceClaim(VALID, {
      recordOwner: () => ({
        kind: "owned",
        ownership: { owner: "desktop", installId: "install-a", consentGeneration: 2 },
        revision: 4,
      }),
      observeManagers: () => ({
        "service-registration": { status: "absent" },
        path: { status: "absent" },
      }),
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Recorded desktop as the runtime owner (install install-a, generation 2)");
  });

  test("a subject mismatch exits 1 with the error's code on the wire", async () => {
    const lines: string[] = [];
    const expected: ServiceOwnershipSubject = { kind: "none", revision: 0 };
    const actual: ServiceOwnershipSubject = {
      kind: "owned",
      ownership: { owner: "cli", installId: "npm-1", consentGeneration: 2 },
      revision: 5,
    };
    const code = await runServiceClaim([...VALID, "--json"], {
      recordOwner: () => { throw new ServiceOwnershipSubjectMismatchError(expected, actual); },
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schema: CLAIM_SCHEMA,
      ok: false,
      code: "service-ownership-subject-mismatch",
    });
  });

  test("an unreadable sandbox state refuses a real claim", async () => {
    const home = createTempHome("ocx-claim-refusal-");
    const homedir = spyOn(os, "homedir").mockReturnValue(home.root);
    try {
      expect(serviceStatePaths().every(path => path.startsWith(home.root))).toBe(true);
      mkdirSync(serviceStatePath());
      const lines: string[] = [];
      const code = await runServiceClaim([...VALID, "--json"], {
        stdout: { log: value => lines.push(value) },
      });
      expect(code).toBe(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        schema: CLAIM_SCHEMA, ok: false, code: "service-ownership-subject-unknown",
      });
      expect(statSync(serviceStatePath()).isDirectory()).toBe(true);
    } finally {
      try {
        homedir.mockRestore();
      } finally {
        home.remove();
      }
    }
  });
});
