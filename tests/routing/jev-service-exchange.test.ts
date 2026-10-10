import { describe, expect, test } from "bun:test";
import { parseJevDecision, resolveJevDecision, type JevCandidate } from "../../src/combos/jev";
import {
  exchangeJevDecision,
  JEV_API_URL,
  type JevDecisionEndpointShape,
  type JevServiceExchangeOptions,
} from "../../src/combos/jev-service-exchange";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type Post = NonNullable<JevServiceExchangeOptions["post"]>;
const row: OcxProviderConfig = {
  adapter: "jev-decision", baseUrl: "https://decider.example/v1/systemone/",
  defaultModel: "tev1:4b", apiKey: "fixture-own-key",
};
const config = (name = "decider", provider = row): OcxConfig => ({
  port: 0, defaultProvider: "a", providers: { [name]: provider },
});
const options = (extra: Partial<JevServiceExchangeOptions> = {}): JevServiceExchangeOptions => ({
  config: config(), decisionProvider: "decider", ...extra,
});
const prepare = (endpoint: JevDecisionEndpointShape) => ({ body: JSON.stringify({
  model: endpoint.model, state: { task: "A synthetic question." },
  questions: { test: { type: "choice", criteria: { yes: "Yes", no: "No" } } },
}) });
const parse = (payload: unknown) => payload;
const okPost: Post = async () => Response.json({ answers: { test: { choice: "yes" } } });

