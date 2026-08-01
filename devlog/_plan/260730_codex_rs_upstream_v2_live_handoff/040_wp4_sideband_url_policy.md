# 040 — WP4: sideband URL policy parity

One full PABCD cycle. Independent of WP1-WP3; may run before or after them, but not
split internally.

## The three gaps

Upstream `438c9e98d` made WebRTC sideband joins use the Realtime API host
unconditionally, keep an explicit override for local development, and exclude provider
query parameters. OpenCodex diverges on all three points.

Upstream, for reference:

```rust
const OPENAI_REALTIME_API_BASE_URL: &str = "https://api.openai.com/v1";

pub fn new(provider: Provider) -> Self {
    Self { provider, webrtc_sideband_base_url: OPENAI_REALTIME_API_BASE_URL.to_string() }
}
```

```rust
websocket_url_from_api_url_for_call(
    self.webrtc_sideband_base_url.as_str(),
    /*query_params*/ None,
    event_parser, session_mode, call_id,
)
```

The override, read at `codex-rs/core/src/realtime_conversation.rs:1137`, replaces that
base when `experimental_realtime_ws_base_url` is set.

## Change map

| Path | Action |
|---|---|
| `src/server/live.ts` | MODIFY — `buildLiveSidebandUpstreamWsUrl` signature and body |
| `src/server/live.ts` | MODIFY — `resolveLiveSidebandUpgrade` passes the override through |
| `src/types.ts` | MODIFY — add the override config field |
| the live test file | MODIFY — URL construction matrix |

Test file verified to exist: `tests/server-live.test.ts` is the only test referencing
the sideband builder and is this phase's target.

## Diff 1 — the URL builder

MODIFY `src/server/live.ts:204`.

BEFORE (current, abridged to the deciding structure):

```ts
export function buildLiveSidebandUpstreamWsUrl(
  providerBaseUrl: string,
  usesBackendShape: boolean,
  target: LiveSidebandTarget,
): string {
  const root = providerBaseUrl.replace(/\/$/, "");
  if (usesBackendShape) {
    if (target.style === "frameless-path") {
      return httpsToWss(`${LIVE_SIDEBAND_API_ROOT}/live/${target.callId}`);
    }
    ...
  }
  if (target.style === "frameless-path") {
    const apiRoot = root.replace(/\/v1\/?$/, "");
    return httpsToWss(`${apiRoot}/v1/live/${target.callId}`);
  }
  ...
}
```

AFTER:

```ts
/**
 * Build the sideband websocket URL.
 *
 * Upstream policy (codex-rs 438c9e98d): the sideband join is NOT derived from the
 * selected model provider. Precedence is
 *   1. an explicit override (upstream: experimental_realtime_ws_base_url)
 *   2. otherwise the canonical Realtime API root
 * and provider query parameters are excluded either way.
 *
 * `providerBaseUrl` is retained only for the override-absent legacy path used by
 * self-hosted realtime endpoints; see the sidebandBaseUrl resolution below.
 */
export function buildLiveSidebandUpstreamWsUrl(
  providerBaseUrl: string,
  usesBackendShape: boolean,
  target: LiveSidebandTarget,
  overrideBaseUrl?: string,
): string {
  const sidebandRoot = sidebandBaseRoot(providerBaseUrl, usesBackendShape, overrideBaseUrl);
  if (target.style === "frameless-path") {
    return httpsToWss(`${sidebandRoot}/live/${target.callId}`);
  }
  if (target.style === "realtime-calls-path") {
    return httpsToWss(`${sidebandRoot}/realtime/calls/${target.callId}`);
  }
  return httpsToWss(
    `${sidebandRoot}/realtime?intent=quicksilver&call_id=${encodeURIComponent(target.callId)}`,
  );
}
```

The three target styles collapse into one path each because the host decision is
factored out. That collapse is the point: today the same three styles are written twice,
which is exactly how the two branches drifted apart.

## Diff 2 — the host resolver

NEW in `src/server/live.ts`, immediately above `buildLiveSidebandUpstreamWsUrl`:

```ts
/**
 * Resolve the sideband base, normalized to end in `/v1` with no query or fragment.
 *
 * Order:
 *   1. explicit override, when configured
 *   2. canonical LIVE_SIDEBAND_API_ROOT
 *
 * `providerBaseUrl` participates ONLY when the caller is not backend-shaped and the
 * provider is a self-hosted realtime endpoint the user configured deliberately; the
 * canonical root wins for every ordinary provider, matching upstream.
 */
function sidebandBaseRoot(
  providerBaseUrl: string,
  usesBackendShape: boolean,
  overrideBaseUrl?: string,
): string {
  const chosen = overrideBaseUrl?.trim()
    || (usesBackendShape ? LIVE_SIDEBAND_API_ROOT : preferredSidebandRoot(providerBaseUrl));
  return normalizeSidebandRoot(chosen);
}

/**
 * Strip query, fragment, and any trailing `/v1`, then re-append exactly `/v1`.
 * Upstream excludes provider query parameters from sideband URLs; string trimming
 * alone does not, so parse instead of slicing.
 */
function normalizeSidebandRoot(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return LIVE_SIDEBAND_API_ROOT;
  }
  parsed.search = "";
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  parsed.pathname = `${path}/v1`;
  return parsed.toString().replace(/\/$/, "");
}
```

`preferredSidebandRoot` is the decision this phase must settle explicitly rather than
inherit by accident. Two defensible definitions:

- **Strict upstream parity:** always return `LIVE_SIDEBAND_API_ROOT`. Simplest, matches
  upstream exactly, and breaks any user who points OpenCodex at a self-hosted realtime
  endpoint without setting the override.
- **Parity with an escape hatch:** return `LIVE_SIDEBAND_API_ROOT` unless the provider
  base URL is non-OpenAI *and* the user has opted in, in which case use the provider.

Recommendation: strict parity, plus the override from Diff 3 as the documented way to
reach a non-canonical host. That keeps one rule instead of a heuristic, and the override
is exactly the mechanism upstream provides for this case. Record the choice in the
phase's D summary either way.

## Diff 3 — the override config field

MODIFY `src/types.ts`, in `OcxConfig` (line 514):

```ts
/**
 * Explicit sideband websocket base URL for realtime/live joins. Mirrors upstream
 * `experimental_realtime_ws_base_url`: intended for local development and tests.
 * When unset, the canonical Realtime API root is used regardless of provider.
 */
experimentalRealtimeWsBaseUrl?: string;
```

MODIFY `src/server/live.ts:535` (`resolveLiveSidebandUpgrade`) to pass
`config.experimentalRealtimeWsBaseUrl` as the new fourth argument.

BEFORE:

```ts
return {
  headers: relay.headers,
  upstreamWsUrl: buildLiveSidebandUpstreamWsUrl(relay.providerBaseUrl, relay.usesBackendShape, target),
  recordOutcome: relay.recordOutcome,
};
```

AFTER:

```ts
return {
  headers: relay.headers,
  upstreamWsUrl: buildLiveSidebandUpstreamWsUrl(
    relay.providerBaseUrl,
    relay.usesBackendShape,
    target,
    config.experimentalRealtimeWsBaseUrl,
  ),
  recordOutcome: relay.recordOutcome,
};
```

The parameter is optional, so no other caller changes. Verify that with
`rg -n 'buildLiveSidebandUpstreamWsUrl' src tests` at P.

## Security note

This phase changes where a websocket carrying user audio and transcripts connects. Two
invariants must hold and be asserted, not assumed:

1. The override must never widen credential forwarding. `resolveLiveRelay` already
   refuses to forward OpenCodex's own admission bearer via
   `validateForwardAdmissionCredential` (`src/server/auth-cors.ts:245`); that check must
   still run on the override path.
2. A malformed override must fail closed to the canonical root, never to an
   attacker-influenced string. `normalizeSidebandRoot` returns
   `LIVE_SIDEBAND_API_ROOT` on a parse failure for exactly this reason.

## Accept criteria

1. With no override, every provider shape and every target style yields a
   `LIVE_SIDEBAND_API_ROOT`-based URL.
2. With an override set, all target styles use the override host.
3. A provider base carrying `?foo=bar` produces a sideband URL with no query except the
   `intent`/`call_id` pair the realtime style itself adds.
4. `https` normalizes to `wss`, `http` to `ws`.
5. A base with a trailing `/v1`, `/v1/`, or `/` yields exactly one `/v1` segment.
6. A malformed override falls back to the canonical root.
7. Frameless targets append the call id as a path segment; realtime targets append it as
   a query parameter, matching upstream's split.

