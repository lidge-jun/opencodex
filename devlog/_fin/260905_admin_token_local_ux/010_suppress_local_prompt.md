# 010 — Never prompt a standalone dashboard for an admin token

Work-phase `wp1`. Depends on 000. Criterion `c-1`.

## Problem

`gui/src/api.ts:resolveTokenAfter401()` treats "the server would not mint me a
session" as "ask the human for a token". On a loopback install those are not the
same thing. `issueGuiSession` mints unconditionally for a loopback host with an
allowed origin (`src/server/gui-session.ts:172-183`), so a 401 there means the
request did not look loopback to the server — a Host/Origin/bind problem. No
token the user can type changes that verdict, because the token is not what was
refused.

## The signal

The server already states its topology on every served document:

```ts
// src/server/gui-static.ts:95
function runtimeRoleMeta(runtimeRole: string): string {
  return \`<meta name="opencodex-runtime-role" content="\${escapeHtmlAttribute(runtimeRole)}">\`;
}
```

and the GUI already reads it (`gui/src/api-targets.ts:10-14`). That comment block
is explicit that a missing tag means "standalone / older server / Vite dev", i.e.
the safe default. This unit reuses that exact reader rather than inventing a
second topology signal.

The rule: **the admin-token prompt is for a deployment that actually requires a
typed credential.** That is the non-loopback bind, which is the `hub` role. Any
other role — `standalone`, `client`, or an absent tag — must not prompt.

## Change

In `gui/src/api-targets.ts`, add a sibling to `isConnectedRuntime()`:

```ts
/**
 * May this dashboard ask the user to type an admin token?
 *
 * Only a hub does. A standalone loopback install mints its own session
 * (src/server/gui-session.ts), so a refusal there is a Host/Origin
 * misconfiguration that no typed token can repair — prompting for one asks the
 * user to answer a question they did not cause and cannot diagnose (#3353).
 * A missing tag reads as standalone, matching runtimeRoleFromDocument's
 * existing safe default.
 */
export function adminTokenPromptAllowed(): boolean {
  return runtimeRoleFromDocument() === "hub";
}
```

In `gui/src/api.ts:resolveTokenAfter401()`, gate the prompt and record why it was
skipped:

```ts
if (renewed.kind === "failed") return null;
if (!adminTokenPromptAllowed()) {
  state.promptCancelled = true;      // do not re-ask on every subsequent 401
  reportSessionUnavailable(plane);   // surface an actionable notice instead
  return null;
}
const prompted = await requestAdminToken(...);
```

`promptCancelled = true` matters: without it every failing request re-enters the
resolution path. The existing `storeSession` already resets that flag when a
session is later minted (`gui/src/api.ts:81`), so recovery is automatic once the
misconfiguration is fixed.

## What the user sees instead

A dismissible notice, not a form. Copy names the real cause and the real fix:

> **The dashboard could not start a session.** OpenCodex is running, but this
> page's address is not one it recognises as local. Open the dashboard at the
> address the proxy prints on startup (usually `http://127.0.0.1:<port>`), or see
> the dashboard access guide.

`reportSessionUnavailable` is a thin, testable seam: it dispatches a
`CustomEvent` the shell renders. It must not be a `alert()` and must not block.

## Verification

`bun test gui/tests/api-auth-deadline.test.ts` plus a new case:

- role `standalone` (and absent tag): after 401 + `unavailable` rebootstrap the
  injected `adminTokenPrompt` spy is **not** called, the request resolves, and a
  second failing request does not call it either.
- role `hub`: the spy **is** called (the legitimate path stays intact).

The role must be settable per test — the tests build their own `happy-dom`
document, so the case writes the meta tag before `installApiAuthFetch()`.

## Out of scope

No server change. `issueGuiSession`, `requireManagementAuth`, and the CORS
resolvers keep their current semantics; this phase only stops the GUI from
asking a question the server never wanted asked.
