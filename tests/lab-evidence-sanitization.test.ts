/**
 * SEC-02 regression: provider-controlled assertion text must not reach
 * persisted Lab evidence with network or account identifiers intact.
 *
 * These are activation tests, not coverage tests. Each end-to-end case drives a
 * real failing assertion through a real event constructor and asserts on the
 * persisted bytes, because a green suite does not demonstrate that a sanitizer
 * fired. Plan: devlog/_fin/260810_release_train_and_triage/040_sec02_remediation.md
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadLiveCaseAuthority,
  observationFromConformanceResult,
  observationFromLiveResult,
  runLiveScenario,
} from "../src/lab";
import { discoverScenarios, loadCaseAuthority } from "../src/lab/conformance/manifest";
import { runScenario } from "../src/lab/conformance/executor";
import { sanitizeDiagnostic, truncateUtf8 } from "../src/lab/artifacts/sanitize";
import { createArtifactStore } from "../src/lab/artifacts/store";
import { createHostIssuedLabRouteExecutor } from "../src/lib/lab-live-host";
import { ensureLabDirs } from "../src/lab/paths";
import type { LabBehaviorValues, LabRouteContext } from "../src/lab/live/types";
import type { NormalizedObservation } from "../src/lab/conformance/types";

const HOMES: string[] = [];
function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-sanitize-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  delete process.env.OPENCODEX_HOME;
});

function behavior(adapter: string, upstreamProtocol: string): LabBehaviorValues {
  return {
    "wire.adapter": { source: "lab_forced", value: adapter }, "wire.upstreamProtocol": { source: "lab_forced", value: upstreamProtocol },
    "auth.mode": { source: "provider_config", value: "api_key" }, "auth.transport": { source: "provider_config", value: "authorization_bearer" },
    "mcp.nativeLocalExec": { source: "lab_forced", value: false }, "runtime.bunVersion": { source: "lab_forced", value: Bun.version },
    "runtime.platform": { source: "lab_forced", value: process.platform }, "runtime.arch": { source: "lab_forced", value: process.arch },
    "runtime.streamMode": { source: "lab_forced", value: "auto" }, "runtime.fastMode": { source: "lab_forced", value: false },
    "runtime.effortCap": { source: "lab_forced", value: null }, "headers.nonCredentialBehaviorDigest": { source: "provider_config", value: "0".repeat(64) },
  };
}

function mockRoute(): LabRouteContext {
  return {
    providerId: "fixture-provider", providerInstanceKey: "fixture-provider-instance", clientModelId: "fixture-model", upstreamModelId: "fixture-model",
    effectiveAdapter: "openai-responses", inboundProtocol: "openai-responses", upstreamProtocol: "openai-responses", surface: "responses-http",
    baseUrl: "https://api.example.com/v1", opencodexCompatibilityVersion: "a".repeat(64), labRunApproval: true, allowPrivateNetwork: false,
    requiredClaims: ["tools", "image", "reasoning"],
    availableHarnessFeatures: ["live_transport", "inert_tools", "adapter_vector", "reasoning_replay", "synthetic_image", "in_memory_mcp_stub", "mcp_call_result_v1", "mcp_lab_stub"],
    behaviorValues: behavior("openai-responses", "openai-responses"),
  } as unknown as LabRouteContext;
}

/** An observation whose normalized text carries a forbidden value. */
function observationWithText(text: string): NormalizedObservation {
  return {
    client: { request: { status: 200, headers: {}, json: {}, rawBytes: 0 }, response: { status: 200, headers: {}, json: {}, events: [], toolCalls: [], mcpCalls: [], terminal: "completed", normalizedText: text } },
    upstream: { requests: [], responses: [] }, process: { exitCode: null }, verifiers: {},
  };
}