### Activation scenarios

| Path | Trigger | Observable |
|---|---|---|
| override branch | config with `experimentalRealtimeWsBaseUrl` | constructed URL host equals the override host |
| malformed-override fallback | override `"not a url"` | constructed URL host is `api.openai.com`; the catch branch is exercised, not inferred |
| query-exclusion branch | provider base with a query string | no provider query in the result |
| duplicate `/v1` guard | base already ending `/v1` | exactly one `/v1` in the result |
| scheme rewrite | `http://` base | `ws://` result |

The malformed-override fallback and the query-exclusion branch are the two that would
otherwise ship unproven, since neither changes behavior for a well-formed default
config.

## Verification gate

`bun run typecheck` plus the live test file green, with a URL-construction matrix over
{override set, override unset} × {backend-shaped, api-key} × {frameless, realtime-calls,
realtime-query} and the seven criteria asserted.

## Appendix — `normalizeSidebandRoot` executed against real input

The helper above was run under Bun during this planning cycle, not merely reasoned
about. Output:

```
"https://api.openai.com/v1"       -> https://api.openai.com/v1
"https://api.openai.com/v1/"      -> https://api.openai.com/v1
"https://api.openai.com"          -> https://api.openai.com/v1
"https://api.openai.com/"         -> https://api.openai.com/v1
"https://example.com/api/v1"      -> https://example.com/api/v1
"https://example.com/api/v1/"     -> https://example.com/api/v1
"https://example.com/v1?foo=bar"  -> https://example.com/v1
"http://localhost:8080/v1"        -> http://localhost:8080/v1
"not a url"                       -> https://api.openai.com/v1
"https://example.com/v1/v1"       -> https://example.com/v1/v1
```

Four properties confirmed by execution rather than inspection:

1. A path prefix survives: `https://example.com/api/v1` keeps `/api` and does not
   collapse to `/v1`. A naive `replace(/\/v1.*$/, "")` would have destroyed it.
2. Query strings are dropped, which string trimming alone does not achieve.
3. `/v1` is idempotent across the bare, trailing-slash, and already-suffixed forms.
4. A malformed override falls back to the canonical root instead of throwing.

The last row documents a deliberate non-goal: `.../v1/v1` is left alone. Only one
trailing `/v1` is stripped, so a genuinely doubled path is treated as the user's intent
rather than silently rewritten. If B decides that should collapse instead, that is a
behavior change and belongs in the phase's D summary.

---

# Audit fold-back (A-phase, blocker 2, Critical)

An independent review found Diff 2 non-compilable: `sidebandBaseRoot` calls
`preferredSidebandRoot(providerBaseUrl)`, a function this doc named but never defined,
and then deferred its behavior to "a decision for this phase". A PRD that hands the
implementer an undefined call is not diff-level. Accepted.

**The policy is now decided in the document: strict upstream parity.** When no override
is configured, the canonical Realtime API root wins for every provider, backend-shaped
or not. That is exactly what upstream does, and the override is exactly the mechanism
upstream provides for reaching any other host.

This also removes the `usesBackendShape` input from the host decision entirely, which
is the deeper fix: that parameter is what let the two branches drift apart in the first
place.

## Diff 2, corrected and final

NEW in `src/server/live.ts`, replacing the Diff 2 block above in its entirety:

```ts
/**
 * Resolve the sideband base, normalized to end in `/v1` with no query or fragment.
 *
 * Upstream policy (codex-rs 438c9e98d): the sideband join is NOT derived from the
 * selected model provider. Precedence is exactly:
 *   1. the explicit override, when configured
 *   2. otherwise the canonical Realtime API root
 *
 * The provider base URL deliberately plays no part. A user who needs a non-canonical
 * sideband host sets the override, which is the same escape hatch upstream ships as
 * `experimental_realtime_ws_base_url`.
 */
function sidebandBaseRoot(overrideBaseUrl?: string): string {
  return normalizeSidebandRoot(overrideBaseUrl?.trim() || LIVE_SIDEBAND_API_ROOT);
}
```

`normalizeSidebandRoot` is unchanged from Diff 2 and is confirmed correct by the
appendix below.

## Diff 1, corrected signature

