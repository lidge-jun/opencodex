# 020 — WP3: `ocx status` reports routing and warns on an unused proxy (#2411)

## The change in one sentence

`ocx status` prints the routing kind it already computes, and says so plainly
when a healthy proxy is paired with native routing.

## The design question, settled

Two shapes:

- **A (chosen):** keep `✅` on the proxy line, always print `routing=`, and add
  a warning only for the healthy-proxy + native-routing combination.
- **B:** flip the first line to `⚠️` for that combination.

B is tempting because the reporter's complaint is literally "the check is
green." But the proxy line makes a narrow claim — the process is up and
`/healthz` answered — and that claim is **true** in this state. The reporter
proved it himself by curling the proxy directly and getting `ok`. Turning that
line yellow would make the one honest signal lie in order to compensate for a
missing one. It also collides with the existing `❌` path, whose remedy text
("Restart with 'ocx start'") is wrong for this failure: the proxy does not need
restarting, Codex needs re-pointing.

So: add the missing signal, do not corrupt the present one.

## Hunk 1 — extract the routing detail so status and doctor cannot drift

`src/codex/autostart-health.ts`, next to `startupHealthSummary` at `:143`:

```ts
export function formatStartupRoutingDetail(health: StartupHealth): string {
  const service = health.serviceViable
    ? "viable"
    : health.serviceInstalled ? "installed-but-unhealthy" : "absent";
  const shim = health.shimHealthy
    ? "healthy"
    : health.shimInstalled ? "stale" : "absent";
  return `routing=${health.routingKind}, service=${service}, shim=${shim}`;
}
```

`src/cli/doctor.ts:986` then becomes a call to it, emitting byte-identical
output. This matters: #2457 exists because two routes computed the same thing
separately and drifted. Do not introduce a second copy of doctor's line.

## Hunk 2 — the warning predicate

`src/cli/status.ts`, pure and exported for direct testing, in the manner of
`src/cli/status-oauth.ts:55`:

```ts
export function unusedProxyWarningLines(input: {
  proxyUp: boolean;
  routingKind: StartupHealth["routingKind"];
}): string[] {
  if (!input.proxyUp || input.routingKind !== "native") return [];
  return [
    "⚠️  Codex routing is native — the running proxy is unused.",
    "   Codex requests go to OpenAI, not this proxy. Re-point with: ocx restore back",
  ];
}
```

A pure function is the point: the interesting behavior is a two-input truth
table, and it should be testable without spawning a CLI.

## Hunk 3 — render

`src/cli/index.ts`, after the Health line at `:850`:

```ts
const proxyUp = Boolean(status.json.proxy.pid || status.json.proxy.health.ok);
for (const line of unusedProxyWarningLines({
  proxyUp,
  routingKind: status.json.startup.routingKind,
})) {
  console.log(`   ${line}`);
}
```

and after `Restart safety` at `:869`:

```ts
console.log(`   ${formatStartupRoutingDetail(status.json.startup)}`);
```

Placing the routing detail directly under restart safety is deliberate. That
summary line is the one that reads as a second all-clear ("no opencodex restart
dependency"); the routing token immediately below it supplies the missing
context for why there is no dependency.

## Truth table

| Proxy | Routing | First line | Warning | `routing=` |
|-------|---------|-----------|---------|------------|
| up | `opencodex-local` | ✅ | no | yes |
| up | `native` | ✅ | **yes** | yes |
| up | `custom-remote` | ✅ | no | yes |
| down | `native` | ❌ | no | yes |

`custom-local` / `custom-remote` are also "this proxy is unused," but they are
a deliberate operator choice and `startupHealthSummary` already names them as a
remote gateway. Warning there would train people to ignore the warning. Native
is the accidental state, and the only one #2411 reports.

Proxy down plus native routing must not warn: the operator has two problems and
the `❌` line with its restart remedy is the correct lead.

## JSON

No schema change, no `schemaVersion` bump. `startup.routingKind` is already in
the payload — the gap was never the data. Adding a derived
`proxyUnusedByCodex` boolean was considered and rejected: consumers can
combine two fields they already have, and `tests/cli-status-json.test.ts:21`
pins `schemaVersion === 1`.

## What must NOT change

- `classifyCodexRouting`, `getCodexRoutingKind`, `deriveStartupHealth`,
  `startupHealthSummary`. This phase reads them; it does not touch them.
- `rebootSafe: true` for native routing. `tests/autostart-health.test.ts:108`
  pins it, and it is correct: there really is no restart dependency.
- The `❌` branch and its `ocx start` / `ocx service repair` guidance.
- Redaction behavior of `status --json`.
- Anything in #2412's shim territory. The two issues are related as cause and
  symptom but ship as separate PRs, per the maintainer's own split.

## Regression tests

| Test | File | Assertion | Fails before? |
|------|------|-----------|---------------|
| `unusedProxyWarningLines covers the four routing states` | `tests/cli-status-json.test.ts` | the truth table above | **Yes** — helper absent |
| `status prints routing=native without starting the proxy` | `tests/cli-help.test.ts` (extend `:139`) | stdout has `routing=native`, and does **not** have the unused-proxy warning while the proxy is down | **Yes** |
| `status --json exposes startup.routingKind` | `tests/cli-status-json.test.ts` | `parsed.startup.routingKind === "native"` | No — pins existing data against future removal |
| `formatStartupRoutingDetail matches doctor's line` | `tests/autostart-health.test.ts` | `routing=native, service=absent, shim=absent` | **Yes** |

The CLI tests need a temp `CODEX_HOME` holding a `config.toml` without
`openai_base_url`; `tests/codex-plugins-doctor.test.ts:356` is the pattern.

## Acceptance

`bun test tests/cli-status-json.test.ts tests/cli-help.test.ts tests/autostart-health.test.ts tests/codex-plugins-doctor.test.ts`
green; `bun x tsc --noEmit` exit 0; `bun run privacy:scan` pass; doctor's
output byte-identical before and after the extraction.
