import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../src/cli/registry";
import { DISPATCH_ALIASES, DISPATCH_COMMANDS, dispatchCommand, resolveDispatchCommand } from "../src/cli/dispatch";
import type { CliDispatchDeps } from "../src/cli/dispatch";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../src/config";
import { getAccountSet, removeCredential, saveCredential } from "../src/oauth/store";

/** Minimal fake deps. dispatchCommand only touches deps for real command
 * runners, which these tests never invoke, so an empty object is enough. */
const fakeDeps = {} as unknown as CliDispatchDeps;

describe("CLI dispatch command coverage", () => {
  test("every non-hidden registry command is dispatchable", () => {
    const aliasResolved = new Set([...DISPATCH_COMMANDS, ...DISPATCH_ALIASES.keys()]);
    const missing = CLI_COMMANDS.filter(entry => {
      if (entry.hidden) return false;
      // A visible command counts as dispatchable when it is a direct runner
      // key or an alias that resolves to one (setup/eject/remove/model).
      return !aliasResolved.has(entry.name);
    }).map(entry => entry.name);
    expect(missing).toEqual([]);
  });

  test("every dispatch alias resolves to a dispatchable command", () => {
    for (const [alias, target] of DISPATCH_ALIASES) {
      expect(DISPATCH_COMMANDS).toContain(target);
      expect(alias).not.toBe(target);
    }
  });
});

describe("CLI dispatch aliases", () => {
  test("canonical alias pairs resolve to their command", () => {
    expect(DISPATCH_ALIASES.get("setup")).toBe("init");
    expect(DISPATCH_ALIASES.get("eject")).toBe("restore");
    expect(DISPATCH_ALIASES.get("remove")).toBe("uninstall");
    expect(DISPATCH_ALIASES.get("model")).toBe("models");
  });

  test("resolveDispatchCommand maps each alias to its canonical runner key", () => {
    // The same resolver dispatchCommand uses for runner selection, exercised
    // at the resolution level so a regression in the lookup is caught.
    expect(resolveDispatchCommand("setup")).toBe("init");
    expect(resolveDispatchCommand("eject")).toBe("restore");
    expect(resolveDispatchCommand("remove")).toBe("uninstall");
    expect(resolveDispatchCommand("model")).toBe("models");
    // Canonical names resolve to themselves; unknown names resolve undefined.
    expect(resolveDispatchCommand("init")).toBe("init");
    expect(resolveDispatchCommand("definitely-not-a-command")).toBeUndefined();
    expect(resolveDispatchCommand(undefined)).toBeUndefined();
  });

  test("resolveDispatchCommand rejects inherited Object property names", () => {
    // commandRunners is a normal object; inherited names (__proto__,
    // constructor, toString) must not resolve as valid commands.
    expect(resolveDispatchCommand("__proto__")).toBeUndefined();
    expect(resolveDispatchCommand("constructor")).toBeUndefined();
    expect(resolveDispatchCommand("toString")).toBeUndefined();
  });
});