The builder no longer needs `providerBaseUrl` or `usesBackendShape` for the host
decision. Both parameters are retained in the signature only if other callers pass
them positionally; verify with `rg -n 'buildLiveSidebandUpstreamWsUrl' src tests` at P
and prefer deleting them if the only caller is `resolveLiveSidebandUpgrade`.

Preferred final form:

```ts
export function buildLiveSidebandUpstreamWsUrl(
  target: LiveSidebandTarget,
  overrideBaseUrl?: string,
): string {
  const sidebandRoot = sidebandBaseRoot(overrideBaseUrl);
  if (target.style === "frameless-path") {
    return httpsToWss(`${sidebandRoot}/live/${target.callId}`);
  }
  if (target.style === "realtime-calls-path") {
    return httpsToWss(`${sidebandRoot}/realtime/calls/${target.callId}`);
  }
  return httpsToWss(
    `${sidebandRoot}/realtime?intent=quicksilver&call_id=${encodeURIComponent(target.callId)}`,
  );
}
```

and the call site becomes:

```ts
upstreamWsUrl: buildLiveSidebandUpstreamWsUrl(target, config.experimentalRealtimeWsBaseUrl),
```

Dropping the two parameters is a breaking signature change inside the module, so it must
be done in the same commit as the call-site update, and any test calling the old
four-argument form updates with it.

## Behavior change this makes explicit

An API-key provider pointing at a non-OpenAI base URL previously received the sideband
connection at that base. After this change it receives the canonical host unless the
user sets `experimentalRealtimeWsBaseUrl`.

That is upstream's behavior, but it *is* a user-visible change for anyone relying on the
old derivation. The phase's D summary must say so plainly, and the release note should
name the override as the migration path. If that regression is judged unacceptable for
OpenCodex's multi-provider posture, the alternative is to keep provider derivation
behind an explicit opt-in config flag — but that is a deviation from upstream and needs
the user's decision, not the implementer's.

## Revised accept criteria

Criteria 1-7 above stand, with criterion 1 strengthened: with no override, *every*
provider shape yields a canonical-root URL, including API-key providers with a
non-OpenAI base. Add:

8. `buildLiveSidebandUpstreamWsUrl` no longer reads the provider base URL at all,
   verified by the absence of that parameter rather than by test behavior.

---

# Decision recorded: strict parity, and why onboarding is not at risk

The user selected strict upstream parity and asked whether it can be done without
disrupting anyone else's onboarding. Investigated, and the answer is yes — the feared
regression cannot actually occur on the current code.

## Evidence

`resolveLiveRelay` does not accept an arbitrary provider. Before any sideband URL is
built, it calls `selectOpenAiImagesProvider(config)`
([src/providers/openai-sidecar.ts:113](/Users/jun/Developer/new/700_projects/opencodex/src/providers/openai-sidecar.ts:113)),
and only two provider shapes can pass:

1. The **forward** candidate, gated by `isCanonicalOpenAiForwardProvider`
   ([src/providers/openai-tiers.ts:32](/Users/jun/Developer/new/700_projects/opencodex/src/providers/openai-tiers.ts:32)):

```ts
export function isCanonicalOpenAiForwardProvider(provider: OcxProviderConfig): boolean {
  return provider.adapter === "openai-responses"
    && provider.authMode === "forward"
    && normalizedBaseUrl(provider.baseUrl) === CODEX_FORWARD_BASE_URL;
}
```

2. The **keyed** candidate, gated inline at `openai-sidecar.ts:118-127`, which requires
   the provider id to be the built-in OpenAI one AND:

```ts
&& provider.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1"
```

Anything else is refused earlier with an explicit error:

```
Built-in ChatGPT voice needs an OpenAI upstream (ChatGPT login or an OpenAI API-key
provider), but none is configured in opencodex. Routed providers cannot serve voice
call-create.
```

## What this means for the migration risk

The API-key branch of `buildLiveSidebandUpstreamWsUrl` derives its host from
`providerBaseUrl`, but that value has already been constrained to exactly
`https://api.openai.com/v1` by the gate above. So the derived host and the canonical
host are **the same string today**.

Consequences:

- **There is no user whose sideband host changes.** A non-OpenAI base URL cannot reach
  this code path at all; it is rejected at provider selection with the message above.
