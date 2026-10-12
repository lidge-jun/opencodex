import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { serviceChildOwnershipDecisionForClassifiedChild } from "../../src/service/service-child-ownership";
import type { ServiceOwnershipResolution } from "../../src/service/state";
import {
  bindAndPublishStartOwnership,
  StartOwnershipRollbackUncertainError,
} from "../../src/cli/start-ownership-publication";

function fixture(options: {
  failPid?: boolean;
  failRuntime?: boolean;
  failStop?: boolean;
  failRemoveRuntime?: boolean;
  failRemovePid?: boolean;
} = {}) {
  const events: string[] = [];
  const deps = {
    acquireLease: () => ({ release: () => { events.push("release"); } }),
    bind: async () => { events.push("bind"); return { id: 1 }; },
    writePid: () => {
      events.push("pid");
      if (options.failPid) throw new Error("pid write failed");
    },
    writeRuntime: () => {
      events.push("runtime");
      if (options.failRuntime) throw new Error("runtime write failed");
    },
    stopBound: async () => {
      events.push("stop");
      if (options.failStop) throw new Error("stop failed");
    },
    removeRuntime: () => {
      events.push("remove-runtime");
      if (options.failRemoveRuntime) throw new Error("runtime cleanup failed");
    },
    removePid: () => {
      events.push("remove-pid");
      if (options.failRemovePid) throw new Error("pid cleanup failed");
    },
  };
  return { events, deps };
}

describe("start ownership publication", () => {
  test("a desktop claim committed after the early check prevents listener and record publication", async () => {
    let ownership: ServiceOwnershipResolution = { kind: "none", revision: 0 };
    const resolve = () => ownership;
    expect(serviceChildOwnershipDecisionForClassifiedChild(true, resolve)).toEqual({ kind: "proceed" });
    const events: string[] = [];
    await expect(bindAndPublishStartOwnership({
      acquireLease: () => {
        // The desktop commits while the child is between its early check and lease.
        ownership = { kind: "owned", ownership: { owner: "desktop", installId: "app", consentGeneration: 1 }, revision: 1 };
        events.push("lease");
        return { release: () => { events.push("release"); } };
      },
      bind: async () => {
        const decision = serviceChildOwnershipDecisionForClassifiedChild(true, resolve);
        if (decision.kind === "stay-out") throw new Error(decision.refusal);
        events.push("listener-bound");
        return {};
      },
      writePid: () => { events.push("pid"); },
      writeRuntime: () => { events.push("runtime"); },
      stopBound: () => { events.push("stop"); },
      removeRuntime: () => { events.push("remove-runtime"); },
      removePid: () => { events.push("remove-pid"); },
    })).rejects.toThrow(/desktop app owns the runtime/);
    expect(events).toEqual(["lease", "release"]);
  });
  test("the service-child owner is rechecked inside the lease-held bind before port choice", () => {
    const cli = readFileSync(repoPath("src/cli/index.ts"), "utf8");
    const bind = cli.slice(cli.indexOf("bind: async () => {", cli.indexOf("bindAndPublishStartOwnership({")));
    const recheck = bind.indexOf("serviceChildOwnershipDecisionForClassifiedChild(");
    expect(recheck).toBeGreaterThan(-1);
    expect(recheck).toBeLessThan(bind.indexOf("chooseListenPort("));
    expect(recheck).toBeLessThan(bind.indexOf("startServer("));
  });
  test("success releases only after bind and both records", async () => {
    const { events, deps } = fixture();
    await bindAndPublishStartOwnership(deps);
    expect(events).toEqual(["bind", "pid", "runtime", "release"]);
  });

  test("a bind refusal releases without publishing or rollback", async () => {
    const { events, deps } = fixture();
    deps.bind = async () => { events.push("bind-refused"); throw new Error("refused"); };
    await expect(bindAndPublishStartOwnership(deps)).rejects.toThrow("refused");
    expect(events).toEqual(["bind-refused", "release"]);
  });

  for (const failure of ["pid", "runtime"] as const) {
    test(`${failure} publication failure stops and cleans before release`, async () => {
      const { events, deps } = fixture({
        failPid: failure === "pid",
        failRuntime: failure === "runtime",
      });
      await expect(bindAndPublishStartOwnership(deps)).rejects.toThrow(`${failure} write failed`);
      expect(events).toEqual(failure === "pid"
        ? ["bind", "pid", "stop", "remove-runtime", "remove-pid", "release"]
        : ["bind", "pid", "runtime", "stop", "remove-runtime", "remove-pid", "release"]);
    });
  }

  test("listener rollback uncertainty cleans records but retains the lease", async () => {
    const { events, deps } = fixture({
      failRuntime: true,
      failStop: true,
    });
    await expect(bindAndPublishStartOwnership(deps)).rejects.toBeInstanceOf(StartOwnershipRollbackUncertainError);
    expect(events).toEqual(["bind", "pid", "runtime", "stop", "remove-runtime", "remove-pid"]);
  });

  test("cleanup failures still attempt both records and release after the listener stopped", async () => {
    const { events, deps } = fixture({ failRuntime: true, failRemoveRuntime: true, failRemovePid: true });
    await expect(bindAndPublishStartOwnership(deps)).rejects.toBeInstanceOf(AggregateError);
    expect(events).toEqual(["bind", "pid", "runtime", "stop", "remove-runtime", "remove-pid", "release"]);
  });
});