describe("dispatchCommand exit codes", () => {
  test("returns 0 for help forms", async () => {
    expect(await dispatchCommand({ kind: "help", command: "help", args: ["help"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "help", command: "--help", args: ["--help"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "help", command: "-h", args: ["-h"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "command", command: undefined, args: [] }, fakeDeps)).toBe(0);
  });

  test("returns 1 for an unknown command", async () => {
    const head = { kind: "command" as const, command: "definitely-not-a-command", args: ["definitely-not-a-command"] };
    expect(await dispatchCommand(head, fakeDeps)).toBe(1);
  });

  test("returns 1 for inherited Object property names", async () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      const head = { kind: "command" as const, command: name, args: [name] };
      expect(await dispatchCommand(head, fakeDeps), `${name} must be unknown`).toBe(1);
    }
  });

  test("forwards service arguments and preserves handler exit codes", async () => {
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 7;
      const successCalls: string[][] = [];
      const successDeps = {
        ...fakeDeps,
        args: ["service", "install", "--scheduler"],
        serviceCommand: async (...args: string[]) => {
          successCalls.push(args);
        },
      };

      expect(await dispatchCommand(
        { kind: "command", command: "service", args: successDeps.args },
        successDeps,
      )).toBe(0);
      expect(successCalls).toEqual([["install", "--scheduler"]]);

      for (const expected of [1, 2]) {
        const calls: string[][] = [];
        const deps = {
          ...fakeDeps,
          args: ["service", "install", "--scheduler"],
          serviceCommand: async (...args: string[]) => {
            calls.push(args);
            process.exitCode = expected;
          },
        };

        expect(await dispatchCommand(
          { kind: "command", command: "service", args: deps.args },
          deps,
        )).toBe(expected);
        expect(calls).toEqual([["install", "--scheduler"]]);
      }
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
  });
});

/**
 * `ocx health` probed once. A proxy that has only just bound can miss a single
 * probe while its event loop is still settling startup work, so health run
 * seconds after a service restart reported "Proxy not healthy" and exited 1 for
 * a proxy that was in fact serving. The stop paths already retry this exact race
 * under SERVICE_STOP_LIVENESS (#764); health did not.
 */
describe("health retries a just-started proxy", () => {
  test("passes a retry budget to findLiveProxy", async () => {
    const seen: (number | undefined)[] = [];
    const deps = {
      ...fakeDeps,
      args: ["health"],
      findLiveProxy: async (io?: { attempts?: number }) => {
        seen.push(io?.attempts);
        return { pid: 4242, port: 10100 } as never;
      },
    } as unknown as CliDispatchDeps;

    expect(await dispatchCommand({ kind: "command", command: "health", args: deps.args }, deps)).toBe(0);
    // More than one: a single attempt is the defect. The exact number is the
    // stop path's, and is asserted rather than inferred so a silent drop back to
    // one probe fails here.
    expect(seen).toEqual([3]);
  });

  test("still reports an absent proxy as unhealthy", async () => {
    const deps = {
      ...fakeDeps,
      args: ["health"],
      findLiveProxy: async () => null,
    } as unknown as CliDispatchDeps;

    expect(await dispatchCommand({ kind: "command", command: "health", args: deps.args }, deps)).toBe(1);
  });
});

/**
 * `handleStart` skipped the configured-port probe whenever the pid file and the
 * runtime-port record were both absent. That absence proves nothing: a
 * fallback-port sibling overwrites both records when it starts and removes them
 * when it stops, so `start` shadowed a healthy configured-port proxy with an
 * ephemeral-port copy and re-pointed client config at the copy.
 *
 * Source-level because the executable path binds real ports and spawns a real
 * child; this pins the one option that decides the behavior, next to the
 * `handleEnsure` call site that already had it right.
 */
describe("start probes the configured port before shadowing it (source-level)", () => {
  const cliSource = readFileSync(join(import.meta.dir, "../src/cli/index.ts"), "utf8");

  test("every findProxyOwnerBeforeJournalRecovery call site asks for the probe", () => {
    const calls = cliSource.match(/findProxyOwnerBeforeJournalRecovery\s*\(([^)]*)\)/g) ?? [];
    // The declaration plus both call sites (handleStart, handleEnsure).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const invocations = calls.filter(call => !call.includes("options:"));
    expect(invocations.length).toBe(2);
    for (const call of invocations) {
      expect(call).toContain("probeConfiguredPort: true");
    }
  });

  test("the probe option still gates on an explicit true", () => {
    // A truthy-but-not-true default would silently probe for callers that pass
    // nothing, which is a different behavior than the one asserted above.
    expect(cliSource).toContain("options.probeConfiguredPort === true");
  });
});