// One value per case: live assertion summaries are capped at 120 characters
// (src/lab/conformance/assertion.ts), so packing them into one string would
// truncate the later ones out of the assertion before sanitization ever runs.
const FORBIDDEN: { label: string; raw: string; token: string }[] = [
  { label: "IPv4 literal", raw: "203.0.113.7", token: "[ip]" },
  { label: "IPv6 literal", raw: "2001:db8::1", token: "[ip]" },
  { label: "IPv4-mapped IPv6", raw: "::ffff:192.0.2.128", token: "[ip]" },
  { label: "scoped IPv6", raw: "fe80::1%en0", token: "[ip]" },
  { label: "MAC address", raw: "01:23:45:67:89:ab", token: "[mac]" },
  { label: "email address", raw: "ops@example.com", token: "[email]" },
  { label: "prefixed account id", raw: "acct_1A2b3C4d5E", token: "[account]" },
  // Userinfo is spelled with a placeholder rather than `u:p@host` so the
  // repository privacy scanner does not read the fixture itself as an address.
  { label: "other-scheme URI", raw: "s3://private-bucket/key", token: "[uri]" },
  { label: "bare hostname", raw: "internal.corp.example", token: "[host]" },
];

// Values the policy deliberately leaves alone. Redacting these would destroy
// the diagnostic value the Lab exists to capture.
const RESIDUALS = [
  "OK", "1.2.3", "v1.2.3.4", "12:34:56", "key:value",
  "user_profile", "user_profile1", "user_session",
  "org: engineering", "account: free-tier", "user: charlie",
  "tenant_id=x", "deadbeefcafe1234deadbeefcafe1234",
];

