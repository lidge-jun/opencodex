import { describe, expect, test } from "bun:test";
import {
  assessServiceTakeoverCompatibility,
  registeredManagingCliInvocation,
  type ManagingCliObservation,
} from "../../src/service/ownership-compatibility";
import type { ServiceInstallState, ServiceOwnershipSubject } from "../../src/service/state";

const SUBJECT: ServiceOwnershipSubject = { kind: "none", revision: 7 };
const OWNERSHIP_AWARE_STATE: ServiceInstallState = {
  version: 2,
  codexHome: "/codex",
  opencodexHome: "/opencodex",
  backend: "scheduler",
  revision: 7,
  ownershipProtocolVersion: 1,
};

const absent: ManagingCliObservation = { status: "absent" };
const observed = (version: string, identity = `manager-${version}`): ManagingCliObservation => ({
  status: "observed", version, identity,
});

function assess(options: {
  state?: ServiceInstallState | null;
  service?: ManagingCliObservation;
  path?: ManagingCliObservation;
} = {}) {
  return assessServiceTakeoverCompatibility({
    state: options.state === undefined ? OWNERSHIP_AWARE_STATE : options.state,
    subject: SUBJECT,
    managers: {
      "service-registration": options.service ?? observed("2.61.0", "registered-manager"),
      path: options.path ?? observed("2.61.0", "path-manager"),
    },
  });
}

describe("permanent takeover compatibility", () => {
  test("the preserved registration resolves to the exact baked invocation", () => {
    expect(registeredManagingCliInvocation({
      ...OWNERSHIP_AWARE_STATE,
      bunPath: "/runtime/bun",
      cliPath: "/package/src/cli/index.ts",
    })).toEqual({
      status: "resolved", executable: "/runtime/bun", args: ["/package/src/cli/index.ts"],
    });
    expect(registeredManagingCliInvocation({
      ...OWNERSHIP_AWARE_STATE,
      launcherPath: "/bin/ocx",
    })).toEqual({ status: "resolved", executable: "/bin/ocx", args: [] });
  });

  test("every managing CLI must be ownership-aware", () => {
    expect(assess({ path: observed("2.60.0") })).toMatchObject({
      kind: "blocked", reason: "managing-cli-unsupported",
    });
    expect(assess({ service: observed("2.61.0"), path: observed("2.62.0") })).toMatchObject({
      kind: "supported", protocolVersion: 1,
    });
  });

  test("unknown, malformed and prerelease observations do not authorize takeover", () => {
    expect(assess({ path: { status: "unknown", reason: "probe timed out" } })).toMatchObject({
      kind: "blocked", reason: "managing-cli-unknown",
    });
    for (const version of ["garbage", "2.61.0-preview.1", "2.60.99"]) {
      expect(assess({ path: observed(version) })).toMatchObject({
        kind: "blocked", reason: "managing-cli-unsupported",
      });
    }
  });

  test("a preserved service registration needs the state protocol marker too", () => {
    expect(assess({ state: { ...OWNERSHIP_AWARE_STATE, ownershipProtocolVersion: undefined } }))
      .toMatchObject({ kind: "blocked", reason: "service-protocol-unsupported" });
    expect(assess({ state: null, service: absent, path: observed("2.61.0") }))
      .toMatchObject({ kind: "supported" });
  });

  test("an unobserved manager set cannot retroactively protect an older CLI", () => {
    expect(assess({ state: null, service: absent, path: absent })).toMatchObject({
      kind: "blocked", reason: "managing-cli-unobserved",
    });
  });

  test("the compatibility token binds both manager identities and the approved subject", () => {
    const original = assess();
    const replacedPath = assess({ path: observed("2.61.0", "different-path-manager") });
    const differentSubject = assessServiceTakeoverCompatibility({
      state: OWNERSHIP_AWARE_STATE,
      subject: { kind: "none", revision: 8 },
      managers: {
        "service-registration": observed("2.61.0", "registered-manager"),
        path: observed("2.61.0", "path-manager"),
      },
    });
    expect(original.kind).toBe("supported");
    expect(replacedPath.kind).toBe("supported");
    expect(differentSubject.kind).toBe("supported");
    if (original.kind === "supported" && replacedPath.kind === "supported" && differentSubject.kind === "supported") {
      expect(replacedPath.token).not.toBe(original.token);
      expect(differentSubject.token).not.toBe(original.token);
    }
  });
});
