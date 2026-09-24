# 020 — wp3: picker core (CA, trust, CONNECT decision, claude.ai relay, bootstrap rewrite, routes)

Consumes: D3–D7 in [000](000_plan.md) and facts in [001](001_research.md). Controls this phase
carries: only claude.ai is terminated and only while trusted; the upstream leg always verifies
certificates; exactly one response (the bootstrap) is rewritten and the rewrite fails open; no
body, cookie or token is logged; every listener is loopback. Nothing here selects the Desktop
egress profile; with no profile applied, none of this code sees Desktop traffic. wp4 turns it on.

## Files

| Path | Change |
| --- | --- |
| `src/claude/intercept/local-ca.ts` | MODIFY: export a generic authority/leaf issuer; add the nameConstraints OID and encoder; existing intercept CA unchanged |
| `src/claude/intercept/picker-ca.ts` | NEW: picker CA (`<configDir>/claude-picker/`), claude.ai leaf, persisted leaf PEM for trust checks |
| `src/claude/intercept/picker-trust.ts` | NEW: macOS login-keychain trust/verify/untrust through an injectable `security` runner |
| `src/claude/intercept/picker-bootstrap.ts` | NEW: bootstrap request match, accept-encoding narrowing, decode, JSON injection, header rewrite |
| `src/claude/intercept/picker-models.ts` | NEW: picker entries from the rendered Desktop profile + snapshot holder |
| `src/claude/intercept/picker-listener.ts` | NEW: `node:https` HTTP/1.1 terminator for claude.ai with request + upgrade relay |
| `src/claude/intercept/picker-runtime.ts` | NEW: desired/trust/listener state, tunnel decision, lazy start/stop, trust cache |
| `src/claude/intercept/connect-proxy.ts` | MODIFY: per-connection `selectTunnel`; header comment |
| `src/claude/intercept/runtime.ts` | MODIFY: create the picker runtime, pass `selectTunnel`, stop it; expose picker state |
| `src/server/index/claude-intercept-lifecycle.ts` | MODIFY: pass the picker route loader (dynamic imports; `src/server/index.ts` untouched) |
| `src/claude/desktop-3p.ts` | MODIFY: export `displayModelId` (label parity) |
| `src/types/config.ts`, `src/config/schema/config-schema.ts` | MODIFY: `claudeCode.intercept.picker?: boolean` |
| `structure/runtime.md` | MODIFY: intercept pair gains the picker terminator; invariants |
| tests (below) + `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | NEW files registered in both |

## local-ca.ts

```diff
 const OID = {
+  nameConstraints: "2.5.29.30",
 …
+export interface AuthorityOptions {
+  commonName: string;
+  permittedDnsNames?: readonly string[];
+  excludeAllIpAddresses?: boolean; // default true (#5731)
+}
+
+/** iPAddress bases (address + mask, all zero) covering every IPv4 and every IPv6 address. */
+export const ALL_IP_ADDRESS_BASES: readonly Uint8Array[] = [new Uint8Array(8), new Uint8Array(32)];
+
+/** RFC 5280 NameConstraints: permittedSubtrees of dNSName bases, excludedSubtrees of every IP. */
+function nameConstraints(permitted: readonly string[], excludeAllIpAddresses: boolean): Uint8Array {
+  const subtrees = permitted.map(name => sequence(contextTag(2, new TextEncoder().encode(name), false)));
+  const excluded = ALL_IP_ADDRESS_BASES.map(base => sequence(contextTag(7, base, false)));
+  return sequence(
+    contextTag(0, concat(...subtrees)),
+    ...(excludeAllIpAddresses ? [contextTag(1, concat(...excluded))] : []),
+  );
+}
+
+export function createCertificateAuthority(options: AuthorityOptions): LocalInterceptCa { …same body as
+  createLocalInterceptCa, with commonName from options and, when permittedDnsNames is non-empty,
+  extension(OID.nameConstraints, true, nameConstraints(options.permittedDnsNames,
+    options.excludeAllIpAddresses !== false)) … }
+export function issueServerLeaf(ca: LocalInterceptCa, issuerCommonName: string, hosts: readonly string[]): PemKeyPair
-export function createLocalInterceptCa(): LocalInterceptCa { …
+export function createLocalInterceptCa(): LocalInterceptCa {
+  return createCertificateAuthority({ commonName: CLAUDE_INTERCEPT_CA_COMMON_NAME });
+}
-export function issueLocalInterceptLeaf(ca, hosts) { …
+export function issueLocalInterceptLeaf(ca: LocalInterceptCa, hosts: readonly string[]): PemKeyPair {
+  return issueServerLeaf(ca, CLAUDE_INTERCEPT_CA_COMMON_NAME, hosts);
+}
```

The persistence helpers become parameterized by directory and common name
(`ensurePersistedAuthority(dir, options, lockName)`) so the picker CA reuses loading, validation,
atomic 0600 key writes and the lifecycle lease without copying them.

## picker-ca.ts

```ts
export const PICKER_HOST = "claude.ai";
export const PICKER_CA_COMMON_NAME = "opencodex Claude Desktop Picker CA";
export const PICKER_STATE_DIR = "claude-picker";
export function pickerStateDir(configDir: string): string;           // <configDir>/claude-picker
export function pickerCaCertPath(configDir: string): string;         // …/ca.pem
export function pickerLeafCertPath(configDir: string): string;       // …/leaf.pem (public)
export interface PickerCa extends LocalInterceptCa { fingerprint: string } // sha256 of the CA DER
export function ensurePickerCa(configDir: string): PickerCa;         // permittedDnsNames: [PICKER_HOST]
export function issuePickerLeaf(ca: PickerCa, configDir: string): PemKeyPair; // SAN claude.ai; writes leaf.pem 0644
```

Reload validation (audit wp3 r1, High). The shared loader only checks CA status, key pairing and
self-signature, so `ensurePersistedAuthority` gains `accept?: (cert: X509Certificate) => boolean`,
and `ensurePickerCa` passes one that requires subject CN `PICKER_CA_COMMON_NAME` and a **critical**
nameConstraints extension whose permittedSubtrees hold exactly one dNSName, `claude.ai`, and
whose excludedSubtrees hold exactly two iPAddress bases, all-zero IPv4 (8 bytes) and all-zero IPv6
(32 bytes), so no IP-address leaf chains to it (PR #5731 review: a DNS-only permitted list leaves the
iPAddress form unconstrained). A persisted CA that fails it (for example a valid, key-matching CA
without constraints, or the first claude.ai-only format) is regenerated under the lease. The new
fingerprint makes trust `untrusted` until the operator trusts it again, so an unconstrained root is
never loaded and trusted as the picker CA.

## picker-trust.ts

```ts
export type PickerTrustState = "trusted" | "untrusted" | "unsupported" | "unknown";
export interface SecurityResult { code: number | null; stdout: string; stderr: string }
export type SecurityRunner = (args: readonly string[]) => Promise<SecurityResult>;
export const defaultSecurityRunner: SecurityRunner;                  // Bun.spawn(["/usr/bin/security", …])
export function loginKeychainPath(home?: string): string;            // ~/Library/Keychains/login.keychain-db
export async function inspectPickerTrust(leafPath: string, caSha1: string, run?: SecurityRunner, platform?: NodeJS.Platform): Promise<PickerTrustState>;
//   darwin only; "trusted" needs both:
//   1. ["find-certificate", "-a", "-Z", "-c", PICKER_CA_COMMON_NAME, loginKeychainPath()] lists caSha1 (the current CA)
//   2. ["verify-cert", "-q", "-L", "-c", leafPath, "-p", "ssl", "-n", "claude.ai", "-k", loginKeychainPath()] exits 0
//   3. ["trust-settings-export", <temp plist>] does not show kSecTrustSettingsPolicyString in the
//      caSha1 entry (a host-scoped setting from an earlier build; Chromium skips it, so it counts
//      as untrusted and the trust step replaces it); an unreadable export → unknown, so the picker
//      never arms on a setting it could not inspect
//   missing record or exit 1 → untrusted; a runner failure → unknown
export async function trustPickerCa(caPath: string, run?: SecurityRunner, platform?: NodeJS.Platform): Promise<{ ok: boolean; reason?: "unsupported" | "declined_or_failed" }>;
//   ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", loginKeychainPath(), caPath]
//   (no "-s claude.ai": found in the live proof, Chromium skips host-scoped trust settings and
//   Desktop failed with ERR_CERT_AUTHORITY_INVALID; the name constraints do the scoping)
export async function untrustPickerCa(caPath: string, fingerprintSha1: string, run?: SecurityRunner, platform?: NodeJS.Platform): Promise<{ ok: boolean }>;
//   ["remove-trusted-cert", caPath] then ["delete-certificate", "-Z", fingerprintSha1, loginKeychainPath()]
```

Only stdout/stderr lengths are logged, never content.

## picker-bootstrap.ts

```ts
export const BOOTSTRAP_MAX_ENCODED_BYTES = 4 * 1024 * 1024;
export const BOOTSTRAP_MAX_DECODED_BYTES = 16 * 1024 * 1024;
export const PICKER_SURFACE_ID = "code";
const BOOTSTRAP_PATH = /^\/(?:edge-api|api)\/bootstrap(?:\/[A-Za-z0-9-]+\/app_start)?\/?$/;
export function isPickerBootstrapRequest(method: string, pathname: string): boolean; // GET/HEAD-free: GET only
export function narrowBootstrapAcceptEncoding(): string;            // "gzip, deflate, br"
export interface PickerModelEntry { id: string; name: string; contextWindow?: number }
export function injectPickerModels(bootstrap: unknown, models: readonly PickerModelEntry[]): number;
export function rewriteBootstrapBody(encoded: Buffer, contentEncoding: string | undefined, models: readonly PickerModelEntry[]): Buffer | null;
export function rewrittenHeaders(raw: readonly string[], bodyLength: number): string[];
```

`injectPickerModels`: find `model_selector_config` (array) → surface `id === "code"` with array
`models`; template = first entry whose id starts with `claude-`, not `disabled`, no
`disabled_reason`, section not `deprecated`; for each model whose id is not already present:
`structuredClone(template)`, set `id`, `name`, `section: "main"`, set or delete
`context_window`, delete `disabled`, `disabled_reason`, `badge`, `tooltip`, `description`,
`fast_mode` and every key matching `/version/i` (version gates); keep `thinking` and
`capabilities`, which the intercept serves for routed models (effort translation, image
handling); push. Returns the number added (0 = leave the body untouched). `rewriteBootstrapBody` decodes
`gzip`/`x-gzip`/`deflate`/`br`/identity with `maxOutputLength` = the decoded cap, rejects
anything else or oversize, parses JSON, injects, and returns identity-encoded UTF-8 or `null`.
`rewrittenHeaders` drops `content-encoding`, `content-length`, `etag`, `digest`, `content-md5`,
`transfer-encoding` and sets `content-length`.

## picker-models.ts

```ts
export interface PickerRouteInput { nativeSlugs: string[]; routedModels: Desktop3pRoutedModel[]; profile?: OcxClaudeDesktopProfile; nativeContextCap?: NativeContextLimitsInput }
export function buildPickerModels(input: PickerRouteInput): PickerModelEntry[];
export interface PickerModelSnapshot { current(): { models: PickerModelEntry[]; builtAt: number } | null; refresh(): Promise<void>; refreshIfStale(maxAgeMs: number): void }
export function createPickerModelSnapshot(load: () => Promise<PickerRouteInput>, persistPath?: string): PickerModelSnapshot;
// persistPath (<configDir>/claude-picker/models.json, 0600): written after each successful build and
// read synchronously at construction, so a bootstrap served right after a restart already injects
// the last known routes while discovery refreshes in the background.
```

With a profile: `reconcileDesktopProfile` + `renderDesktopProfile` (src/claude/desktop-profile.ts:230,
:296) in the gateway's order and labels; without one: every candidate, label
`${displayModelId(id)} (${provider})`. Id: `native/<slug>` → `claudeCodeNativeAlias(slug)`,
otherwise `aliasForRoute(provider, id)`; routes whose alias is `null` and real
`anthropic/claude-*` routes are skipped (Anthropic's own rows already exist). Context window from
the candidate. Refresh errors keep the previous snapshot.

## picker-listener.ts

```ts
export interface PickerListenerOptions {
  leaf: PemKeyPair;
  models: () => readonly PickerModelEntry[];
  upstream?: { host: string; port: number; servername: string; ca?: string }; // test seam; default claude.ai:443, system roots
  /** Test seam: encoded bootstrap cap; production uses BOOTSTRAP_MAX_ENCODED_BYTES. */
  maxEncodedBytes?: number;
  log?: (line: string) => void;
}
export interface PickerListenerHandle { port: number; close(): Promise<void> }
export function startPickerListener(options: PickerListenerOptions): Promise<PickerListenerHandle>;
```

`https.createServer({ cert, key, ALPNProtocols: ["http/1.1"] })` on 127.0.0.1:0.
- `request`: build upstream headers from `req.rawHeaders` minus hop-by-hop
  (`connection`, `keep-alive`, `proxy-connection`, `proxy-authorization`, `te`, `trailer`,
  `transfer-encoding`, `upgrade`); `https.request` with `servername`,
  `rejectUnauthorized: true`, `agent: false` or a dedicated keep-alive agent. Non-bootstrap:
  `res.writeHead(status, filteredRawHeaders)` and `upRes.pipe(res)`; `req.pipe(upReq)`.
  Bootstrap (`isPickerBootstrapRequest`, status 200, JSON content type): set accept-encoding to
  `narrowBootstrapAcceptEncoding()` and hold the response head. Collect upstream chunks in order
  while the running total stays within the encoded cap. When a chunk would push the total past
  the cap, stop collecting: `writeHead` with the original filtered headers, write every collected
  chunk and then that triggering chunk in order (each byte exactly once), and only then
  `upRes.pipe(res)` for later data (the complete original body, unmodified). The collection
  listener is removed before piping, and `upRes` is paused while the head and collected bytes are
  written so no chunk is emitted between the switch; `pipe` then owns backpressure. If the
  upstream ends within the cap, call `rewriteBootstrapBody`; on `null` or zero injections
  `writeHead` the original headers and write the collected bytes; otherwise `writeHead` with
  `rewrittenHeaders` and the rewritten body. An upstream error before `writeHead` → 502; after
  it → destroy the client socket (the client sees a truncated response, never a spliced one).
- `upgrade`: `tls.connect` to upstream with the same verification, write the request line and
  raw headers, then `head`, and pipe both ways; destroy both on either error/close.
- Errors: 502 with an empty body; log `picker <method> <bootstrap|other> <status>` only.

## picker-runtime.ts

```ts
export type TunnelChoice = { kind: "intercept"; port: number } | { kind: "blind" };
export interface PickerRuntime {
  /** null → default behaviour. For claude.ai while the first refresh is pending, returns a promise that
   *  settles on `ready` or after PICKER_STARTUP_WAIT_MS (3 s), whichever is first; timeout or failure → blind. */
  selectTunnel(host: string, port: number): TunnelChoice | null | Promise<TunnelChoice | null>;
  refreshTrust(): Promise<PickerTrustState>;
  /**
   * Re-read the persisted config (options.readConfig, default loadConfig), recompute the mode
   * (resolveClaudeDesktopMode(fresh, observeClaudeDesktopMode(fresh))) and pickerDesired(fresh, mode),
   * refresh trust, then ensureStarted() when armable, else stop terminating. Never clears the
   * disarm latch. The 60 s interval calls this. selectTunnel only reads the cached result.
   */
  refresh(): Promise<void>;
  /**
   * Stop terminating claude.ai now, set the disarm latch and bump the arm generation. While latched,
   * refresh() and ensureStarted() never arm. An ensureStarted() already in flight captured the old
   * generation and must not arm when it completes.
   */
  disarm(): void;
  /**
   * Owner-only: called by the picker controller while it holds its lock, at the end of an enable
   * whose checks passed. Clears the latch and recomputes the decision with the isBusy() check
   * bypassed, so the next CONNECT is intercepted even before the lock is released.
   */
  rearm(): Promise<void>;
  ensureStarted(): Promise<void>;                                    // CA, leaf, listener, snapshot
  /** First refresh() now, then the refresh interval; resolves with that first refresh. Called once after the CONNECT proxy binds. */
  start(): Promise<void>;
  readonly ready: Promise<void>;
  status(): PickerRuntimeStatus;                                     // desired, supported, trust, listenerReady, effective, reason, models, snapshotAt
  stop(): Promise<void>;
}
export function createPickerRuntime(options: { config: OcxConfig; readConfig?: () => OcxConfig; isBusy?: () => boolean; configDir: string; loadRoutes: () => Promise<PickerRouteInput>; security?: SecurityRunner; platform?: NodeJS.Platform; now?: () => number; trustTtlMs?: number }): PickerRuntime;
export function pickerDesired(config: Pick<OcxConfig, "claudeCode" | "clientIntegrations">, mode: ClaudeDesktopMode, platform?: NodeJS.Platform): boolean;
// darwin && claudeDesktopIntegrationEnabled(config) (src/codex/desired-state.ts:214) && mode === "first-party"
//   && config.claudeCode?.intercept?.picker !== false
// `mode` is the observation-aware resolved mode (010): the runtime computes
// resolveClaudeDesktopMode(config, observeClaudeDesktopMode(config)) at start and on every trust
// refresh and caches it; status, apply wiring and the CLI pass the same resolved mode.
```

`selectTunnel` returns `{ kind: "intercept", port: listener.port }` for `claude.ai:443` only when
the decision cached by the last `refresh()` says armed (desired from the persisted config, not
latched), the listener
is up, and the cached trust is `trusted` for the current CA fingerprint; `{ kind: "blind" }` for
`claude.ai` otherwise; `null` for every other host. Trust is refreshed on `ensureStarted`, on
`refreshTrust` and on a 60 s interval while desired; the interval never blocks the event loop.

## connect-proxy.ts

```diff
 export interface ConnectProxyOptions {
   interceptPort: number;
   interceptHosts?: readonly string[];
+  /** Per-connection override, consulted before `interceptHosts`; `null` keeps the default. */
+  selectTunnel?: (host: string, port: number) => TunnelDecision | null | Promise<TunnelDecision | null>;
+  // TunnelDecision = { kind: "intercept"; port: number } | { kind: "blind" }
   dialUpstream?: (host: string, port: number) => Socket;
 }
-    const intercept = target.port === 443 && options.interceptHosts.includes(target.host);
-    const upstream = intercept
-      ? connect({ host: "127.0.0.1", port: options.interceptPort })
-      : options.dialUpstream(target.host, target.port);
+    // The client socket is already paused; an async decision (only claude.ai during the picker's
+    // first refresh, bounded by the runtime) keeps it paused until it settles; a rejection → blind.
+    const selected = await Promise.resolve(options.selectTunnel?.(target.host, target.port) ?? null)
+      .catch(() => ({ kind: "blind" as const }));
+    const choice = selected
+      ?? (target.port === 443 && options.interceptHosts.includes(target.host)
+        ? { kind: "intercept" as const, port: options.interceptPort }
+        : { kind: "blind" as const });
+    const upstream = choice.kind === "intercept"
+      ? connect({ host: "127.0.0.1", port: choice.port })
+      : options.dialUpstream(target.host, target.port);
```

Loopback 403 and non-CONNECT 405 stay before the choice. The header comment names claude.ai as the
only host that picker mode may terminate.

Callback shape (audit wp3 r1, High). The diff above is the decision logic, not the literal code:
`onData` stays synchronous. After the 405/403 checks it calls `dialFor(choice)` in the same tick
when `selectTunnel` is absent or returns a non-promise, so the default path is unchanged; otherwise
it runs `void Promise.resolve(decision).catch(() => blind).then(dialFor)`. `dialFor` returns
without dialing when `socket.destroyed` (the client left while the decision was pending) and then
runs today's dial, connect-timeout, error and splice block unchanged. `handleConnection` takes a
`ResolvedConnectProxyOptions` type that adds the optional `selectTunnel`, and `startConnectProxy`
copies `options.selectTunnel` into the resolved object.

## runtime.ts / lifecycle

`startClaudeIntercept` gains `loadPickerRoutes?: () => Promise<PickerRouteInput>`; it creates the
picker runtime (`createPickerRuntime({ config: options.config, … })`), passes
`selectTunnel: picker.selectTunnel` to `startConnectProxy`, and, once the CONNECT proxy has bound,
starts the picker with `picker.start()`: an immediate `refresh()` (which calls `ensureStarted()`
when armable and fills the cached decision) followed by the 60 s refresh interval. `start()`
returns the first refresh's promise (`picker.ready`) so tests and status can await it. It stops the
runtime in `stop()`. `getClaudePickerRuntime()` mirrors
`getClaudeInterceptState()` for status and the wp4 routes. `claude-intercept-lifecycle.ts` passes a
loader built from `fetchAllModels`, `filterCatalogVisibleModels`, `desktopVisibleNativeSlugs` and
`nativeContextLimits` through dynamic imports (the same inputs `/api/sync` uses,
src/server/management/config-routes.ts:213–231). `startServer` stays synchronous; no line is added
to `src/server/index.ts`.

Startup settlement (audit wp3 r1, High). `refresh()` catches its own failures (trust runner, CA,
listener bind, snapshot load), records them as `status().reason` and leaves the decision blind, so
`start()` resolves. `startClaudeIntercept` awaits `picker.start()` inside the same `try` that
guards `startConnectProxy`. The picker handle is nullable (`let picker: PickerRuntime | null = null`). If creating the picker
or `start()` still throws or rejects, it awaits `picker?.stop()` (picker listener and interval, only
when construction returned), then always `proxy.close()` and `listener.stop(true)`, before
rethrowing, so the lifecycle's catch never leaves a bound socket without a handle. `stop()` closes
the picker, then the proxy, then the listener. A `createPicker` option on
`StartClaudeInterceptOptions` is the test seam.

## Tests (NEW unless noted; every new file registered in layout.json and test-layout-expected.json)

| File | Cases (activation → observable) |
| --- | --- |
| `tests/claude-integration/claude-picker-ca.test.ts` | CA has critical nameConstraints permitting only claude.ai (parse extension bytes); leaf SAN is exactly claude.ai and chains (`X509Certificate.verify`); a TLS handshake through Bun (BoringSSL) with the picker CA as the only root accepts the claude.ai leaf and rejects a test-only leaf for `example.com` issued by the same CA; key file 0600; corrupt key regenerates; intercept CA has no nameConstraints (unchanged); a valid key-matching CA without the claude.ai constraint in the picker directory is regenerated with a new fingerprint |
| `tests/claude-integration/claude-picker-trust.test.ts` | fake runner receives the exact argv for find/verify/trust/untrust; a verified leaf whose SHA-1 record is missing or different → untrusted; exit 0/1/other → trusted/untrusted/unknown; non-darwin → unsupported without spawning |
| `tests/claude-integration/claude-picker-bootstrap.test.ts` | path matcher (both prefixes, org app_start, rejects others and POST); injection clones template, skips existing ids, drops fast_mode and version gates, leaves cowork and model_selector_state; gzip/br/deflate/identity round trip; malformed JSON, missing surface, unknown encoding and oversize → `null`; headers rewritten |
| `tests/claude-integration/claude-picker-models.test.ts` | routed alias `ocx-claude-xai--grok-4.7` and native alias; profile order/labels match the gateway render; anthropic/claude routes skipped; snapshot keeps last good on loader failure |
| `tests/claude-integration/claude-picker-listener.test.ts` | local https upstream (picker CA-issued fixture via the upstream seam): gzip body and two Set-Cookie headers pass byte-identical; SSE chunks arrive before the upstream ends; WebSocket upgrade echoes; bootstrap gets the injected entry with identity encoding; a bootstrap larger than the encoded cap (`maxEncodedBytes` seam set low, with the cap crossed in the middle of an upstream chunk) arrives byte-identical with its original headers; malformed bootstrap JSON arrives byte-identical; upstream with an untrusted cert → 502 |
| `tests/claude-integration/claude-picker-runtime.test.ts` | startup: with a pre-existing selected picker profile, trusted current CA, persisted first-party and intent on, the first CONNECT to claude.ai after `start()` resolves (`await picker.ready`) is `intercept`, with no timer tick; |
| (same file, continued) | a claude.ai CONNECT arriving while the first refresh is pending waits and is intercepted once `ready` resolves; with `ready` held past the 3 s bound it is blind; a snapshot persisted to `models.json` is injected into the first bootstrap after a restart before discovery completes; |
| (same file, continued) | selectTunnel: claude.ai blind until desired+trusted+listening, intercept after; trust loss flips back on refresh; non-claude hosts → null; non-darwin never intercepts |
| (same file, continued) | legacy install: owned first-party env in Claude Code settings, no saved `desktopMode`, picker intent unset → `pickerDesired` is true, so picker mode stays on by default across the upgrade; a `createPicker` that throws, and one whose `start()` rejects, each make `startClaudeIntercept` reject, and the proxy port binds again at once |
| `tests/claude-integration/claude-intercept-proxy.test.ts` (MODIFY) | a selectTunnel override is consulted per connection; an async decision keeps the client socket paused and pipelined bytes are delivered after it settles; a rejected decision is blind; loopback/405 refusals unchanged; a client that closes while the decision is pending causes no upstream dial |

Verifier: `bun test` on the files above plus `tests/claude-integration/claude-intercept*.test.ts`,
`tests/server/claude-intercept-integration.test.ts`, `tests/lab/core-lab-boundary.test.ts`,
`tests/test-layout.test.ts`, `tests/test-layout-tooling.test.ts`,
`tests/ci-workflows/file-size-ratchet.test.ts`; `bun run typecheck`; `bun run structure:check`.


## Desktop egress proxy (B-phase amendment)

Found while wiring: one CONNECT proxy cannot serve both clients. The Code tab's Claude Code trusts
only the intercept CA (`NODE_EXTRA_CA_CERTS`), so a claude.ai connection it opens through that proxy
would fail against the picker terminator; Desktop trusts only the login keychain, so its own
api.anthropic.com connections would fail against the intercept listener. Picker mode therefore gets
its own CONNECT proxy on `claudePickerProxyPort` (the intercept proxy port + 1, or − 1 at 65535),
started by `startClaudeIntercept` only when `loadPickerRoutes` is given (the server lifecycle always
passes `loadPickerRoutes`), with `interceptHosts: []` and `selectTunnel` from the picker runtime. On
it every host is blind except claude.ai while armed. The Claude Code proxy keeps its exact current
behaviour and gets no `selectTunnel`. `ClaudeInterceptState.pickerProxyPort` (null when unwired or
unbound) is what wp4 writes into `egressProxyUrl`. A bind failure on that port logs a warning, stops
the picker and leaves the intercept pair running. Tests: the Claude Code proxy never consults the
picker; the egress proxy blind-tunnels api.anthropic.com.

## Audit record

- wp3 round 1 (reviewer, FAIL, 3 High): persisted picker CA reload lacked constraint validation; the CONNECT diff awaited inside a synchronous callback and missed the options plumbing; picker startup failure could leave bound sockets. All three folded above. Round 2 GO-WITH-FIXES (1 High): a picker construction failure before assignment; folded as a nullable handle with a createPicker-throws test. Architect reflection ALIGNED, with the legacy first-party upgrade case added to the runtime tests.