describe("logout parses argv before touching the credential store", () => {
  /**
   * `ocx logout --json` used to lowercase `--json`, pass it to removeCredential as a provider
   * name, print "Logged out of --json." and exit 0. A caller that can only see the exit code
   * got a success for an operation that removed nothing.
   *
   * The severity is not "a wasted call". `normalizeAuthStore` copies every top-level key it
   * finds, so a hand-edited, legacy, or corrupted auth.json carrying a `--json` key would lose
   * that key's active account -- and the key itself if it was the last account. These
   * assertions therefore compare the store FILE before and after, which proves the store was
   * never reached rather than trusting a stubbed function.
   *
   * Safe against the developer's real store: `tests/preload.ts` sandboxes HOME and
   * OPENCODEX_HOME for every invocation, wrapped or bare, so this writes to a temp home.
   */
  const authPath = (): string => join(getConfigDir(), "auth.json");
  const snapshot = (): string | null => existsSync(authPath()) ? readFileSync(authPath(), "utf8") : null;

  /**
   * Seed a real credential before every case, because otherwise these assertions are vacuous:
   * the sandbox home starts with no `auth.json`, so `before` and `after` would both be null and
   * a comparison between them would pass even if the command HAD written to the store. Found by
   * probing the sandbox rather than by reading the test -- the file genuinely does not exist at
   * `<tmp>/.opencodex/auth.json` when the suite starts.
   *
   * With a credential present the file exists, so "byte-identical before and after" is a claim
   * with content: any write, including the destructive `--json`-as-provider-name path, changes it.
   */
  const seed = async (): Promise<string> => {
    await saveCredential("claude", { access: "seed-access", refresh: "seed-refresh", expires: Date.now() + 600_000 });
    const contents = snapshot();
    expect(contents, "seeded auth.json must exist or the non-mutation assertions are vacuous").not.toBeNull();
    return contents!;
  };

  const runLogout = async (args: string[]): Promise<{ code: number; out: string[]; err: string[]; before: string | null; after: string | null }> => {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...v: unknown[]) => out.push(v.join(" "));
    console.error = (...v: unknown[]) => err.push(v.join(" "));
    const before = snapshot();
    try {
      const argv = ["logout", ...args];
      const code = await dispatchCommand(
        { kind: "command", command: "logout", args: argv },
        { ...fakeDeps, args: argv } as unknown as CliDispatchDeps,
      );
      return { code, out, err, before, after: snapshot() };
    } finally {
      console.log = log;
      console.error = error;
    }
  };

  test("a flag is never read as a provider name and leaves the store byte-identical", async () => {
    await seed();
    const result = await runLogout(["--json"]);
    expect(result.code).toBe(2);
    expect(result.before).not.toBeNull();
    expect(result.after).toEqual(result.before);
    expect(result.out.join("")).not.toContain("Logged out");
  });

  test("an omitted provider is a usage error, not a no-op success", async () => {
    await seed();
    const result = await runLogout([]);
    expect(result.code).toBe(2);
    expect(result.before).not.toBeNull();
    expect(result.after).toEqual(result.before);
  });

  test("an unknown option is rejected and the store is untouched", async () => {
    await seed();
    const result = await runLogout(["claude", "--wat"]);
    expect(result.code).toBe(2);
    expect(result.before).not.toBeNull();
    expect(result.after).toEqual(result.before);
  });

  test("extra positionals are a usage error", async () => {
    await seed();
    const result = await runLogout(["claude", "gemini"]);
    expect(result.code).toBe(2);
    expect(result.before).not.toBeNull();
    expect(result.after).toEqual(result.before);
  });

  test("a provider with no stored credential is not-found, not usage", async () => {
    // 4 rather than 2: the call was well-formed, the thing simply is not there. Collapsing
    // those two into one code is what made the account family unscriptable (#2698).
    await seed();
    const result = await runLogout(["gemini", "--json"]);
    expect(result.code).toBe(4);
    expect(result.before).not.toBeNull();
    expect(result.after).toEqual(result.before);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, removed: false, reason: "not_found" });
  });

  test("a stored provider is removed and reported in both modes", async () => {
    await seed();
    expect(getAccountSet("claude")).not.toBeNull();

    const human = await runLogout(["claude"]);
    expect(human.code).toBe(0);
    expect(human.out.join("")).toContain("Logged out of claude.");
    expect(getAccountSet("claude")).toBeNull();

    // Order-independent, and idempotent: a second logout is now a clean not-found.
    await seed();
    const json = await runLogout(["--json", "claude"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({ ok: true, provider: "claude", removed: true });
    expect(getAccountSet("claude")).toBeNull();
  });
});

