import { describe, expect, test } from "bun:test";
import { OCX_ROUTING_MARKER_LINE } from "../../src/codex/injected-marker";
import type { CodexInjectResult, InjectCodexOptions } from "../../src/codex/inject";
import {
  ROUTING_HEAL_LOCK_TIMEOUT_MS,
  ROUTING_HEAL_MAX_ATTEMPTS,
  ROUTING_HEAL_MAX_HEALS,
  ROUTING_HEAL_RECHECK_MS,
  ROUTING_HEAL_REFUSED_BACKOFF_MS,
  ROUTING_HEAL_TICK_MS,
  ROUTING_HEAL_WINDOW_MS,
  startCodexRoutingHealer,
  type CodexRoutingHealGates,
  type CodexRoutingHealerDeps,
} from "../../src/codex/routing-healer";
import type { EndpointLiveness } from "../../src/server/proxy-liveness";
import type { OcxConfig } from "../../src/types";

const OWN_PORT = 10100;
const DEAD_PORT = 10199;
const BASE_CONFIG = { port: OWN_PORT, providers: {}, defaultProvider: "openai" } as unknown as OcxConfig;

function routedAt(port: number): string {
  const url = `http://127.0.0.1:${port}/v1`;
  return `${OCX_ROUTING_MARKER_LINE}\nopenai_base_url = "${url}"\n${OCX_ROUTING_MARKER_LINE}\nexperimental_realtime_ws_base_url = "${url}"\n`;
}

/**
 * A manual clock and scheduler. `tick()` advances the clock by the scheduled delay and runs the
 * one pending callback to completion, so a test reads the state that tick produced.
 */
function harness(options: {
  probe?: (port: number) => EndpointLiveness | Promise<EndpointLiveness>;
  inject?: (port: number, config: OcxConfig, options: InjectCodexOptions) => CodexInjectResult | Promise<CodexInjectResult>;
  gates?: Partial<CodexRoutingHealGates>;
  config?: OcxConfig;
} = {}) {
  let now = 1_000;
  let content: string | null = routedAt(DEAD_PORT);
  const queue: Array<{ fn: () => void; ms: number }> = [];
  const probes: number[] = [];
  const injects: Array<{ port: number; options: InjectCodexOptions }> = [];
  const warnings: string[] = [];
  let settle: Promise<void> = Promise.resolve();
  const deps: CodexRoutingHealerDeps = {
    scheduleFn: (fn, ms) => {
      const entry = { fn, ms };
      queue.push(entry);
      return { cancel: () => { const at = queue.indexOf(entry); if (at !== -1) queue.splice(at, 1); } };
    },
    now: () => now,
    readConfig: () => content,
    readJournaled: () => ({ openaiBaseUrl: null, realtimeWsBaseUrl: null }),
    probe: async target => { probes.push(target.port); return options.probe?.(target.port) ?? "dead"; },
    inject: async (port, config, injectOptions) => {
      injects.push({ port, options: injectOptions });
      const result = await (options.inject?.(port, config, injectOptions) ?? { success: true, message: "Injected" });
      if (result.success && result.status !== "skipped") content = routedAt(port);
      return result;
    },
    gates: {
      siblingOfLivePort: () => null,
      exiting: () => false,
      runtimePortOfThisProcess: () => OWN_PORT,
      loadConfig: () => options.config ?? BASE_CONFIG,
      clientConnected: () => false,
      clientJournalOwner: () => false,
      ...options.gates,
    },
    log: { warn: (line: string) => { warnings.push(line); } },
    debugLine: () => {},
  };
  const handle = startCodexRoutingHealer({ port: OWN_PORT, config: options.config ?? BASE_CONFIG, deps });
  return {
    handle,
    probes,
    injects,
    warnings,
    get pending() { return queue.length; },
    setContent(next: string | null) { content = next; },
    get content() { return content; },
    advance(ms: number) { now += ms; },
    async tick(): Promise<boolean> {
      const entry = queue.shift();
      if (!entry) return false;
      now += entry.ms;
      entry.fn();
      // The scheduled callback starts an async tick; drain it before the test looks.
      for (let i = 0; i < 50; i++) await settle;
      await new Promise(resolve => setTimeout(resolve, 0));
      settle = Promise.resolve();
      return true;
    },
    async ticks(count: number) { for (let i = 0; i < count; i++) await this.tick(); },
  };
}

