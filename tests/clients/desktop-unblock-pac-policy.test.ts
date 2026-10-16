import { afterEach, describe, expect, test } from "bun:test";
import { createRuntimePacPolicy, parsePacRoutes, type RuntimePacPolicy, type RuntimePacPolicyOptions } from "../../src/chatgpt/desktop-unblock/pac-policy";
import { PAC_LIMITS, classicPacHelper } from "../../src/chatgpt/desktop-unblock/pac-helpers";

const policies: RuntimePacPolicy[] = [];
afterEach(() => { for (const policy of policies.splice(0)) policy.close(); });
async function policy(body: string, options?: RuntimePacPolicyOptions): Promise<RuntimePacPolicy> {
  const value = await createRuntimePacPolicy(`function FindProxyForURL(url, host) { ${body} }`, options);
  policies.push(value); return value;
}
const target = "https://service.example.test/private?secret=yes";

async function rejectsAndPoisons(body: string, options?: RuntimePacPolicyOptions): Promise<void> {
  const value = await policy(body, options);
  await expect(value.resolve(target)).rejects.toThrow();
  await expect(value.resolve(target)).rejects.toThrow();
}

describe("strict runtime PAC routes", () => {
  test("keeps exact ordering and explicit DIRECT, and canonicalizes endpoint hosts", () => {
    expect(parsePacRoutes("PROXY Proxy.Example:8080; HTTPS tls.example:443; SOCKS5 [::1]:1080; DIRECT"))
      .toEqual(["http://proxy.example:8080", "https://tls.example:443", "socks5://[::1]:1080", null]);
    expect(Object.isFrozen(parsePacRoutes("DIRECT"))).toBe(true);
    expect(parsePacRoutes("PROXY proxy.example:80")).toEqual(["http://proxy.example:80"]);
  });
  test("rejects every malformed chain before exposing its valid prefix", () => {
    for (const invalid of ["", ";", "DIRECT;", ";DIRECT", "PROXY proxy:80;;DIRECT", "DIRECT; BOGUS proxy:80",
      "PROXY proxy:80; SOCKS proxy:1080", "DIRECT false", "direct", "HTTP proxy:80",
      "PROXY user:password@proxy:80", "PROXY proxy:0", "PROXY proxy:65536", "PROXY proxy:080",
      "PROXY 127.1:80", "PROXY 2130706433:80", "PROXY 0x7f000001:80", "PROXY 127.00.0.1:80",
      "PROXY proxy:80/path", "PROXY proxy:80#fragment", "PROXY proxy:80?query", "PROXY proxy\\other:80",
      "PROXY proxy%2eexample:80", "PROXY -bad.example:80", "PROXY [fe80::1%lo]:80", "PROXY ::1:80",
      "PROXY café.example:80", "PROXY proxy:80\nDIRECT", "DIRECT; "] as const) {
      expect(() => parsePacRoutes(invalid), invalid).toThrow();
    }
    for (const invalid of [null, undefined, false, 0, {}, ["DIRECT"]]) expect(() => parsePacRoutes(invalid)).toThrow();
    expect(() => parsePacRoutes(Array(PAC_LIMITS.routes + 1).fill("DIRECT").join(";"))).toThrow();
    expect(() => parsePacRoutes(" ".repeat(PAC_LIMITS.resultBytes) + "DIRECT")).toThrow();
  });
});

