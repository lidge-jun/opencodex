# 020 — Mihomo IPv6 fake-ip discovery exception (#3462)

Work-phase: one full PABCD cycle. Closes #3462.
Source evidence lane output is reproduced below verbatim (diff-level). Stale-check
against the current tree at this cycle's P before implementing.

---

1) VERDICT: FIXABLE

Neither dev nor [PR #3489](https://github.com/lidge-jun/opencodex/pull/3489) fixes #3462. Implement a separate, proxy-only IPv6 fake-IP exception; do not carry #3489 as this issue’s fix.

2) EVIDENCE

Snapshot: checkout HEAD is `6d9639165581546cdcebe96bc911446caabdd7d0`; local `origin/dev` has advanced to `980a9fbede123f411f52c8b061a05fb995ae159d`. The two destination-policy/outbound files are unchanged between them.

- [src/lib/destination-policy.ts:191](/Users/jun/.codex/worktrees/ef41/opencodex/src/lib/destination-policy.ts:191):
  ```ts
  if (hextet >= 0xfc00 && hextet <= 0xfdff)
    return { kind: "private", detail: "private-network address" };
  ```
  Thus `fdfe:dcba:9876::7e` is **private-network**, not `non-global` as the cached maintainer comment claims.

- [src/lib/destination-policy.ts:138](/Users/jun/.codex/worktrees/ef41/opencodex/src/lib/destination-policy.ts:138):
  ```ts
  if (assessment?.kind !== "private" || assessment.detail !== "non-global address") return false;
  ```
  The reported ULA fails before the explicit-zero mapped-address check. Existing exceptions cover IPv4 `198.18/15` and its supported IPv6 embeddings, not native Mihomo ULA.

- [src/lib/provider-outbound.ts:157](/Users/jun/.codex/worktrees/ef41/opencodex/src/lib/provider-outbound.ts:157):
  ```ts
  allowBenchmarkAddresses: proxyConfigured && !noProxyMatches(parsed),
  ```
  [src/codex/catalog/provider-fetch.ts:1668](/Users/jun/.codex/worktrees/ef41/opencodex/src/codex/catalog/provider-fetch.ts:1668) sends discovery through `providerOutboundPost/Get`; [destination-policy.ts:443](/Users/jun/.codex/worktrees/ef41/opencodex/src/lib/destination-policy.ts:443) admits only `isBenchmarkDnsAnswer(...)`.

- **Do not broaden the shared helper blindly.** [src/server/management/provider-routes.ts:732](/Users/jun/.codex/worktrees/ef41/opencodex/src/server/management/provider-routes.ts:732):
  ```ts
  const allowBenchmarkAddresses = name === "openai" && isCanonicalOpenAiForwardProvider(provider);
  ```
  This config-validation caller is not proxy-gated.

- `gh pr diff 3489`: six changed files, **no change to destination-policy.ts**. Its outbound hunk changes admission to:
  ```ts
  allowBenchmarkAddresses: (proxyConfigured && !noProxyMatches(parsed))
    || transparentFakeIpException(url, parsed, isCanonicalUrl, name),
  ```
  This enables existing benchmark classification for canonical discovery without proxy env. It does not recognize `fdfe:dcba:9876::/48`. Tests cover `198.18.0.29` and `::ffff:0:c612:1b`, not that ULA.

- PR remains `APPROVED`, `CONFLICTING`, head `dbcfde8ca445c8dd04b04932904798664aae9cab`. Its old root-level test paths also need migration before any separate carry.
- `gh pr view 3489 --json commits`: all three commits name **`opencodex-fix <opencodex-fix@local>`**, with empty GitHub login/id. This is the available commit email, **not verified account-linked attribution** for Flowershangfromthebranches.

3) DIFF-LEVEL PLAN

**MODIFY [src/lib/destination-policy.ts](/Users/jun/.codex/worktrees/ef41/opencodex/src/lib/destination-policy.ts)**

Keep `classifyIpv6`, `isBenchmarkDnsAnswer`, literal validation, and config-time validation unchanged. Reuse `ipv6Hextets`; add one internal matcher:

```ts
const MIHOMO_IPV6_FAKE_IP_PREFIX = [0xfdfe, 0xdcba, 0x9876] as const;

function isMihomoIpv6FakeIpAnswer(address: string): boolean {
  if (isIP(address) !== 6) return false;
  const groups = ipv6Hextets(normalizeHostname(address));
  return groups !== null
    && MIHOMO_IPV6_FAKE_IP_PREFIX.every((group, i) => groups[i] === group);
}
```