describe("codex routing healer", () => {
  test("dead on probes spanning 20 s heals exactly once through the plain injector", async () => {
    const h = harness();
    await h.ticks(2); // first dead probe, then a second one only 10 s later
    expect(h.injects).toHaveLength(0);
    await h.tick(); // 20 s of dead probes: final probe, then the write
    expect(h.injects).toHaveLength(1);
    const call = h.injects[0]!;
    expect(call.port).toBe(OWN_PORT);
    expect(call.options.lockTimeoutMs).toBe(ROUTING_HEAL_LOCK_TIMEOUT_MS);
    expect(typeof call.options.beforeClientWrite).toBe("function");
    // No catalog path: the existing model_catalog_json stays and nothing is gathered.
    expect("catalogPath" in call.options).toBe(false);
    expect("routingTarget" in call.options).toBe(false);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("127.0.0.1:10199");
    expect(h.warnings[0]).toContain(`port ${OWN_PORT}`);
    expect(h.handle.lastHeal()).toMatchObject({ fromUrls: ["http://127.0.0.1:10199/v1"], toPort: OWN_PORT });
    await h.ticks(5);
    expect(h.injects).toHaveLength(1);
    expect(h.pending).toBe(1);
  });

  test("dead then live never writes and logs the live owner once", async () => {
    let live = false;
    const h = harness({ probe: () => (live ? "live" : "dead") });
    await h.tick();
    live = true;
    await h.ticks(8);
    expect(h.injects).toHaveLength(0);
    expect(h.warnings).toEqual([`Codex routing points at another running opencodex on port ${DEAD_PORT}; leaving it.`]);
  });

  test("an unknown streak never writes", async () => {
    const h = harness({ probe: () => "unknown" });
    await h.ticks(12);
    expect(h.injects).toHaveLength(0);
    expect(h.warnings).toHaveLength(0);
  });

  test("an unknown answer is asked again at the recheck pace, not on every tick", async () => {
    const h = harness({ probe: () => "unknown" });
    await h.ticks(12);
    // 120 s of ticks: probes at 0 s, 30 s, 60 s and 90 s only.
    expect(ROUTING_HEAL_RECHECK_MS / ROUTING_HEAL_TICK_MS).toBe(3);
    expect(h.probes).toHaveLength(4);
  });

  test("unchanged, correct routing costs one read per tick and no probe", async () => {
    const h = harness();
    h.setContent(routedAt(OWN_PORT));
    await h.ticks(6);
    expect(h.probes).toHaveLength(0);
    expect(h.injects).toHaveLength(0);
  });

  const closed: Array<[string, Partial<CodexRoutingHealGates> | undefined, OcxConfig | undefined]> = [
    ["sibling", { siblingOfLivePort: () => 10100 }, undefined],
    ["hub-gated", undefined, { ...BASE_CONFIG, runtimeRole: "hub" } as OcxConfig],
    ["Codex OFF", undefined, { ...BASE_CONFIG, clientIntegrations: { codex: false } } as OcxConfig],
    ["client connected", { clientConnected: () => true }, undefined],
    ["client journal owner", { clientJournalOwner: () => true }, undefined],
    ["recycling or draining", { exiting: () => true }, undefined],
    ["runtime record not ours", { runtimePortOfThisProcess: () => 10200 }, undefined],
    ["admission-token routing", undefined, { ...BASE_CONFIG, hostname: "0.0.0.0" } as OcxConfig],
  ];
  for (const [name, gates, config] of closed) {
    test(`a closed gate never writes: ${name}`, async () => {
      const h = harness({ gates, config });
      await h.ticks(10);
      expect(h.injects).toHaveLength(0);
    });
  }

  test("an external provider appearing in config.toml never writes", async () => {
    const h = harness();
    h.setContent(`model_provider = "litellm"\n${routedAt(DEAD_PORT)}`);
    await h.ticks(10);
    expect(h.injects).toHaveLength(0);
    expect(h.probes).toHaveLength(0);
  });

  test("a sibling mark stops the loop for good", async () => {
    let sibling: number | null = null;
    const h = harness({ gates: { siblingOfLivePort: () => sibling } });
    await h.tick();
    sibling = 10100;
    await h.tick();
    expect(h.pending).toBe(0);
  });

  test("a busy lock is retried on the next tick; a refusal backs off for ten minutes", async () => {
    let answer: CodexInjectResult = { success: false, retryable: true, message: "busy" };
    const h = harness({ inject: () => answer });
    await h.ticks(3);
    expect(h.injects).toHaveLength(1);
    answer = { success: false, retryable: false, message: "Codex configuration was not written: refused" };
    await h.tick();
    expect(h.injects).toHaveLength(2);
    expect(h.warnings.some(line => line.includes("refused"))).toBe(true);
    const ticksInBackoff = ROUTING_HEAL_REFUSED_BACKOFF_MS / ROUTING_HEAL_TICK_MS - 1;
    await h.ticks(ticksInBackoff);
    expect(h.injects).toHaveLength(2);
    answer = { success: true, message: "Injected" };
    await h.ticks(4);
    expect(h.injects).toHaveLength(3);
  });

  test("a refusal's backoff ends as soon as routing is not foreign any more", async () => {
    let answer: CodexInjectResult = { success: false, retryable: false, message: "Codex configuration was not written: refused" };
    const h = harness({ inject: () => answer });
    await h.ticks(3);
    expect(h.injects).toHaveLength(1);
    expect(h.warnings.filter(line => line.includes("refused"))).toHaveLength(1);
    h.setContent(routedAt(OWN_PORT)); // `ocx sync` repaired it
    await h.tick();
    answer = { success: true, message: "Injected" };
    h.setContent(routedAt(DEAD_PORT)); // another instance re-pointed it and died
    await h.ticks(3);
    expect(h.injects).toHaveLength(2);
  });

  test("a refusal that raced another write of config.toml is an abort: no backoff, no warning", async () => {
    let first = true;
    const h = harness({
      inject: () => {
        if (!first) return { success: true, message: "Injected" };
        first = false;
        // The Codex app rewrote the file between the plan and the lock; routing still names 10199.
        h.setContent(`${routedAt(DEAD_PORT)}# rewritten by the Codex app\n`);
        return { success: false, retryable: false, message: "Codex configuration was not written: The admitted state changed before the commit could be made under the lock." };
      },
    });
    await h.ticks(3);
    expect(h.injects).toHaveLength(1);
    expect(h.warnings).toHaveLength(0);
    await h.ticks(3); // a fresh dead streak over the rewritten bytes, then the heal
    expect(h.injects).toHaveLength(2);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("re-pointed it at this proxy");
  });

  test("a write that throws after routing moved is an abort: no backoff, no warning", async () => {
    let first = true;
    const h = harness({
      probe: port => (port === 10300 ? "live" : "dead"),
      inject: () => {
        if (!first) return { success: true, message: "Injected" };
        first = false;
        h.setContent(routedAt(10300)); // another owner re-pointed it at itself
        throw new Error("The Codex transition could not be published: conflict.");
      },
    });
    await h.ticks(3);
    expect(h.injects).toHaveLength(1);
    expect(h.warnings.some(line => line.includes("failed"))).toBe(false);
    await h.tick();
    expect(h.warnings).toEqual(["Codex routing points at another running opencodex on port 10300; leaving it."]);
  });

  test("a failure line carries only the first message line, with home paths masked", async () => {
    const h = harness({
      inject: () => { throw new Error("could not restore /home/alice/.codex/config.toml\n    at restoreCodexPreImages"); },
    });
    await h.ticks(3);
    expect(h.injects).toHaveLength(1);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("/home/[USER]/.codex/config.toml");
    expect(h.warnings[0]).not.toContain("alice");
    expect(h.warnings[0]).not.toContain("restoreCodexPreImages");
  });

  test("the rate cap pauses attempts, and probes, after repeated busy locks", async () => {
    const h = harness({ inject: () => ({ success: false, retryable: true, message: "busy" }) });
    await h.ticks(2 + ROUTING_HEAL_MAX_ATTEMPTS + 10);
    expect(h.injects).toHaveLength(ROUTING_HEAL_MAX_ATTEMPTS);
    expect(h.warnings.filter(line => line.includes("paused"))).toHaveLength(1);
    const probesWhilePaused = h.probes.length;
    await h.ticks(30);
    expect(h.probes).toHaveLength(probesWhilePaused);
    expect(h.pending).toBe(1);
  });

  test("the flap cap pauses until the oldest heal leaves the hour, then heals again", async () => {
    const h = harness();
    for (let heal = 0; heal < ROUTING_HEAL_MAX_HEALS; heal++) {
      h.setContent(routedAt(DEAD_PORT));
      await h.ticks(3);
    }
    expect(h.injects).toHaveLength(ROUTING_HEAL_MAX_HEALS);
    h.setContent(routedAt(DEAD_PORT));
    await h.ticks(3); // proven dead again: a fourth heal within the hour is needed
    expect(h.injects).toHaveLength(ROUTING_HEAL_MAX_HEALS);
    expect(h.warnings.filter(line => line.includes("pauses until that hour has passed"))).toHaveLength(1);
    // Paused, never stopped: the timer stays armed, and neither probes nor warnings repeat.
    expect(h.pending).toBe(1);
    const probesWhilePaused = h.probes.length;
    await h.ticks(30);
    expect(h.probes).toHaveLength(probesWhilePaused);
    expect(h.warnings.filter(line => line.includes("pauses until"))).toHaveLength(1);
    h.advance(ROUTING_HEAL_WINDOW_MS);
    await h.ticks(2); // a fresh streak: two probes 10 s apart are not proof yet
    expect(h.injects).toHaveLength(ROUTING_HEAL_MAX_HEALS);
    await h.tick();
    expect(h.injects).toHaveLength(ROUTING_HEAL_MAX_HEALS + 1);
    expect(h.content).toBe(routedAt(OWN_PORT));
  });

  test("the under-lock guard aborts when routing moved after the probe", async () => {
    const h = harness({
      inject: (_port, _config, options) => {
        h.setContent(routedAt(10300)); // another writer, between the final probe and the lock
        options.beforeClientWrite!();
        return { success: true, message: "Injected" };
      },
    });
    await h.ticks(3);
    expect(h.injects).toHaveLength(1);
    expect(h.content).toBe(routedAt(10300));
    expect(h.warnings).toHaveLength(0);
    expect(h.handle.lastHeal()).toBeNull();
  });

  test("stop() while the final probe is out never writes", async () => {
    let release: (answer: EndpointLiveness) => void = () => {};
    let calls = 0;
    const h = harness({
      probe: () => (++calls < 4 ? "dead" : new Promise<EndpointLiveness>(resolve => { release = resolve; })),
    });
    await h.ticks(3); // the third tick proves the streak and sends the final probe
    expect(calls).toBe(4);
    h.handle.stop();
    release("dead");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.injects).toHaveLength(0);
    expect(h.pending).toBe(0);
  });

  test("stop() cancels the pending timer", async () => {
    const h = harness();
    await h.tick();
    expect(h.pending).toBe(1);
    h.handle.stop();
    expect(h.pending).toBe(0);
  });
});