describe("isolated PAC evaluation", () => {
  test("supports per-request logic and preserves only explicit routes", async () => {
    const value = await policy('return host === "service.example.test" ? "PROXY gateway.test:3128; DIRECT" : "HTTPS other.test:8443";');
    expect(await value.resolve(target)).toEqual(["http://gateway.test:3128", null]);
    expect(await value.resolve("https://other.test/")).toEqual(["https://other.test:8443"]);
  });
  test("has no Node, Bun, network, or host process globals", async () => {
    const value = await policy(`if ([typeof process, typeof require, typeof Bun, typeof fetch, typeof console,
      typeof setTimeout].some(function (v) { return v !== "undefined"; })) throw new Error("host leak"); return "DIRECT";`);
    expect(await value.resolve(target)).toEqual([null]);
  });
  test("HTTPS and WSS remove secrets while preserving scheme and unbracketed host", async () => {
    const value = await policy(`if (url !== "wss://[::1]:8443/" || host !== "::1") throw new Error("URL mismatch"); return "DIRECT";`);
    expect(await value.resolve("wss://user:password@[::1]:8443/private?token=secret#fragment")).toEqual([null]);
    const https = await policy('if (url !== "https://service.example.test/") throw new Error("secret leak"); return "DIRECT";');
    expect(await https.resolve("https://user:password@service.example.test/private?token=secret#fragment")).toEqual([null]);
  });
  test("HTTP retains path/query and removes credentials/fragment like classic PAC", async () => {
    const value = await policy('if (url !== "http://service.example.test/path?q=ok") throw new Error("URL mismatch"); return "DIRECT";');
    expect(await value.resolve("http://user:password@service.example.test/path?q=ok#private")).toEqual([null]);
  });
  test("objects, undefined, falsey, unsupported, and partially valid results poison the policy", async () => {
    for (const body of ['return undefined;', 'return null;', 'return false;', 'return 0;', 'return "";',
      'return { toString: function () { return "DIRECT"; } };', 'return "PROXY good.test:80; INVALID";',
      'throw new Error("sensitive URL should not be printed");']) await rejectsAndPoisons(body);
  });
  test("caught unsupported helper and Promise access cannot turn failure into DIRECT", async () => {
    for (const expression of ['Promise', 'typeof Promise', 'globalThis["Pro" + "mise"]', 'dateRange', 'timeRange',
      'myIpAddress', 'myIpAddressEx', 'dnsResolveEx', 'isInNetEx', 'isResolvableEx', 'sortIpAddressList',
      'eval', 'Function', '(function () {}).constructor', 'Object.getPrototypeOf(function* () {}).constructor']) {
      await rejectsAndPoisons(`${expression}; return "DIRECT";`);
      await expect(policy(`try { ${expression}; } catch (error) { return "DIRECT"; } return "PROXY route.test:80";`)).rejects.toThrow();
    }
  });
  test("unsupported async syntax and top-level DNS fail initialization", async () => {
    for (const source of ['async function FindProxyForURL() { return "DIRECT"; }',
      'function FindProxyForURL() { import("node:fs"); return "DIRECT"; }',
      'var route = "PROXY route.test:80"; try { dnsResolve("localhost"); } catch (error) { route = "DIRECT"; } function FindProxyForURL() { return route; }',
      'var route = "PROXY route.test:80"; try { isInNet("127.0.0.1", "127.0.0.0", "255.0.0.0"); } catch (error) { route = "DIRECT"; } function FindProxyForURL() { return route; }',
      'dnsResolve("localhost"); function FindProxyForURL() { return "DIRECT"; }',
      'isInNet("127.0.0.1", "127.0.0.0", "255.0.0.0"); function FindProxyForURL() { return "DIRECT"; }',
      'var FindProxyForURL = 3;', 'this is not JavaScript']) {
      await expect(createRuntimePacPolicy(source)).rejects.toThrow();
    }
  });
  test("syntax checks allow harmless keywords and synchronous generators", async () => {
    const value = await policy(`// catch finally async await import
      var words = "catch finally async await import";
      var pattern = /catch|finally|async|await|import/;
      var template = \`catch finally async await import\`;
      var object = { async: true, await: 1, catch: 2, finally: 3, import: 4, async() { return 1; } };
      var async = 1, await = 2;
      function* routes() { yield "DIRECT"; }
      return routes().next().value;`);
    expect(await value.resolve(target)).toEqual([null]);
  });
  test("caught OOM, finally return, hidden async and invalid escaped keywords are rejected before execution", async () => {
    for (const body of ['try { var x = "x".repeat(1e9); } catch (error) { return "DIRECT"; } return "PROXY route.test:80";',
      'try { var x = "x".repeat(1e9); } finally { return "DIRECT"; }',
      'try { return "PROXY a.test:80"; } catch { return "DIRECT"; }',
      'var fn = async () => "DIRECT"; return "DIRECT";',
      'var fn = async function* () { yield "DIRECT"; }; return "DIRECT";',
      'var o = { async route() { return "DIRECT"; } }; return "DIRECT";',
      'var t = `text ${async () => "DIRECT"}`; return "DIRECT";',
      'try { return "PROXY route.test:80"; } ca\\u0074ch (error) { return "DIRECT"; }']) {
      await expect(policy(body)).rejects.toThrow();
    }
  });
  test("rejects oversized source and limits that try to expand resource budgets", async () => {
    await expect(createRuntimePacPolicy(" ".repeat(PAC_LIMITS.sourceBytes + 1))).rejects.toThrow();
    await expect(policy('return "DIRECT";', { cpuMs: PAC_LIMITS.cpuMs + 1 })).rejects.toThrow();
    await expect(policy('return "DIRECT";', { queueLimit: NaN })).rejects.toThrow();
    await expect(policy('return "DIRECT";', { heapBytes: PAC_LIMITS.heapBytes + 1 })).rejects.toThrow();
    await expect(createRuntimePacPolicy(";".repeat(PAC_LIMITS.parserTokens + 1) + 'function FindProxyForURL(){return "DIRECT";}')).rejects.toThrow();
  });
  test("unbounded CPU and heap work terminate without blocking the parent", async () => {
    await rejectsAndPoisons('while (true) {}', { cpuMs: 10 });
    await rejectsAndPoisons('var a = []; while (true) a.push("x".repeat(65536));', { cpuMs: 50 });
    await expect(createRuntimePacPolicy('while (true) {}', { cpuMs: 10 })).rejects.toThrow();
  });
  test("oversized results, unsupported request schemes, and closed policy fail closed", async () => {
    await rejectsAndPoisons(`return "DIRECT".repeat(${PAC_LIMITS.resultBytes});`);
    const value = await policy('return "DIRECT";');
    await expect(value.resolve("file:///tmp/private")).rejects.toThrow();
    await expect(value.resolve(target)).rejects.toThrow();
    const closed = await policy('return "DIRECT";'); closed.close(); closed.close();
    await expect(closed.resolve(target)).rejects.toThrow();
  });
});