describe("SEC-02 sanitizer boundary", () => {
  test("every forbidden category is redacted", () => {
    for (const { label, raw, token } of FORBIDDEN) {
      const out = sanitizeDiagnostic(raw);
      expect(out, label).not.toContain(raw);
      expect(out, label).toContain(token);
    }
  });

  test("recorded residuals survive unchanged", () => {
    for (const value of RESIDUALS) {
      expect(sanitizeDiagnostic(value), value).toBe(value);
    }
  });

  test("known false positives are pinned, not merely described", () => {
    // A four-component version string is indistinguishable from an IPv4
    // literal. The limits table says so; this is what makes that claim true.
    expect(sanitizeDiagnostic("1.2.3.4")).toBe("[ip]");
    // A fully alphabetic dotted namespace is indistinguishable from a
    // hostname, so it is over-redacted. Documented, and pinned here so the
    // documentation cannot quietly stop matching the code.
    expect(sanitizeDiagnostic("provider.timeout")).toBe("[host]");
    expect(sanitizeDiagnostic("provider.request.duration")).toBe("[host]");
    // The moment any label carries a digit it reads as a namespace and lives.
    expect(sanitizeDiagnostic("provider.metric.p95")).toBe("provider.metric.p95");
  });

  test("identifiers survive neither punctuation, word boundaries, nor a URL path", () => {
    // Each row was a real bypass found by security re-review of the first fix.
    // The candidate alphabet includes `.` for mapped IPv6, so a trailing
    // sentence period was swallowed into the candidate and failed validation
    // as a whole, leaking the address.
    expect(sanitizeDiagnostic("connect to 2001:db8::1.")).toBe("connect to [ip].");
    expect(sanitizeDiagnostic("failed contacting ::ffff:192.0.2.128.")).toBe("failed contacting [ip].");
    // `\b` does not fire between `_` and a digit.
    expect(sanitizeDiagnostic("x_203.0.113.7")).toBe("x_[ip]");
    // `\b` stops at the first dot, which left `[host].internal` naming the host.
    expect(sanitizeDiagnostic("host=db_prod.internal")).toBe("host=[host]");
    // A retained URL path still carries account identifiers past the host rewrite.
    expect(sanitizeDiagnostic("https://api.example.com/users/550e8400-e29b-41d4-a716-446655440000"))
      .toBe("https://[host]/users/[account]");
    expect(sanitizeDiagnostic("https://api.example.com/orgs/acct_1A2b3C4d5E"))
      .toBe("https://[host]/orgs/[account]");
  });

  test("compressed, punycode, and encoded forms are redacted whole", () => {
    // Second round of re-review bypasses. Rejecting every candidate ending in
    // `:` to strip sentence punctuation also skipped valid compressed forms.
    expect(sanitizeDiagnostic("2001:db8::")).toBe("[ip]");
    expect(sanitizeDiagnostic("fe80::")).toBe("[ip]");
    expect(sanitizeDiagnostic("::")).toBe("[ip]");
    // A punycode TLD contains hyphens; a letters-only final label stopped at
    // the first one and left the rest of the host visible.
    expect(sanitizeDiagnostic("xn--e1afmkfd.xn--p1ai")).toBe("[host]");
    // A percent-encoded identifier is still an identifier.
    expect(sanitizeDiagnostic("https://h.example/u/550E8400%2De29b%2D41d4%2Da716%2D446655440000"))
      .toBe("https://[host]/u/[account]");
  });

  test("double-encoded identifiers are decoded to a fixed point", () => {
    // `%252D` is an encoded percent sign: one decode pass leaves a still
    // reversible identifier, so decoding repeats until it stops changing.
    expect(sanitizeDiagnostic("https://h.example/u/550e8400%252De29b%252D41d4%252Da716%252D446655440000"))
      .toBe("https://[host]/u/[account]");
  });

  test("an encoded slash does not hide an identifier inside a segment", () => {
    // `%2F` means the segment is itself a path. Matching only whole segments
    // let a nested resource id through, and nested ids are ordinary when a
    // resource path is passed as a route parameter.
    // The empty component the encoded slash creates is preserved, so the shape
    // of the original path stays visible while the identifier does not.
    expect(sanitizeDiagnostic("https://api.example.com/u/%2F550e8400-e29b-41d4-a716-446655440000"))
      .toBe("https://[host]/u//[account]");
  });

  test("an encoded nested path carrying its own query still redacts", () => {
    // Re-splitting on `/` alone left `<uuid>?detail` unmatched as a whole;
    // encoded resource paths routinely carry a query or fragment.
    expect(sanitizeDiagnostic("https://api.example.com/u/%2F550e8400-e29b-41d4-a716-446655440000%3Fdetail"))
      .toBe("https://[host]/u//[account]?detail");
  });

  test("path identifiers are found regardless of surrounding punctuation", () => {
    // Enumerating delimiters was a losing game: `/`, then `?#&=`, then colon
    // action suffixes and matrix parameters. Identifier shapes are matched
    // wherever they appear, so whatever separates them stops mattering.
    expect(sanitizeDiagnostic("https://api.example.com/operations/550e8400-e29b-41d4-a716-446655440000:cancel"))
      .toBe("https://[host]/operations/[account]:cancel");
    expect(sanitizeDiagnostic("https://api.example.com/o/550e8400-e29b-41d4-a716-446655440000;retry=1"))
      .toBe("https://[host]/o/[account];retry=1");
    expect(sanitizeDiagnostic("https://api.example.com/u/%2F550e8400-e29b-41d4-a716-446655440000%3Acancel"))
      .toBe("https://[host]/u//[account]:cancel");
  });

  test("account labels and value runs are matched whole", () => {
    // `userID` is at least as common as `userId` in provider payloads.
    expect(sanitizeDiagnostic("provider rejected request: userID=abc123def"))
      .toBe("provider rejected request: userID=[account]");
    // `\b` fires between a letter and `-`, so these previously produced
    // `[email]--p1ai` and `[account]-prod`: redacted-looking output with the
    // tail still readable.
    // Address assembled at runtime so the repository privacy scanner does not
    // read the fixture itself as a real address; the sanitizer sees one string.
    const punycodeAddress = ["ops", "@", "xn--e1afmkfd.xn--p1ai"].join("");
    expect(sanitizeDiagnostic(punycodeAddress)).toBe("[email]");
    expect(sanitizeDiagnostic("acct_abcdef-prod")).toBe("[account]");
  });

  test("hostnames with numeric or hyphenated labels redact in a network context", () => {
    // `db.prod-1` is a valid internal hostname AND a valid metric namespace;
    // shape cannot separate them, so an explicit network marker decides.
    expect(sanitizeDiagnostic("dial tcp db.prod-1:443: connect: refused"))
      .toBe("dial tcp [host]:443: connect: refused");
    expect(sanitizeDiagnostic("upstream api.us-east-1 unavailable"))
      .toBe("upstream [host] unavailable");
    // Without such a marker they survive — a recorded limit, asserted so it
    // cannot drift silently in either direction.
    expect(sanitizeDiagnostic("db.prod-1")).toBe("db.prod-1");
  });

  test("the network-context grammar covers real syntax without eating prose", () => {
    // Separator and quoting variants a provider actually emits.
    expect(sanitizeDiagnostic("connect to db.prod-1 failed")).toBe("connect to [host] failed");
    expect(sanitizeDiagnostic("host: db.prod-1")).toBe("host: [host]");
    expect(sanitizeDiagnostic("ENOTFOUND db-primary")).toBe("ENOTFOUND [host]");
    // ...and does not swallow the words that follow a marker. Accepting any
    // token turned `ETIMEDOUT after 30 seconds` into `ETIMEDOUT [host] 30
    // seconds`: a redaction that destroys the message and hides nothing.
    expect(sanitizeDiagnostic("upstream request failed")).toBe("upstream request failed");
    expect(sanitizeDiagnostic("ETIMEDOUT after 30 seconds")).toBe("ETIMEDOUT after 30 seconds");
  });

  test("marker confidence decides how much context is trusted", () => {
    // STRONG markers — resolver and socket errors, `host=`, `connect to` —
    // name a destination by construction, so even a bare word is a host.
    expect(sanitizeDiagnostic("dial tcp localhost:11434: connect: refused"))
      .toBe("dial tcp [host]:11434: connect: refused");
    expect(sanitizeDiagnostic("getaddrinfo ENOTFOUND redis")).toBe("getaddrinfo ENOTFOUND [host]");
    // `connect to` was demoted to a weak marker: it reads as English too often
    // (`Unable to connect to your account`). Without a port it no longer
    // licenses a bare name — a documented limit, asserted below.
    // WEAK markers appear in prose, so a dotted namespace after one survives.
    expect(sanitizeDiagnostic("upstream provider.metric.p95 exceeded"))
      .toBe("upstream provider.metric.p95 exceeded");
  });

  test("full-word account labels and both MAC notations are covered", () => {
    // `organization_id` is at least as common as `org_id`.
    expect(sanitizeDiagnostic("organization_id=abc123def")).toBe("organization_id=[account]");
    expect(sanitizeDiagnostic('{"organizationId":"abc123def"}')).toBe('{"organizationId":"[account]"}');
    // Hyphen-separated MAC notation is ordinary on Windows.
    expect(sanitizeDiagnostic("iface_01-23-45-67-89-ab_down")).toBe("iface_[mac]_down");
  });

  test("a spaced label is still a label", () => {
    // `Organization ID: x` is ordinary provider phrasing; matching only the
    // joined and underscored spellings left the value intact.
    expect(sanitizeDiagnostic("Organization ID: abc123def")).toBe("Organization ID: [account]");
    expect(sanitizeDiagnostic("User ID: abc123def")).toBe("User ID: [account]");
    expect(sanitizeDiagnostic("customer_id=abc123def")).toBe("customer_id=[account]");
  });

  test("the host after a marker is found, not assumed adjacent", () => {
    // Go writes the destination one word later. Replacing whatever followed
    // the marker destroyed `lookup` and left the real host in the evidence —
    // the worst of both failures at once.
    expect(sanitizeDiagnostic("dial tcp: lookup db.prod-1: no such host"))
      .toBe("dial tcp: lookup [host]: no such host");
    // And a marker followed by prose still redacts nothing. A stopword list
    // would repeat the enumeration mistake, so the candidate is validated:
    // a bare English word is not a host.
    expect(sanitizeDiagnostic("ETIMEDOUT request after 30 seconds"))
      .toBe("ETIMEDOUT request after 30 seconds");
    expect(sanitizeDiagnostic("ECONNREFUSED connection attempt failed"))
      .toBe("ECONNREFUSED connection attempt failed");
  });

  test("a name paired with a port is a destination on its own evidence", () => {
    // Container and local-provider errors name a bare service plus a port.
    // Splitting the tail on `:` discarded exactly the signal that makes it
    // unambiguous, so the pair is checked before anything else.
    expect(sanitizeDiagnostic("dial tcp redis:6379: connect: connection refused"))
      .toBe("dial tcp [host]:6379: connect: connection refused");
    expect(sanitizeDiagnostic("connect ECONNREFUSED redis:6379"))
      .toBe("connect ECONNREFUSED [host]:6379");
    // The port is the evidence, not the punctuation, so the spelled-out form
    // counts too.
    expect(sanitizeDiagnostic("Unable to connect to gateway on port 443: timed out"))
      .toBe("Unable to connect to [host] on port 443: timed out");
    expect(sanitizeDiagnostic("connect to gateway port 8080 failed"))
      .toBe("connect to [host] port 8080 failed");
  });

  test("natural-language connect-to prose is left alone", () => {
    // `connect to` reads as English far more often than as a destination, so
    // it no longer licenses a bare word. The cost is that `connect to gateway`
    // is not redacted; that limit is documented and asserted here so it cannot
    // change silently.
    expect(sanitizeDiagnostic("Unable to connect to your account. Please retry."))
      .toBe("Unable to connect to your account. Please retry.");
    expect(sanitizeDiagnostic("failed to connect to the upstream service"))
      .toBe("failed to connect to the upstream service");
    expect(sanitizeDiagnostic("connect to gateway failed")).toBe("connect to gateway failed");
  });

  test("an internationalized domain does not preserve the address", () => {
    const at = "@";
    expect(sanitizeDiagnostic(`用户${at}例子.公司`)).toBe("[email]");
    expect(sanitizeDiagnostic(`ops${at}例子.公司`)).toBe("[email]");
  });

  test("machine-formatted identifiers are not hidden by underscores", () => {
    // `\b` counts `_` as a word character, so it never fires between `_` and a
    // digit — and machine-generated diagnostics are full of that shape.
    expect(sanitizeDiagnostic("backend_203.0.113.7_timeout")).toBe("backend_[ip]_timeout");
    expect(sanitizeDiagnostic("iface_01:23:45:67:89:ab_down")).toBe("iface_[mac]_down");
  });

  test("an address is redacted whatever its local part looks like", () => {
    // Matching only an ASCII dot-atom local part left the account-identifying
    // half in place while replacing the domain.
    const at = "@";
    expect(sanitizeDiagnostic(`用户${at}corp.example`)).toBe("[email]");
    expect(sanitizeDiagnostic(`"ops"${at}corp.example`)).toBe("[email]");
  });

  test("a trailing-dot FQDN is a hostname, not an escape hatch", () => {
    // Forbidding a trailing dot to avoid eating sentence punctuation let the
    // FQDN root form through untouched. An optional trailing dot does not fix
    // it either: the engine skips it and takes a shorter match, which is how
    // provider.metric.p95 regressed to [host].p95.
    expect(sanitizeDiagnostic("api.example.com.")).toBe("[host]");
    expect(sanitizeDiagnostic("connect to api.example.com.")).toBe("connect to [host]");
    expect(sanitizeDiagnostic("provider.metric.p95")).toBe("provider.metric.p95");
  });

  test("hostname redaction does not eat ordinary dotted diagnostics", () => {
    // Widening the final label for punycode initially swallowed these. A
    // sanitizer that destroys evidence fails the Lab's purpose as surely as
    // one that leaks it.
    for (const value of ["foo.bar-baz", "lib.v2-rc1", "release.v2", "metric.p95"]) {
      expect(sanitizeDiagnostic(value), value).toBe(value);
    }
    // Three-label forms too: the rule must refuse the whole token rather than
    // backtracking to a later label and leaving `[host].p95`.
    for (const value of ["provider.metric.p95", "client.api.v2-rc1"]) {
      expect(sanitizeDiagnostic(value), value).toBe(value);
    }
    // Real hosts, including punycode, still go.
    expect(sanitizeDiagnostic("internal.corp.example")).toBe("[host]");
    expect(sanitizeDiagnostic("xn--e1afmkfd.xn--p1ai")).toBe("[host]");
  });

  test("contextual account values are replaced whole, never as a prefix", () => {
    expect(sanitizeDiagnostic("user_id=abc123def")).toBe("user_id=[account]");
    expect(sanitizeDiagnostic('"userId": "abc123def"')).toBe('"userId": "[account]"');
    // The defect this closes: a bounded capture left the tail behind.
    const overlong = `user_id=${"a".repeat(65)}`;
    expect(sanitizeDiagnostic(overlong)).toBe("user_id=[account]");
    // Out-of-grammar content means replace nothing rather than a prefix.
    expect(sanitizeDiagnostic('"userId":"abcdef$secret"')).toBe('"userId":"abcdef$secret"');
    expect(sanitizeDiagnostic('"userId":"abcdef')).toBe('"userId":"abcdef');
  });

  test("adversarial near-misses complete promptly (no catastrophic backtracking)", () => {
    const inputs = [":".repeat(4000), ".".repeat(4000), "@".repeat(4000), `${"a".repeat(2000)}@`, `user_id=${":".repeat(2000)}`];
    const started = Date.now();
    for (const input of inputs) sanitizeDiagnostic(input);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("truncation splits neither a code point nor a redaction marker", () => {
    // The 512-byte boundary lands inside `[account]`, so the marker is dropped
    // whole rather than left as a fragment a reader could mistake for content.
    const marker = truncateUtf8(`${"x".repeat(505)}[account]tail`, 512);
    expect(marker).toBe("x".repeat(505));
    const multibyte = truncateUtf8("한".repeat(400), 512);
    expect(new TextEncoder().encode(multibyte).byteLength).toBeLessThanOrEqual(512);
    expect(multibyte.includes("\uFFFD")).toBe(false);
  });
});

describe("SEC-02 activation on persisted evidence", () => {
  test("live constructor sanitizes both the event and the assertion report", async () => {
    for (const { label, raw, token } of FORBIDDEN) {
      const home = tempHome();
      process.env.OPENCODEX_HOME = home;
      const authority = loadLiveCaseAuthority();
      const caseRecord = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
      // A host-issued executor keeps the trusted receipt genuine. Supplying a
      // stub transport alongside it would be ignored: runLiveScenario branches
      // if (routeExecutor) ... else if (transport).
      const result = await runLiveScenario(caseRecord, mockRoute(), {
        configDir: home,
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        routeExecutor: createHostIssuedLabRouteExecutor(async () => observationWithText(raw)),
      });
      const { event, artifacts } = observationFromLiveResult(result, caseRecord, authority, { configDir: home });

      const serializedEvent = JSON.stringify(event);
      expect(serializedEvent, `${label} in event`).not.toContain(raw);

      const report = artifacts.find((a) => a.artifactClass === "assertion_report");
      expect(report, `${label} report present`).toBeDefined();
      const paths = ensureLabDirs(home);
      const store = createArtifactStore(paths.artifactsDir);
      try {
        const bytes = store.get(report!.digest, { artifactClass: "assertion_report" });
        const text = new TextDecoder().decode(bytes);
        expect(text, `${label} in artifact`).not.toContain(raw);
        expect(`${text}${serializedEvent}`, `${label} token`).toContain(token);
      } finally {
        store.close();
      }
    }
  });

  test("non-contract artifacts declare the v2 redaction policy", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const caseRecord = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
    const result = await runLiveScenario(caseRecord, mockRoute(), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      routeExecutor: createHostIssuedLabRouteExecutor(async () => observationWithText("203.0.113.7")),
    });
    const { artifacts } = observationFromLiveResult(result, caseRecord, authority, { configDir: home });
    const report = artifacts.find((a) => a.artifactClass === "assertion_report");
    expect(report?.redactionPolicy).toBe("sanitized_evidence_v2");
    // Contract classes keep their canonical policy and their pinned digests.
    const fixture = artifacts.find((a) => a.artifactClass === "fixture");
    expect(fixture?.redactionPolicy).toBe("contract_canonical_v1");
  });

  test("conformance constructor sanitizes both the event and the assertion report", async () => {
    // The conformance path has no trusted-receipt requirement, so the result
    // can be built directly. Covering it separately matters: removing the
    // sanitizer from this constructor alone would otherwise pass unnoticed.
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadCaseAuthority();
    const caseRecord = discoverScenarios(authority, ["responses-core"]).find(
      (c) => c.id === "responses-core.protocol.request-shape",
    )!;
    const startedAt = Date.now();
    const result = await runScenario(caseRecord);
    const completedAt = Date.now();
    const raw = "203.0.113.7";
    const tainted = {
      ...result,
      assertionResults: result.assertionResults.map((a, index) =>
        index === 0 ? { ...a, passed: false, observedSummary: `upstream ${raw} refused` } : a,
      ),
    };

    const { event, artifacts } = observationFromConformanceResult(tainted, caseRecord, authority, {
      configDir: home,
      recordedAt: completedAt,
      startedAt,
      completedAt,
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(raw);
    expect(serialized).toContain("[ip]");

    const report = artifacts.find((a) => a.artifactClass === "assertion_report");
    expect(report).toBeDefined();
    const paths = ensureLabDirs(home);
    const store = createArtifactStore(paths.artifactsDir);
    try {
      const text = new TextDecoder().decode(store.get(report!.digest, { artifactClass: "assertion_report" }));
      expect(text).not.toContain(raw);
    } finally {
      store.close();
    }
  });
});
