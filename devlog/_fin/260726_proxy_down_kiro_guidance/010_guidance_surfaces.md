# 010 — Implementation detail (diff-level)

## 1. `src/cli/index.ts`

### 1a. Status render (after the `❌ Proxy:` branch, ~line 596-600)

Current:

```ts
if (status.json.proxy.pid || status.json.proxy.health.ok) {
  console.log(`✅ Proxy: ${status.proxyLabel}`);
} else {
  console.log(`❌ Proxy: ${status.proxyLabel}`);
}
console.log(`   Health: ${status.healthLabel}`);
```

Add, gated on the SAME condition as the ❌ branch — `!(status.json.proxy.pid ||
status.json.proxy.health.ok)` (audit blocker 2: gating on `!proxy.running` =
`!(pid && health.ok)` would self-contradict the ✅ branch in the
"reachable, but PID file is missing or stale" state):

```ts
if (!(status.json.proxy.pid || status.json.proxy.health.ok)) {
  console.log("   ↳ Not running — Codex/Claude requests will fail with connection errors.");
  console.log("     Restart with 'ocx start', or install the persistent service: 'ocx service install'.");
}
```

### 1b. Downtime warning at the `case "stop"` call site ONLY (src/cli/index.ts:667-669)

Audit blocker 1: handleStop has three callers — `case "stop"` (:667), `case "restart"`
(:851, immediately re-ensures), and tray restart (:395, immediately restarts). A
warning inside handleStop would misfire for restart flows, printing "requests will
fail until restarted" one line before the flow itself restarts the proxy. Emit at the
explicit-stop call site instead:

```ts
case "stop": {
  if (await handleStop()) {
    console.log("⚠️  Codex/Claude requests through the proxy will fail until it is restarted ('ocx start' or 'ocx service start').");
  }
  break;
}
```

handleStop returns `!stopFailed`, so ownership-blocked/failed stops stay silent.

## 2. `src/cli/doctor.ts`

New exported helper near the other collect/format helpers:

```ts
export function proxyDownRestartHint(input: {
  proxyRunning: boolean;
  port: number;
  serviceViable: boolean;
}): string | null {
  if (input.proxyRunning) return null;
  const restart = input.serviceViable
    ? "Restart it with 'ocx service start' (service installed) or 'ocx start'."
    : "Restart it with 'ocx start', or install the persistent service: 'ocx service install'.";
  return `The ocx proxy is not running. Codex/Claude clients pinned to 127.0.0.1:${input.port} fail with errors like "error sending request for url (http://127.0.0.1:${input.port}/v1/responses)". ${restart}`;
}
```

Wire into the Hints section of runDoctor:

```ts
const proxyDown = proxyDownRestartHint({
  proxyRunning: <live pid/runtime record found>,
  port: <config.port ?? 10100>,
  serviceViable: startup.serviceViable,
});
if (proxyDown) hints.push(proxyDown);
```

`proxyRunning` source: the same `readPid()` + `readRuntimePort(pid)` pair already used
in the Memory/runtime block — hoist those two reads above the Hints block (cheap,
synchronous, already imported). Config port: `readConfigDiagnostics()` is already
called for startup health; keep one call and reuse the result.

## 3. `src/oauth/kiro.ts` (loginKiro)

onAuth instructions →

```ts
"No kiro-cli token found. Paste a Kiro access token below (starts with 'aoa'). " +
"Otherwise install the Kiro CLI (`curl -fsSL https://cli.kiro.dev/install | bash`), " +
"run `kiro-cli login`, and retry — or set KIRO_ACCESS_TOKEN."
```

Final throw →

```ts
"Kiro: no token found. Install the Kiro CLI (`curl -fsSL https://cli.kiro.dev/install | bash`) " +
"and run `kiro-cli login` to import its session, or set KIRO_ACCESS_TOKEN. " +
"Browser login is not supported for Kiro."
```

Also update the CLI-side onProgress line at kiro.ts:85 for consistency (audit
non-blocking note — same function, would contradict the new instructions):

```ts
ctrl.onProgress?.("No kiro-cli token found. Paste a Kiro access token (starts with 'aoa'), or install the Kiro CLI and run `kiro-cli login` first.");
```

## 4. `src/providers/registry.ts` kiro note

```ts
note: "Import-first: reuses your installed Kiro CLI login — requires kiro-cli installed and signed in (`kiro-cli login`). Experimental third-party harness — see Kiro ToS.",
```

## 5. docs-site `guides/codex-integration.md` (+ ko/ja/zh-cn/ru)

New section next to "Catalog troubleshooting":

```md
### Proxy connection errors

If Codex shows retries followed by an error like
`stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)`
(and Claude Code shows a similar connection failure), the opencodex proxy is not
running — nothing is listening on the configured port. Restart it:

​```bash
ocx start              # foreground
ocx service install    # persistent: auto-starts on login and respawns on crash
​```

Check state any time with `ocx status`; `ocx doctor` reports restart safety.
```

Same content translated per locale (short section, keep code blocks identical).

## 6. docs-site `guides/providers.md` (+ ko/ja/zh-cn/ru)

- Kiro table row Notes cell: prepend "Requires the Kiro CLI installed
  (`curl -fsSL https://cli.kiro.dev/install | bash`) and signed in via `kiro-cli login`."
- "Kiro credential import" section: add the same prerequisite sentence before the
  env-var paragraphs. Locale mirrors keep code/commands identical.

## 7. Tests

- tests/kiro-oauth.test.ts — extend the no-token test: `rejects.toThrow(/cli\.kiro\.dev\/install/)`
  and keep `/no token found/i`; add an instructions-capture test for the onAuth text
  (loginKiro with onManualCodeInput + onAuth spy, empty input → assert instructions).
- tests/doctor.test.ts — `proxyDownRestartHint`: returns null when running; includes
  port, symptom substring, `ocx start`; prefers `ocx service start` when serviceViable.
