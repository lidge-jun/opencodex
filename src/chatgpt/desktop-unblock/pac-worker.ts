/** Arbitrary PAC executes only inside QuickJS WASM, never in the Bun/Node realm. */
import { parse } from "acorn";
import { QuickJS, Intrinsics, type JSValueHandle } from "quickjs-wasi";
import { PAC_LIMITS, classicPacHelper, ipv4Number, validDnsName } from "./pac-helpers";

declare const self: Worker;
let vm: QuickJS | undefined, findProxy: JSValueHandle | undefined;
let fatal = false, evaluating = false, requestId = 0;
let cpuDeadline = 0, helperCalls = 0, dnsCalls = 0;
let limits = { cpuMs: PAC_LIMITS.cpuMs as number, dnsMs: PAC_LIMITS.dnsMs as number, heapBytes: PAC_LIMITS.heapBytes as number };

function fail(): never { fatal = true; throw new Error("Unsupported or failed PAC operation"); }
function resetBudget(): void {
  cpuDeadline = performance.now() + limits.cpuMs;
  helperCalls = 0; dnsCalls = 0;
}
function checkBudget(): void {
  if (fatal || performance.now() >= cpuDeadline) fail();
}
function dns(host: string): string | null {
  if (!evaluating || !validDnsName(host) || ++dnsCalls > PAC_LIMITS.dnsCalls) return fail();
  if (ipv4Number(host) !== null) return host;
  checkBudget();
  const shared = new SharedArrayBuffer(264), state = new Int32Array(shared, 0, 2);
  const start = performance.now();
  self.postMessage({ type: "dns", id: requestId, host, shared });
  const status = Atomics.wait(state, 0, 0, limits.dnsMs);
  cpuDeadline += performance.now() - start;
  if (status === "timed-out") return fail();
  const code = Atomics.load(state, 0), length = Atomics.load(state, 1);
  if (code === 2 && length === 0) return null;
  if (code !== 1 || length < 1 || length > 15) return fail();
  const value = new TextDecoder().decode(new Uint8Array(shared, 8, length));
  return ipv4Number(value) === null ? fail() : value;
}

function installHelpers(): void {
  const runtime = vm!;
  const supported = ["isPlainHostName", "dnsDomainIs", "localHostOrDomainIs", "dnsDomainLevels",
    "shExpMatch", "dnsResolve", "isResolvable", "isInNet", "weekdayRange"];
  for (const name of supported) {
    using fn = runtime.newFunction(name, (...args) => {
      try {
        checkBudget();
        if (++helperCalls > PAC_LIMITS.helperCalls || args.length > 3 || args.some(arg => !arg.isString)) return fail();
        const strings = args.map(arg => arg.toString());
        if (strings.some(value => value.length > PAC_LIMITS.inputBytes)) return fail();
        const result = classicPacHelper(name, strings, dns);
        checkBudget();
        return runtime.hostToHandle(result);
      } catch { return fail(); }
    });
    runtime.defineProp(runtime.global, name, fn, { writable: false, configurable: false });
  }
  using unsupported = runtime.newFunction("__ocxUnsupported", () => fail());
  runtime.setProp(runtime.global, "__ocxUnsupported", unsupported);
  // The closure captures the host-side poison hook before removing its global name.
  // Non-configurable getters poison even when a PAC catches the guest exception.
  runtime.evalCode(`(function (fatal) {
    var deny = function () { return fatal(); };
    var blocked = ["Promise", "dateRange", "timeRange", "myIpAddress", "myIpAddressEx",
      "dnsResolveEx", "isResolvableEx", "isInNetEx", "sortIpAddressList", "getClientVersion",
      "eval", "Function"];
    for (var i = 0; i < blocked.length; i++) {
      Object.defineProperty(globalThis, blocked[i], { get: deny, set: deny, configurable: false });
    }
    Object.defineProperty(Object.getPrototypeOf(function () {}), "constructor", { get: deny, configurable: false });
    Object.defineProperty(Object.getPrototypeOf(function* () {}), "constructor", { get: deny, configurable: false });
    delete globalThis.__ocxUnsupported;
  })(__ocxUnsupported);`).dispose();
}

/** Parse only in this disposable worker. No source rewriting or guest execution. */
function validateSyntax(source: string): void {
  let tokens = 0;
  const tree = parse(source, {
    ecmaVersion: 2025, sourceType: "script",
    onToken: () => { if (++tokens > PAC_LIMITS.parserTokens) fail(); checkBudget(); },
  });
  const nodes: object[] = [tree];
  while (nodes.length) {
    checkBudget();
    const node = nodes.pop()! as Record<string, unknown>;
    // QuickJS exposes no allocator failure hook. Disallow recovery/suppression of
    // engine errors, including caught OOM and return from finally, before running.
    if (node.type === "TryStatement" || node.type === "AwaitExpression" || node.type === "ImportExpression"
      || ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")
        && node.async === true)) fail();
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object" && typeof child.type === "string") nodes.push(child);
      } else if (value && typeof value === "object" && "type" in value) nodes.push(value);
    }
  }
}

async function initialize(data: { source: string; wasm: ArrayBuffer; limits: typeof limits }): Promise<void> {
  limits = data.limits;
  resetBudget();
  validateSyntax(data.source);
  vm = await QuickJS.create({
    wasm: data.wasm, memoryLimit: limits.heapBytes, maxStackSize: 256 * 1024,
    intrinsics: Intrinsics.EVAL | Intrinsics.DATE | Intrinsics.REGEXP | Intrinsics.JSON | Intrinsics.MAP_SET,
    interruptHandler: () => {
      if (fatal || performance.now() >= cpuDeadline) { fatal = true; return true; }
      return false;
    },
    moduleLoader: { load: () => fail(), normalize: () => fail() },
  });
  resetBudget();
  installHelpers();
  vm.withScope(() => vm!.evalCode(data.source, "system.pac").dispose());
  checkBudget();
  findProxy = vm.withScope(scope => scope.escape(vm!.evalCode("FindProxyForURL")));
  if (!findProxy.isFunction) fail();
  self.postMessage({ type: "ready" });
}

function resolve(data: { id: number; url: string; host: string }): void {
  if (!vm || !findProxy || fatal || evaluating) fail();
  requestId = data.id; evaluating = true; resetBudget();
  try {
    const runtime = vm;
    const value = runtime.withScope(() => {
      using url = runtime.newString(data.url), host = runtime.newString(data.host);
      using result = runtime.callFunction(findProxy!, runtime.undefined, url, host);
      checkBudget();
      // Never coerce objects or Promises. Coercion can execute guest code and cannot
      // turn a malformed result into a valid explicit route.
      if (!result.isString) fail();
      const answer = result.toString();
      if (new TextEncoder().encode(answer).length > PAC_LIMITS.resultBytes) fail();
      return answer;
    });
    self.postMessage({ type: "result", id: requestId, value });
  } finally { evaluating = false; }
}

function shutdown(): void {
  fatal = true;
  // Error details are deliberately not sent: source, route, and URL data are private.
  self.postMessage({ type: "error" });
  try { findProxy?.dispose(); vm?.dispose(); } catch { /* the owner also terminates this worker */ }
  (self as unknown as { close(): void }).close();
}
self.onmessage = (event: MessageEvent) => {
  const data = event.data;
  if (data?.type === "init" && !vm) {
    initialize(data).catch(shutdown);
  } else {
    try { if (data?.type !== "resolve") fail(); resolve(data); } catch { shutdown(); }
  }
};