// Exercise the seam directly so future question builders cannot bypass the transport contract.
describe("bounded JEV service exchange", () => {
  for (const name of ["jev", "decider"]) {
    test(`${name}: destination denial precedes credential access and request-state extraction`, async () => {
      const seen: string[] = [];
      const provider: OcxProviderConfig = {
        ...row, baseUrl: name === "jev" ? JEV_API_URL : row.baseUrl,
        get apiKey(): string { throw new Error("credential must not be read"); },
      };
      let prepared = false;
      let sends = 0;
      const opts = options({ config: config(name, provider), decisionProvider: name,
        isDestinationAllowed(providerName, model) { seen.push(`${providerName}/${model}`); return false; },
        post: async () => { sends++; return okPost("", row, "", { body: "" }); },
      });
      expect(await exchangeJevDecision(opts, () => { prepared = true; throw new Error("state must not be read"); }, parse))
        .toEqual({ gate: "invalid" });
      expect(prepared).toBe(false);
      expect(seen).toEqual([name === "jev" ? "jev/jev-latest" : "decider/tev1:4b"]);
      expect(sends).toBe(0);

      const body = { get input(): string { throw new Error("state must not be read"); } };
      expect(await resolveJevDecision({ ...opts, body, candidates, fallback }))
        .toMatchObject({ ...fallback, gate: "invalid" });
    });
  }

  test("builders see only model/criteria shape; another question uses the same outbound guard", async () => {
    const shapes: JevDecisionEndpointShape[] = [];
    const result = await exchangeJevDecision(options({ post: async (name, provider, url, init, deps) => {
      expect(name).toBe("decider");
      expect(provider).toBe(row);
      expect(url).toBe("https://decider.example/v1/systemone");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-own-key");
      expect(new Headers(init.headers).get("content-type")).toBe("application/json");
      expect(init.body).toBe(prepare({ model: "tev1:4b", descriptiveCriteria: true }).body);
      expect(deps?.isCanonicalUrl?.(name, url)).toBe(false);
      expect(deps?.isCanonicalUrl?.("jev", JEV_API_URL)).toBe(true);
      expect(deps?.allowLocalCleartextPost).toBe(true);
      return Response.json({ answers: { test: { choice: "yes" } } });
    } }), endpoint => { shapes.push(endpoint); return prepare(endpoint); }, parse);
    expect(shapes).toEqual([{ model: "tev1:4b", descriptiveCriteria: true }]);
    expect(result).toEqual({ value: { answers: { test: { choice: "yes" } } } });
  });

  test("keyless self-hosted requests never borrow canonical environment keys", async () => {
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "fixture-typesafe-key";
    try {
      expect(await exchangeJevDecision(options({ config: config("decider", { ...row, apiKey: undefined }),
        post: async (_name, _provider, _url, init) => {
          expect(new Headers(init.headers).has("authorization")).toBe(false);
          expect(String(init.body)).not.toContain("fixture-typesafe-key");
          return Response.json({});
        },
      }), prepare, parse)).toEqual({ value: {} });
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });

  for (const apiKey of ["$TYPESAFE_API_KEY", "${TYPESAFE_API_KEY}", "$JEV_API_KEY", "${JEV_API_KEY}", "keychain:jev"]) {
    test(`refuses foreign credential reference ${apiKey} before preparation or POST`, async () => {
      expect(await exchangeJevDecision(options({ config: config("decider", { ...row, apiKey }),
        post: async () => { throw new Error("unexpected send"); },
      }), () => { throw new Error("unexpected preparation"); }, parse)).toEqual({ gate: "missing_key" });
    });
  }

  // The 64 KiB caps are pinned as literals, not through the exported constants, so changing a cap fails here.
  test("enforces serialized UTF-8 request byte cap, including its exact boundary", async () => {
    let sends = 0;
    const opts = options({ post: async () => { sends++; return Response.json({}); } });
    const boundary = "é".repeat(32_768); // 2 bytes each: exactly 65_536 bytes
    let bodyReads = 0;
    expect(await exchangeJevDecision(opts, () => ({ get body() { bodyReads++; return boundary; } }), parse)).toEqual({ value: {} });
    expect(bodyReads).toBe(1); // Preparation samples the body once, as before the cancellation fix.
    expect(await exchangeJevDecision(opts, () => ({ body: `${boundary}x` }), parse)).toEqual({ gate: "invalid" });
    expect(sends).toBe(1);
  });

  test("redirect/HTTP responses are canceled without parsing or retaining upstream detail", async () => {
    for (const [status, gate] of [[302, "redirect"], [307, "redirect"], [402, "http"]] as const) {
      let canceled = false;
      let parsed = false;
      const stream = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
      expect(await exchangeJevDecision(options({ post: async () => new Response(stream, {
        status, headers: { location: "https://other.example/" },
      }) }), prepare, () => { parsed = true; })).toEqual({ gate });
      expect(canceled).toBe(true);
      expect(parsed).toBe(false);
    }
  });

  test("bounds response bytes at 64 KiB and rejects malformed JSON and UTF-8", async () => {
    const boundary = `"${"x".repeat(65_534)}"`; // exactly 65_536 bytes
    expect(new TextEncoder().encode(boundary).byteLength).toBe(65_536);
    expect(await exchangeJevDecision(options({ post: async () => new Response(boundary) }), prepare, parse))
      .toEqual({ value: "x".repeat(65_534) });
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); },
      cancel() { canceled = true; },
    });
    expect(await exchangeJevDecision(options({ post: async () => new Response(stream) }), prepare, parse))
      .toEqual({ gate: "malformed" });
    expect(canceled).toBe(true);
    for (const body of ["not-json", new Uint8Array([0x22, 0xc3, 0x28, 0x22])]) {
      expect(await exchangeJevDecision(options({ post: async () => new Response(body) }), prepare, parse))
        .toEqual({ gate: "malformed" });
    }
  });

  test("local preparation and answer validation retain their existing gates", async () => {
    for (const gate of ["no_choices", "no_state", "invalid"] as const) {
      expect(await exchangeJevDecision(options(), () => gate, parse)).toEqual({ gate });
    }
    expect(await exchangeJevDecision(options(), () => { throw new Error("private preparation detail"); }, parse))
      .toEqual({ gate: "invalid" });
    expect(await exchangeJevDecision(options({ post: okPost }), prepare, () => { throw new Error("private parser detail"); }))
      .toEqual({ gate: "invalid" });
    expect(await exchangeJevDecision(options({ post: async () => { throw new TypeError("private network detail"); } }), prepare, parse))
      .toEqual({ gate: "network" });
  });

  test("route parser still refuses malformed probabilities through the shared exchange", async () => {
    for (const probabilities of [null, { "a/m1:low": 1 }, { "a/m1:low": 0.4, "a/m2:low": 0.2 },
      { "a/m1:low": 0.2, "a/m2:low": 0.8 }, { "a/m1:low": -0.1, "a/m2:low": 1.1 }]) {
      const payload = { answers: { route: { choice: "a/m1:low", probabilities } } };
      expect(await exchangeJevDecision(options({ post: async () => Response.json(payload) }), prepare,
        answer => parseJevDecision(answer, candidates))).toEqual({ gate: "invalid" });
    }
  });

  test("caller cancellation wins by identity when already aborted, after POST, during read and parsing", async () => {
    const reason = { caller: "stopped" };
    for (const phase of ["pre", "post", "read", "parse"] as const) {
      const caller = new AbortController();
      if (phase === "pre") caller.abort(reason);
      let canceled = false;
      const post: Post = async () => {
        if (phase === "post") caller.abort(reason);
        if (phase === "read") return new Response(new ReadableStream<Uint8Array>({
          pull() { caller.abort(reason); }, cancel() { canceled = true; },
        }, { highWaterMark: 0 }));
        return Response.json({});
      };
      await expect(exchangeJevDecision(options({ signal: caller.signal, post }), prepare, payload => {
        if (phase === "parse") caller.abort(reason);
        return payload;
      })).rejects.toBe(reason);
      if (phase === "read") expect(canceled).toBe(true);
    }
  });

  // Cancellation ownership: whenever the caller's signal is aborted at a checkpoint, the caller's reason
  // wins by identity over every local gate. Each case aborts from inside the callback under test and then
  // refuses or throws, so only a check made after that callback returns can still preserve the reason.
  test("an already-aborted caller rejects by identity before authorization, credential access, preparation or POST", async () => {
    const reason = { caller: "stopped before start" };
    for (const variant of ["self-hosted", "canonical", "missing-key", "unusable", "foreign-credential", "prepare-invalid", "prepare-no-state"] as const) {
      for (const allowed of [true, false]) {
        const counts = { authorizations: 0, credentialReads: 0, preparations: 0, sends: 0 };
        const credential = variant === "missing-key" ? undefined : variant === "foreign-credential" ? "$TYPESAFE_API_KEY" : "fixture-own-key";
        const canonical = variant === "canonical" || variant === "missing-key";
        const provider: OcxProviderConfig = canonical
          ? { adapter: "jev-decision", baseUrl: JEV_API_URL, get apiKey() { counts.credentialReads++; return credential; } }
          : { ...row, get apiKey() { counts.credentialReads++; return credential; } };
        const name = canonical ? "jev" : "decider";
        const caller = new AbortController();
        caller.abort(reason);
        const opts = options({
          config: variant === "unusable" ? { port: 0, defaultProvider: "a", providers: {} } : config(name, provider),
          decisionProvider: name,
          signal: caller.signal,
          isDestinationAllowed() { counts.authorizations++; return allowed; },
          post: async () => { counts.sends++; return Response.json({}); },
        });
        await expect(exchangeJevDecision(opts, () => {
          counts.preparations++;
          if (variant === "prepare-invalid") return "invalid";
          if (variant === "prepare-no-state") return "no_state";
          return prepare({ model: "m", descriptiveCriteria: true });
        }, parse)).rejects.toBe(reason);
        expect(counts).toEqual({ authorizations: 0, credentialReads: 0, preparations: 0, sends: 0 });
      }
    }
  });

  test("a caller abort inside authorization or credential resolution beats the local refusal or throw", async () => {
    const stages = ["deny", "deny-then-throw", "allow", "foreign-credential", "credential-throw", "credential-unusable"] as const;
    const previous = [process.env.TYPESAFE_API_KEY, process.env.JEV_API_KEY];
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_API_KEY;
    try {
      for (const stage of stages) {
        const reason = { caller: `stopped during ${stage}` };
        const caller = new AbortController();
        const counts = { preparations: 0, sends: 0 };
        const credential = (): string | undefined => {
          caller.abort(reason);
          if (stage === "credential-throw") throw new Error("synthetic credential failure");
          return stage === "foreign-credential" ? "$TYPESAFE_API_KEY" : undefined;
        };
        const unusable = stage === "credential-unusable";
        const keyed = stage.startsWith("credential") || stage === "foreign-credential";
        const name = unusable ? "jev" : "decider";
        const provider: OcxProviderConfig = unusable
          ? { adapter: "jev-decision", baseUrl: JEV_API_URL, get apiKey() { return credential(); } }
          : { ...row, get apiKey() { return keyed ? credential() : "fixture-own-key"; } };
        const opts = options({
          config: config(name, provider), decisionProvider: name, signal: caller.signal,
          ...(keyed ? {} : { isDestinationAllowed() {
            caller.abort(reason);
            if (stage === "deny-then-throw") throw new Error("synthetic authorization failure");
            return stage === "allow";
          } }),
          post: async () => { counts.sends++; return Response.json({}); },
        });
        await expect(exchangeJevDecision(opts, () => { counts.preparations++; return prepare({ model: "m", descriptiveCriteria: true }); }, parse))
          .rejects.toBe(reason);
        expect(counts).toEqual({ preparations: 0, sends: 0 });
      }
    } finally {
      for (const [i, key] of ["TYPESAFE_API_KEY", "JEV_API_KEY"].entries()) {
        if (previous[i] === undefined) delete process.env[key];
        else process.env[key] = previous[i];
      }
    }
  });

  test("an authorization failure without cancellation keeps its own error and a destination denial stays a gate", async () => {
    const failure = new Error("synthetic authorization failure");
    const caller = new AbortController();
    await expect(exchangeJevDecision(options({ signal: caller.signal, isDestinationAllowed() { throw failure; } }), prepare, parse))
      .rejects.toBe(failure);
    expect(await exchangeJevDecision(options({ signal: caller.signal, isDestinationAllowed: () => false }), prepare, parse))
      .toEqual({ gate: "invalid" });
  });

  test("a caller abort inside preparation beats every local refusal and prevents the POST", async () => {
    for (const phase of ["no_choices", "no_state", "invalid", "oversized", "throw", "valid"] as const) {
      const reason = { caller: `stopped during ${phase} preparation` };
      const caller = new AbortController();
      let sends = 0;
      await expect(exchangeJevDecision(options({ signal: caller.signal, post: async () => { sends++; return Response.json({}); } }), () => {
        caller.abort(reason);
        if (phase === "throw") throw new Error("synthetic invalid request");
        if (phase === "oversized") return { body: "x".repeat(65_537) };
        if (phase === "valid") return { body: "{}" };
        return phase;
      }, parse)).rejects.toBe(reason);
      expect(sends).toBe(0);
    }
  });

  test("a caller abort inside the answer parser beats the invalid gate; other parser failures stay invalid", async () => {
    for (const outcome of ["throw", "return"] as const) {
      const reason = { caller: `stopped in parser then ${outcome}` };
      const caller = new AbortController();
      await expect(exchangeJevDecision(options({ signal: caller.signal, post: okPost }), prepare, payload => {
        caller.abort(reason);
        if (outcome === "throw") throw new Error("synthetic rejected answer");
        return payload;
      })).rejects.toBe(reason);
    }
    const idle = new AbortController();
    expect(await exchangeJevDecision(options({ signal: idle.signal, post: okPost }), prepare, () => { throw new Error("synthetic rejected answer"); }))
      .toEqual({ gate: "invalid" });
    expect(await exchangeJevDecision(options({ signal: idle.signal, post: okPost }), prepare, parse))
      .toEqual({ value: { answers: { test: { choice: "yes" } } } });
  });

  test("a caller abort while a redirect body is canceled still wins over the redirect gate", async () => {
    const reason = { caller: "stopped while canceling a redirect body" };
    const caller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel() { caller.abort(reason); } });
    await expect(exchangeJevDecision(options({ signal: caller.signal, post: async () => new Response(body, {
      status: 302, headers: { location: "https://other.example/" },
    }) }), prepare, parse)).rejects.toBe(reason);
  });

  test("caller abort during HTTP body cleanup rejects by identity in the exchange and actual route", async () => {
    for (const resolveRoute of [false, true]) for (const cleanup of ["return", "throw", "pending"] as const) {
      const caller = new AbortController();
      const reason = { caller: `stopped during HTTP cleanup: ${cleanup}` };
      let cancels = 0;
      let parses = 0;
      const post: Post = async () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          cancels++;
          caller.abort(reason);
          if (cleanup === "throw") throw new Error("synthetic cleanup failure");
          if (cleanup === "pending") return new Promise<void>(() => {});
        },
      }), { status: 402 });
      const opts = options({ signal: caller.signal, post });
      const pending = resolveRoute
        ? resolveJevDecision({ ...opts, body: { input: "A synthetic task." }, candidates, fallback })
        : exchangeJevDecision(opts, prepare, payload => { parses++; return payload; });
      await expect(pending).rejects.toBe(reason);
      expect(cancels).toBe(1);
      expect(parses).toBe(0);
    }
    const caller = new AbortController();
    const reason = { caller: "stopped in a synchronously throwing cancel method" };
    const response = new Response("synthetic HTTP error", { status: 402 });
    response.body!.cancel = () => { caller.abort(reason); throw new Error("synthetic synchronous cleanup failure"); };
    await expect(exchangeJevDecision(options({ signal: caller.signal, post: async () => response }), prepare, parse)).rejects.toBe(reason);
  });

  test("HTTP cleanup remains best effort and non-waiting without caller cancellation", async () => {
    for (const resolveRoute of [false, true]) for (const cleanup of ["return", "throw", "pending"] as const) {
      const caller = new AbortController();
      let cancels = 0;
      let parses = 0;
      const opts = options({ signal: caller.signal, post: async () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          cancels++;
          if (cleanup === "throw") throw new Error("synthetic cleanup failure");
          if (cleanup === "pending") return new Promise<void>(() => {});
        },
      }), { status: 402 }) });
      const result = resolveRoute
        ? await resolveJevDecision({ ...opts, body: { input: "A synthetic task." }, candidates, fallback })
        : await exchangeJevDecision(opts, prepare, payload => { parses++; return payload; });
      expect(result).toMatchObject({ gate: "http" });
      if (resolveRoute) expect(result).toMatchObject(fallback);
      expect(caller.signal.aborted).toBe(false);
      expect(cancels).toBe(1);
      expect(parses).toBe(0);
    }
    // Even a non-conforming cancel method that throws synchronously is still best effort.
    const response = new Response("synthetic HTTP error", { status: 402 });
    response.body!.cancel = () => { throw new Error("synthetic synchronous cleanup failure"); };
    expect(await exchangeJevDecision(options({ post: async () => response }), prepare, parse)).toEqual({ gate: "http" });
  });

  test("caller abort during oversized-response cleanup beats the malformed gate", async () => {
    const caller = new AbortController();
    const reason = { caller: "stopped during oversized-response cleanup" };
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); },
      cancel() { cancels++; caller.abort(reason); },
    });
    await expect(exchangeJevDecision(options({ signal: caller.signal, post: async () => new Response(body) }), prepare, parse))
      .rejects.toBe(reason);
    expect(cancels).toBe(1);
  });

  test("caller cancellation stays separate from the decision deadline", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
    let deadline = new AbortController();
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value() { return deadline.signal; } });
    try {
      const expired = new DOMException("deadline", "TimeoutError");
      const idle = new AbortController();
      expect(await exchangeJevDecision(options({ signal: idle.signal, post: async () => { deadline.abort(expired); throw expired; } }), prepare, parse))
        .toEqual({ gate: "timeout" });
      deadline = new AbortController();
      expect(await exchangeJevDecision(options({ signal: idle.signal, post: okPost }), prepare, () => {
        deadline.abort(expired);
        throw new Error("synthetic rejected answer");
      })).toEqual({ gate: "invalid" });
      expect(idle.signal.aborted).toBe(false);
      deadline = new AbortController();
      const reason = { caller: "stopped as the deadline expired" };
      const caller = new AbortController();
      await expect(exchangeJevDecision(options({ signal: caller.signal, post: async () => {
        deadline.abort(expired);
        caller.abort(reason);
        throw expired;
      } }), prepare, parse)).rejects.toBe(reason);
    } finally { Object.defineProperty(AbortSignal, "timeout", descriptor); }
  });

  test("caller abort reaches the in-flight POST signal and settles long before the deadline", async () => {
    const caller = new AbortController();
    const reason = { caller: "stopped in flight" };
    const release = new AbortController(); // lets a regressed build unwind instead of leaking a pending POST
    let posted: AbortSignal | undefined;
    let started!: () => void;
    const postStarted = new Promise<void>(resolve => { started = resolve; });
    const post: Post = (_name, _provider, _url, init) => {
      posted = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        release.signal.addEventListener("abort", () => reject(new Error("test released")), { once: true });
        started();
      });
    };
    const pending = exchangeJevDecision(options({ signal: caller.signal, timeoutMs: 120_000, post }), prepare, parse);
    await postStarted;
    expect(posted?.aborted).toBe(false);
    caller.abort(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(() => "resolved", error => (error === reason ? "reason" : "other")),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("still pending"), 1_000); }),
    ]);
    clearTimeout(timer);
    release.abort();
    await pending.catch(() => undefined);
    expect(outcome).toBe("reason");
    expect(posted?.aborted).toBe(true);
    expect(posted?.reason).toBe(reason);
  });

  test("deadline normalization and expiry apply to both POST and body read", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
    const deadlines: number[] = [];
    let deadline = new AbortController();
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value(ms: number) {
      deadlines.push(ms); return deadline.signal;
    } });
    try {
      for (const timeoutMs of [undefined, 999, 1_000, 120_000, 120_001, 1_500.5]) {
        expect(await exchangeJevDecision(options({ timeoutMs, post: okPost }), prepare, parse)).toHaveProperty("value");
      }
      expect(deadlines).toEqual([4_000, 4_000, 1_000, 120_000, 4_000, 4_000]);
      const reason = new DOMException("deadline", "TimeoutError");
      expect(await exchangeJevDecision(options({ post: async () => { deadline.abort(reason); throw reason; } }), prepare, parse))
        .toEqual({ gate: "timeout" });
      deadline = new AbortController();
      let canceled = false;
      expect(await exchangeJevDecision(options({ post: async () => new Response(new ReadableStream<Uint8Array>({
        pull() { deadline.abort(reason); }, cancel() { canceled = true; },
      }, { highWaterMark: 0 })) }), prepare, parse)).toEqual({ gate: "timeout" });
      expect(canceled).toBe(true);
    } finally { Object.defineProperty(AbortSignal, "timeout", descriptor); }
  });

  // The destination is the shared decision-endpoint contract (jevDecisionEndpointUrl, #6731), not a copy.
  describe("decision endpoint URL contract", () => {
    const answer = { answers: { test: { choice: "yes" }, route: { choice: "a/m2:low" } } };
    async function sendTo(baseUrl: string) {
      const sent: Array<{ url: string; body: string }> = [];
      const post: Post = async (_name, _provider, url, init) => {
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-own-key");
        sent.push({ url, body: String(init.body) });
        return Response.json(answer);
      };
      const opts = options({ config: config("decider", { ...row, baseUrl }), post });
      const direct = await exchangeJevDecision(opts, prepare, parse);
      const route = await resolveJevDecision({ ...opts, body: { input: "Choose a target." }, candidates, fallback });
      return { sent, direct, route };
    }

    test.each([
      ["https://decider.example/v1/decisions", "https://decider.example/v1/decisions"],
      ["https://decider.example/v1/decisions/", "https://decider.example/v1/decisions/"],
      ["https://decider.example/v1/decisions//", "https://decider.example/v1/decisions//"],
      ["  https://decider.example/v1/decisions/  ", "https://decider.example/v1/decisions/"],
      ["https://Decider.Example/v1/Decisions/", "https://Decider.Example/v1/Decisions/"],
      ["https://decider.example/v1/systemone/extra", "https://decider.example/v1/systemone/extra"],
      ["https://decider.example/v1/systemone", "https://decider.example/v1/systemone"],
      ["https://decider.example/v1/systemone/", "https://decider.example/v1/systemone"],
      ["https://decider.example/v1/systemone//", "https://decider.example/v1/systemone"],
      ["http://127.0.0.1:11434/v1/systemone/", "http://127.0.0.1:11434/v1/systemone"],
    ])("baseUrl %j is sent to %j through the exchange and the route", async (baseUrl, expected) => {
      const { sent, direct, route } = await sendTo(baseUrl);
      expect(sent.map(request => request.url)).toEqual([expected, expected]);
      expect(direct).toEqual({ value: answer });
      expect(route.gate).toBe("apply");
    });

    test("the request body does not depend on the endpoint path", async () => {
      const bodies = new Set<string>();
      for (const baseUrl of ["https://decider.example/v1/decisions/", "https://decider.example/v1/systemone/"]) {
        const { sent } = await sendTo(baseUrl);
        expect(sent).toHaveLength(2);
        sent.forEach(request => bodies.add(request.body));
      }
      expect(bodies.size).toBe(2); // one exchange body and one route body, identical across both endpoints
    });

    test.each([
      "https://decider.example/v1/systemone?mode=x", "https://decider.example/v1/decisions?",
      "https://decider.example/v1/systemone#part", "https://decider.example/v1/decisions#",
      "https://user:pass@example.test/v1/systemone", "https://@decider.example/v1/decisions",
      "https:\t//@decider.example/v1/decisions", "https://decider.example/v1/system\tone",
      "http://decider.example/v1/systemone", "http://127.0.0.1:11434/v1/decisions",
      "ftp://decider.example/v1/systemone", "not a url",
    ])("baseUrl %j is refused before any send", async (baseUrl) => {
      const { sent, direct, route } = await sendTo(baseUrl);
      expect(sent).toEqual([]);
      expect(direct).toEqual({ gate: "missing_key" });
      expect(route.gate).toBe("missing_key");
    });
  });
});

const candidates: JevCandidate[] = [
  { key: "a/m1", provider: "a", model: "m1", reasoningEfforts: ["low"] },
  { key: "a/m2", provider: "a", model: "m2", reasoningEfforts: ["low"] },
];
const fallback = { targetKey: "a/m1", effort: "low" as const };