describe("logout reports only what it actually did", () => {
  /**
   * Two defects an adversarial audit found in the first version of the argv fix, both
   * reproduced before being fixed.
   *
   * The first was the same bug one dash shorter: the parser treated only `--*` as options, so
   * `ocx logout -j` used `-j` as the provider name. With a `-j` key in the store -- which
   * `normalizeAuthStore` happily preserves -- that deleted a credential and exited 0.
   *
   * The second was a non-atomic read-then-remove. `getAccountSet` followed by
   * `removeCredential` leaves a window where a concurrent logout removes the same account and
   * both callers report a removal. `removeCredential` now returns its disposition from inside
   * the serialized mutation, so only the caller that actually removed something says so.
   */
  const authPath = (): string => join(getConfigDir(), "auth.json");
  const snapshot = (): string | null => existsSync(authPath()) ? readFileSync(authPath(), "utf8") : null;

  const run = async (args: string[]): Promise<{ code: number; out: string[] }> => {
    const out: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...v: unknown[]) => out.push(v.join(" "));
    console.error = (...v: unknown[]) => out.push(v.join(" "));
    const argv = ["logout", ...args];
    try {
      const code = await dispatchCommand(
        { kind: "command", command: "logout", args: argv },
        { ...fakeDeps, args: argv } as unknown as CliDispatchDeps,
      );
      return { code, out };
    } finally {
      console.log = log;
      console.error = error;
    }
  };

  test("a short flag is an option, not a provider, and its sentinel credential survives", async () => {
    // The sentinel is the point: a store key named exactly like the malformed token. Seeding
    // only a well-named provider cannot detect this class of bug, because removing `-j` would
    // leave the rest of the file byte-identical.
    await saveCredential("-j", { access: "sentinel", refresh: "r", expires: Date.now() + 600_000 });
    expect(getAccountSet("-j")).not.toBeNull();

    const result = await run(["-j"]);
    expect(result.code).toBe(2);
    expect(getAccountSet("-j"), "a flag must never reach the store as a provider name").not.toBeNull();
    expect(result.out.join("")).not.toContain("Logged out");
  });

  test("a --json=... spelling is rejected rather than treated as a provider", async () => {
    await saveCredential("--json=true", { access: "sentinel", refresh: "r", expires: Date.now() + 600_000 });
    const result = await run(["--json=true"]);
    expect(result.code).toBe(2);
    expect(getAccountSet("--json=true")).not.toBeNull();
  });

  test("the malformed-token sentinel survives a --json invocation", async () => {
    await saveCredential("--json", { access: "sentinel", refresh: "r", expires: Date.now() + 600_000 });
    const before = snapshot();
    const result = await run(["--json"]);
    expect(result.code).toBe(2);
    expect(getAccountSet("--json"), "the store must not be reached at all").not.toBeNull();
    expect(snapshot()).toEqual(before);
  });

  test("concurrent logouts: exactly one reports the removal", async () => {
    await saveCredential("gemini", { access: "a", refresh: "r", expires: Date.now() + 600_000 });
    const [first, second] = await Promise.all([run(["gemini"]), run(["gemini"])]);
    // One removal (0) and one not-found (4). Two zeroes would mean a caller claimed credit for
    // a mutation it did not perform, which is what the preflight allowed.
    expect([first.code, second.code].sort()).toEqual([0, 4]);
    expect(getAccountSet("gemini")).toBeNull();
  });

  test("removeCredential returns its disposition from inside the mutation", async () => {
    await saveCredential("claude", { access: "a", refresh: "r", expires: Date.now() + 600_000 });
    expect(await removeCredential("claude")).toBe("removed");
    expect(await removeCredential("claude")).toBe("not-found");
    expect(await removeCredential("never-stored")).toBe("not-found");
  });
});