Extend only `resolvePublicAddresses` options with `allowMihomoIpv6FakeIp?: boolean`; derive a default-false local boolean. Change its DNS-answer exception:

```diff
- if (benchmarkAllowed && isBenchmarkDnsAnswer(address, assessment)) {
+ if ((benchmarkAllowed && isBenchmarkDnsAnswer(address, assessment))
+   || (mihomoIpv6Allowed
+     && assessment?.kind === "private"
+     && assessment.detail === "private-network address"
+     && isMihomoIpv6FakeIpAnswer(address))) {
```

Retain existing validated-address push and `continue`: accepted synthetic answers must not set `privateNetwork`.

**MODIFY [src/lib/provider-outbound.ts](/Users/jun/.codex/worktrees/ef41/opencodex/src/lib/provider-outbound.ts)**

```diff
  allowBenchmarkAddresses: proxyConfigured && !noProxyMatches(parsed),
+ allowMihomoIpv6FakeIp: proxyConfigured && !noProxyMatches(parsed),
```

Document the independent flag: any later #3489 canonical/TUN exception must **not** enable it. The successful route continues fetching the original hostname with `redirect: "manual"` at lines 170–172.

**MODIFY existing regression files; NEW files: none**

- [tests/routing/destination-policy-resolved.test.ts](/Users/jun/.codex/worktrees/ef41/opencodex/tests/routing/destination-policy-resolved.test.ts): extend its DNS mock tests with:
  - Accepted under the new flag: compressed, uppercase, expanded forms; `/48` lower/upper bounds and a nonzero fourth hextet.
  - Rejected with no flag or **benchmark-only** flag.
  - Literal `[fdfe:dcba:9876::7e]` still rejected.
  - Adjacent `/48`s, ordinary ULA, loopback, metadata, link-local, RFC1918, and mixtures containing those remain rejected.
  - Config validation with `allowBenchmarkAddresses: true` still rejects this ULA.
  - An integrated `providerOutboundGet` case using this file’s real mocked-DNS resolver: explicit proxy succeeds through mocked native fetch; absent proxy and `NO_PROXY` reject without fetching or pin-connecting.

  Representative added assertion:
  ```ts
  lookupMock.mockResolvedValueOnce([{ address: "fdfe:dcba:9876::7e", family: 6 }]);
  const result = await resolvePublicAddresses("https://opencode.ai/zen/v1/models", {
    context: "provider URL",
    allowMihomoIpv6FakeIp: true,
  });
  expect(result.privateNetwork).toBe(false);
  ```

- [tests/providers/provider-outbound.test.ts](/Users/jun/.codex/worktrees/ef41/opencodex/tests/providers/provider-outbound.test.ts): extend existing proxy/no-proxy option-capture tests to assert the new flag independently.

Layout confirmed: `layout.json:577/927` and `test-layout-expected.json:414/764` already register these filenames under `routing` and `providers`. No manifest additions needed.

Focused commands, **not run in this lane**:

```bash
bun test tests/routing/destination-policy-resolved.test.ts
bun test tests/providers/provider-outbound.test.ts
```

**Docs MODIFY:** `docs-site/src/content/docs/reference/configuration/providers.md`, “Provider diagnostic outbound safety,” plus corresponding `ko`, `ja`, `zh-cn`, `zh-tw`, `fr`, `ru`, and `tr` pages. Explain exact-prefix DNS-only accommodation, configured-proxy requirement, `NO_PROXY` exclusion, and unchanged literal/private protections.

**Risk:** C4 SSRF/credential-destination boundary; explicit security review required by [MAINTAINERS.md:60](/Users/jun/.codex/worktrees/ef41/opencodex/MAINTAINERS.md:60). No auth-store, credential formatting, or logging changes. Keep unpublished security analysis in scratch, not `devlog`.

4) OPEN QUESTIONS / residual uncertainty

- A ULA prefix alone cannot prove an answer is synthetic. A genuine private deployment could use the same `/48`. The proposed exception prevents direct local connections and preserves other private-address rejection, but still trusts the configured proxy’s final routing—as existing docs explicitly acknowledge. Do not claim collision-free or absolute SSRF equivalence.
- This fixes the reported **explicit-proxy discovery** scenario, not no-proxy IPv6 TUN or general provider-save validation.
- PR #3489 also claims public+benchmark mixtures reject; the inspected resolver loop accepts public answers alongside allowed benchmark answers. Do not reuse that claim without a regression.
- No edits, tests, Git writes, GitHub comments, or agents were executed. Memory informed attribution caution only; code/PR conclusions were checked live.


