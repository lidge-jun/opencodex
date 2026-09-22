import { describe, expect, test } from "bun:test";
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