describe("logout rejects anything that is not a possible provider id", () => {
  /**
   * Third round on the same defect, which is why the fix stopped naming spellings.
   *
   * `--json` was rejected, then `-j` was not; `-j` was rejected, then `—json` with a Unicode
   * em dash was not. Each patch enumerated one more variant of "looks like a flag" while the
   * store kept accepting anything that did not match that enumeration. The rule is now stated
   * positively via `isValidProviderName`: start and end alphanumeric, internal `._-` allowed.
   * Everything that cannot be a provider id is refused before the store is opened.
   *
   * Real providers contain dashes -- `github-copilot`, `google-antigravity` -- so a blanket
   * dash ban would have been wrong; this is why the check is a shape rule, not a character ban.
   */
  const run = async (arg: string): Promise<number> => {
    const argv = ["logout", arg];
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      return await dispatchCommand(
        { kind: "command", command: "logout", args: argv },
        { ...fakeDeps, args: argv } as unknown as CliDispatchDeps,
      );
    } finally {
      console.log = log;
      console.error = error;
    }
  };

  test("Unicode dash tokens never reach the store", async () => {
    // Em dash and minus sign. Both survived the ASCII-only guard and deleted sentinels.
    for (const token of ["\u2014json", "\u2212json", "\u2013j"]) {
      await saveCredential(token, { access: "sentinel", refresh: "r", expires: Date.now() + 600_000 });
      expect(await run(token), `${JSON.stringify(token)} must be rejected`).toBe(2);
      expect(getAccountSet(token), `${JSON.stringify(token)} sentinel must survive`).not.toBeNull();
    }
  });

  test("reserved and malformed names are refused before any store access", async () => {
    // `__proto__` is asserted without a sentinel: seeding it is impossible, because
    // `saveCredential("__proto__")` corrupts the store object itself -- which is precisely why
    // the validator reserves it. Trying to seed it threw inside the store, and that failure is
    // the argument for rejecting the name at the CLI boundary.
    expect(await run("__proto__")).toBe(2);
    for (const token of ["policy", "-lead", "trail-", ".dot"]) {
      await saveCredential(token, { access: "sentinel", refresh: "r", expires: Date.now() + 600_000 });
      expect(await run(token), `${token} must be rejected`).toBe(2);
      expect(getAccountSet(token), `${token} sentinel must survive`).not.toBeNull();
    }
  });

  test("providers that legitimately contain dashes still work", async () => {
    // The guard must not overshoot: these are real provider ids from listOAuthProviders().
    for (const provider of ["github-copilot", "google-antigravity", "command-code"]) {
      await saveCredential(provider, { access: "a", refresh: "r", expires: Date.now() + 600_000 });
      expect(await run(provider), `${provider} must be accepted`).toBe(0);
      expect(getAccountSet(provider)).toBeNull();
    }
  });

  test("an uppercase provider is normalised, not rejected", async () => {
    await saveCredential("github-copilot", { access: "a", refresh: "r", expires: Date.now() + 600_000 });
    expect(await run("GITHUB-COPILOT")).toBe(0);
    expect(getAccountSet("github-copilot")).toBeNull();
  });
});

describe("doctor refuses --json rather than printing prose as success", () => {
  const runDoctor = async (flag: string): Promise<number> => {
    const argv = ["doctor", flag];
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      return await dispatchCommand(
        { kind: "command", command: "doctor", args: argv },
        { ...fakeDeps, args: argv } as unknown as CliDispatchDeps,
      );
    } finally {
      console.log = log;
      console.error = error;
    }
  };

  test("exact --json, --json=true, and Unicode dashes all exit 2", async () => {
    for (const flag of ["--json", "--json=true", "\u2014json"]) {
      expect(await runDoctor(flag), `${JSON.stringify(flag)} must be refused`).toBe(2);
    }
  });
});