describe("bounded classic PAC helpers", () => {
  test("domain, glob, and local-domain helpers implement classic cases", async () => {
    const value = await policy(`if (!isPlainHostName("intranet") || isPlainHostName("a.test")
      || !dnsDomainIs("www.example.test", ".example.test") || dnsDomainIs("example.test", ".example.test")
      || !localHostOrDomainIs("www", "www.example.test") || localHostOrDomainIs("ww", "www.example.test")
      || dnsDomainLevels("a.b.test") !== 2 || !shExpMatch("a/path.txt", "*/p?th.*")) throw new Error("helper mismatch"); return "DIRECT";`);
    expect(await value.resolve(target)).toEqual([null]);
  });
  test("weekdayRange supports single, inclusive range, wrap, local time and GMT", () => {
    const names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], now = new Date();
    expect(classicPacHelper("weekdayRange", [names[now.getUTCDay()]!, "GMT"], () => null)).toBe(true);
    expect(classicPacHelper("weekdayRange", [names[now.getDay()]!], () => null)).toBe(true);
    expect(classicPacHelper("weekdayRange", ["SUN", "SAT", "GMT"], () => null)).toBe(true);
    expect(classicPacHelper("weekdayRange", ["SAT", "FRI", "GMT"], () => null)).toBe(true);
    expect(() => classicPacHelper("weekdayRange", ["INVALID"], () => null)).toThrow();
  });
  test("DNS bridge preserves synchronous helper behavior and one lookup at a time", async () => {
    const calls: string[] = []; let inFlight = 0;
    const value = await policy(`if (dnsResolve("host.test") !== "10.2.3.4" || !isResolvable("host.test")
      || !isInNet("host.test", "10.0.0.0", "255.0.0.0") || !isInNet("127.0.0.1", "127.0.0.0", "255.0.0.0"))
      throw new Error("DNS mismatch"); return "PROXY route.test:80";`, { lookup: async host => {
      calls.push(host); expect(++inFlight).toBe(1); await Bun.sleep(2); inFlight--; return "10.2.3.4";
    } });
    expect(await value.resolve(target)).toEqual(["http://route.test:80"]);
    expect(calls).toEqual(["host.test", "host.test", "host.test"]);
  });
  test("helper return handles are released across a long-lived policy", async () => {
    const value = await policy(`for (var i = 0; i < 16; i++) {
      if (dnsDomainLevels("a.b.test") !== 2) throw new Error("helper mismatch");
      if (i < 16 && dnsResolve("127.0.0.1") !== "127.0.0.1") throw new Error("DNS mismatch");
    } return "DIRECT";`, { heapBytes: 1024 * 1024 });
    for (let request = 0; request < 2_000; request++) expect(await value.resolve(target)).toEqual([null]);
  });
  test("explicit negative DNS fixture has classic null/false semantics", async () => {
    const value = await policy(`if (dnsResolve("missing.test") !== null || isResolvable("missing.test")
      || isInNet("missing.test", "10.0.0.0", "255.0.0.0")) throw new Error("negative mismatch"); return "PROXY route.test:80";`,
    { lookup: async () => null });
    expect(await value.resolve(target)).toEqual(["http://route.test:80"]);
  });
  test("native-error categories, invalid answer and timeouts cannot be caught into DIRECT", async () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ETIMEOUT", "ECANCELLED"]) {
      await rejectsAndPoisons('dnsResolve("host.test"); return "DIRECT";',
        { lookup: async () => { throw Object.assign(new Error("private"), { code }); } });
    }
    await rejectsAndPoisons('dnsResolve("host.test"); return "DIRECT";', { lookup: async () => "::1" });
    await rejectsAndPoisons('dnsResolve("host.test"); return "DIRECT";',
      { dnsMs: 10, lookup: () => new Promise(() => {}) });
  });
  test("IPv6 DNS extensions, malformed IPs and extended shell patterns are fatal", async () => {
    for (const expression of ['dnsResolve("::1")', 'dnsResolve("127.1")', 'dnsResolve("0x7f000001")',
      'isInNet("127.0.0.1", "127.1", "255.0.0.0")', 'shExpMatch("a", "[ab]")',
      'shExpMatch("a", "{a,b}")', 'shExpMatch("a", "@(a|b)")', 'weekdayRange("MON", "timezone")', 'dnsResolve({toString: function(){return "a";}})']) {
      await rejectsAndPoisons(`${expression}; return "DIRECT";`);
      await expect(policy(`try { ${expression}; } catch (error) { return "DIRECT"; } return "PROXY route.test:80";`)).rejects.toThrow();
    }
  });
  test("helper and DNS budgets fail closed", async () => {
    await rejectsAndPoisons(`for (var i = 0; i < ${PAC_LIMITS.helperCalls + 1}; i++) isPlainHostName("x"); return "DIRECT";`);
    await rejectsAndPoisons(`for (var i = 0; i < ${PAC_LIMITS.dnsCalls + 1}; i++) dnsResolve("host.test"); return "DIRECT";`,
      { lookup: async () => "10.0.0.1" });
  });
  test("abort cancels bridge ownership, rejects queued work, and never starts another lookup", async () => {
    const controller = new AbortController(); let lookups = 0, cancelled = false;
    let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const value = await policy('dnsResolve("host.test"); return "DIRECT";', { lookup: (_host, signal) => {
      lookups++; signal.addEventListener("abort", () => { cancelled = true; }, { once: true }); entered();
      return new Promise(() => {});
    } });
    const active = value.resolve(target, controller.signal), queued = value.resolve(target);
    const results = Promise.allSettled([active, queued]);
    await enteredPromise; controller.abort();
    expect((await results).every(result => result.status === "rejected")).toBe(true);
    await expect(value.resolve(target)).rejects.toThrow();
    expect(lookups).toBe(1); expect(cancelled).toBe(true);
  });
  test("close aborts bridge ownership and rejects active and queued requests", async () => {
    let entered!: () => void, cancelled = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const value = await policy('dnsResolve("host.test"); return "DIRECT";', { lookup: (_host, signal) => {
      signal.addEventListener("abort", () => { cancelled = true; }, { once: true }); entered(); return new Promise(() => {});
    } });
    const finished = Promise.allSettled([value.resolve(target), value.resolve(target)]);
    await started; value.close();
    expect((await finished).every(result => result.status === "rejected")).toBe(true);
    expect(cancelled).toBe(true);
    await expect(value.resolve(target)).rejects.toThrow("closed");
  });
  test("queue admission and total wall deadline are bounded", async () => {
    const value = await policy('dnsResolve("host.test"); return "DIRECT";', { queueLimit: 1, lookup: () => new Promise(() => {}) });
    expect((await Promise.allSettled([value.resolve(target), value.resolve(target)])).every(result => result.status === "rejected")).toBe(true);
    const timed = await policy('dnsResolve("host.test"); return "DIRECT";', { wallMs: 10, lookup: () => new Promise(() => {}) });
    await expect(timed.resolve(target)).rejects.toThrow("deadline");
  });
});