- The `usesBackendShape` branch is therefore not a behavior fork in practice, only an
  unnecessary one. Removing it is a simplification, not a migration.
- The earlier warning in this doc ("this IS a user-visible change for anyone relying on
  the old derivation") is **withdrawn**. It was true of the URL builder read in
  isolation and false once the caller's gate is accounted for. No release-note migration
  path is needed.

Corollary worth stating: the third gap this phase set out to fix — provider query
parameters leaking into the sideband URL — is likewise unreachable today, because the
only permitted base URLs carry no query. `normalizeSidebandRoot` is defense in depth
against a future loosening of the provider gate, not a live bug fix.

## Revised framing for this phase

WP4 is therefore **hardening, not repair**. Its value is:

1. One rule instead of two, so the two branches cannot drift apart again the way they
   already did relative to upstream.
2. An explicit override knob (`experimentalRealtimeWsBaseUrl`) that does not exist today,
   which is what actually unblocks local development and tests against a fake realtime
   server.
3. Query-stripping and malformed-input fallback that stay correct if the provider gate
   is ever relaxed to admit self-hosted realtime endpoints.

Reclassify the phase's expected terminal outcome accordingly: `DONE` for the override and
the consolidation, with an explicit note that no user-visible routing change ships. If a
later cycle relaxes `selectOpenAiImagesProvider` to admit self-hosted realtime endpoints,
**that** is the cycle where the override becomes load-bearing, and its plan should cite
this section.

## Onboarding checklist for this phase (all must hold)

- [ ] No default-config user sees a different sideband host before and after. Prove by
      asserting the constructed URL is byte-identical for both the forward and keyed
      provider shapes.
- [ ] The override is optional; omitting it reproduces today's behavior exactly.
- [ ] The provider-selection error message is unchanged, so a misconfigured user gets the
      same guidance they get today.
- [ ] No new required config key. `experimentalRealtimeWsBaseUrl` is additive and unset by
      default, mirroring upstream's `experimental_*` naming so its status is obvious.

---

# P-phase re-verification (2026-07-31, execution cycle)

Stale check against the tree after WP1-WP3 (`b7ba91ca9`). Every anchor resolves:
builder at `src/server/live.ts:204` (three-argument form), sole production caller at
`:545`, `LIVE_SIDEBAND_API_ROOT` at `:56`, `OcxConfig` at `src/types.ts:514`, and the
only test at `tests/server-live.test.ts:554` with five three-argument call sites. No
uncommitted changes on any target file. The `005` staleness audit independently
confirmed both provider gates (`openai-tiers.ts:32`, `openai-sidecar.ts:117`) and the
upstream override key name (`experimental_realtime_ws_base_url`, `config_toml.rs:380`).

Two amendments.

## Amendment A — `intent=quicksilver` stays, and this phase stops claiming byte-parity

`005` finding: upstream appends only `call_id` to the realtime-query join
(`methods.rs:806`, `:987`); OpenCodex also sends `intent=quicksilver`. The reachability
argument that neutralized the HOST question does not apply here: the realtime-query URL
is live against real OpenAI infrastructure for every canonical voice user, so this
parameter is genuinely user-visible, and this phase has no way to verify a live join.

Decision: **keep `intent=quicksilver`.** The risk is asymmetric — removing a working
parameter could break voice for every user, while keeping it costs a documented
deviation. Consequences:

- This phase's parity claim is scoped to the host, override precedence, and query
  EXCLUSION (provider query parameters never leak). It is not byte-for-byte URL parity
  with upstream, and no text in this phase may claim that.
- Dropping the parameter is future work gated on a live smoke test against the real
  service, which is out of scope here.

## Amendment B — the trailing-slash admission case gets an explicit test

`005` finding: the keyed gate trims trailing slashes (`baseUrl.replace(/\/+$/, "")`),
so `https://api.openai.com/v1//` is admitted and today's builder would produce a
doubled `/v1//v1`-class path. After this phase the normalizer makes the whole class
unreachable, but the onboarding checklist's byte-identity proof must include a
trailing-slash keyed base, not only the canonical one, so the fix is observed rather
than inferred.

Added activation scenario:

| Path | Trigger | Observable |
|---|---|---|
| trailing-slash admission | keyed base `https://api.openai.com/v1//` | constructed URL is byte-identical to the canonical-base result |

## Scope note: the override lives in OcxConfig, not native config.toml

Upstream's `experimental_realtime_ws_base_url` is a native key consumed by the native
binary. OpenCodex's sideband join is built by the PROXY (`src/server/live.ts`), so the
native key would not affect this code path; the override is therefore an additive,
optional `OcxConfig` field. Reading the native key as a second source is a possible
later addition and is explicitly a non-goal here — one knob, one place, documented in
the field comment.

---

# A-phase fold-back, execution cycle (verdict GO-WITH-FIXES, 3 High blockers)

Independent terra review (Hegel). All three accepted and folded; near-pass with zero
residual.

## Blocker 1 (accepted) — runtime schema validation for the new field

The `OcxConfig` zod schema is `.passthrough()` (`src/config.ts:668`, `:699`), so
`{ "experimentalRealtimeWsBaseUrl": true }` would flow through and crash
`overrideBaseUrl?.trim()`. B adds `experimentalRealtimeWsBaseUrl:
z.string().optional().catch(undefined)` to the schema (a non-string value degrades to
unset, which then takes the canonical path), with tests for non-string, blank,
malformed, and valid inputs.

## Blocker 2 (accepted) — endpoint-form overrides are recognized before forcing `/v1`

Upstream does not treat the override as a bare root: it normalizes recognized
`/realtime` and `/live` endpoint paths (`methods.rs:994`). The planned normalizer would
turn `https://example.test/v1/realtime` into `.../v1/realtime/v1/realtime?...` — an
upstream-valid override silently broken. `normalizeSidebandRoot` gains one preceding
step, and the input contract stays "root OR recognized endpoint form":

```ts
// Endpoint-form overrides (what upstream accepts): strip the terminal endpoint
// segments so the root can be re-derived. Only the exact recognized shapes are
// stripped; anything else is treated as a root as before.
const path = parsed.pathname
  .replace(/\/+$/, "")
  .replace(/\/realtime(?:\/calls\/[^/]+)?$/, "")
  .replace(/\/live\/[^/]+$/, "")
  .replace(/\/v1$/, "");
parsed.pathname = `${path}/v1`;
```

Matrix additions: `https://example.test/v1/realtime` → `https://example.test/v1`;
`https://example.test/v1/realtime/calls/abc` → `https://example.test/v1`;
`https://example.test/v1/live/abc` → `https://example.test/v1`;
`https://example.test/v10` → `https://example.test/v10/v1` (a non-`/v1` root is used
verbatim with `/v1` appended — the contract is "root requiring v1", now stated in the
field comment).

## Blocker 3 (accepted) — the override's credential destination is bounded

The override controls where the RESOLVED relay headers — including the real OpenAI /
ChatGPT bearer — and the user's audio are sent (`live.ts:419`, `:543`, used at
`src/server/index.ts:723`). Permitting `http` → `ws` to an arbitrary remote host would
ship a plaintext credential-exfiltration path one config edit away. This is the
user's own config and key, but the same argument upstream makes for shipping only an
`experimental_` dev knob does not require us to make misuse silent.

Final validation, applied inside `normalizeSidebandRoot` before any of the path logic:

1. Scheme must be `https`/`wss`, OR `http`/`ws` with a loopback host
   (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`) — the local-development case
   the knob exists for. Anything else fails closed to the canonical root.
2. URL userinfo (`user:pass@host`) is rejected → canonical root. Credentials do not
   belong in this field, and `URL#toString()` would otherwise forward them verbatim.

Both failures are silent-by-design (fail closed, consistent with the malformed-input
fallback) and both get dedicated tests, including a security regression asserting a
remote `http://` override never reaches the builder output.

## Verified during this round

- Byte-identity holds for both admitted provider shapes before/after (forward backend
  shape and keyed `https://api.openai.com/v1` both already produce the canonical root —
  `live.ts:210`, `:223`), plus the promised `.../v1//` trailing-slash case.
- Upstream itself does not strip an existing query on the override (`methods.rs:923`);
  our query-stripping is a deliberate, documented deviation limited to that point.
- Management API exposure is correctly absent: `GET /api/config` is an allowlisted DTO
  and `PUT /api/config` is disabled (`config-routes.ts:69`, `:73`). The field is
  configured by editing the ocx config file, appropriate for an `experimental_*` knob.
