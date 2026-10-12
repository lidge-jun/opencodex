# 031 — #2107 implementation record

Branch: `fix/service-proxy-env` off `origin/dev` @ `18e072c8d`.
Commit: `eb910776a`. PR: **#2116** → `dev`.

## What the plan said vs what the tree said

`030` was written against a read of the code and held up on every point, with one
correction worth recording.

**The plan asked for a guard that already exists.** It said "do not emit empty
`Environment=` lines". All three builders already drop falsy values before
joining — `systemdEnvironmentAssignment` returns `null`,
`buildPlist` uses ternaries, `windowsBatchSet` returns `null` — and each list is
`.filter(Boolean)`ed. So the risk was real in principle and already handled in
practice; adding a second guard would have been noise.

That is the useful shape of this correction: the plan named a hazard from
reading a diff, and the tree had already solved it structurally.

## The change

One helper plus three call sites:

```
resolvedProxyEnv(env = process.env): { name, value }[]
  for each of PROXY_ENV_KEYS  (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY)
    value = env[KEY]?.trim() || env[key]?.trim()      // either case
    if (value) push({ name: KEY, value })             // canonical name only
```

| Builder | Line of insertion |
|---|---|
| `buildUnit` | after `opencodexHome`, mapped through `systemdEnvironmentAssignment` |
| `buildPlist` | after `OPENCODEX_HOME`, mapped to `<key>/<string>` |
| `buildWindowsServiceScript` | after `OPENCODEX_HOME`, mapped through `windowsBatchSet` |

Reading both letter cases but writing only the upper-case name matters: curl-style
tooling sets `http_proxy`, and emitting both spellings into one definition would
leave two sources of truth for one setting.

## Verification

```
bun test tests/service.test.ts     126 pass / 0 fail
bun x tsc --noEmit                 exit 0
```

**Red-drive, recorded.** With the three `resolvedProxyEnv()` call sites stripped
out, the primary test fails on exactly the missing line:

```
Expected to contain: "Environment=\"HTTP_PROXY=http://127.0.0.1:7890\""
(fail) bakes outbound proxy env into the unit ... (#2107)
 1 pass  1 fail
```

and nothing else in the file breaks. Restoring the fix returns 126/0.

The companion test (no proxy in the shell → no proxy keys emitted) passes in both
states by design. It is not an oracle for the fix; it is a guard that the fix
cannot start emitting empty assignments later.

## What this deliberately does not do

- **No interactive `ExecStart`.** `bash -ic` would make service startup depend on
  the user's interactive shell — a worse failure mode than the bug.
- **No `NO_PROXY` synthesis.** The runtime's `applyProxyEnv` already keeps
  loopback off the proxy path; inventing a value here could diverge from it.
- **No credential handling decision.** A proxy URL can carry credentials, and
  baking it writes that to disk. `config.proxy` already works for that case
  without this change. Raised in the PR body as an open question rather than
  silently resolved.

## CI posture

Not consulted. `dev` is mid-merge-train (30 commits in the window this work
started) and its checks are noisy by construction. Verification here is local
and complete for the changed surface; CI becomes the gate once the train
settles.
