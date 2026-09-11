# 000 — Research: why a plain local user is shown an admin token box

Two open issues describe the same wound from opposite ends.

- **#3483** (juzijia, Windows 10, 2.42.0) — the admin token dialog paints an
  empty red error notice the moment it opens, before anything is submitted.
- **#3353** (Tao-Yida) — after upgrading to 2.40.0 a user was locked out of the
  dashboard by a bare password box, assumed a config-loss bug, and had to have
  an LLM read the source to learn the token was a new security feature.

The user's framing is stronger than either issue, and it is the one this unit
adopts: **a plain local user should never see that dialog at all.** When it does
appear it is a symptom, and the box asks the user to solve a problem they did
not cause and cannot diagnose.

## How the dashboard is supposed to authenticate

A loopback install never needs a typed credential. The server mints a session
and injects it into the served document:

```
GET /opencodex-session
  -> src/server/index.ts:2074  issueGuiSession(...)
  -> src/server/gui-session.ts:166
  -> meta opencodex-session-token / -csrf / -origin / -server-origin
     (src/server/gui-static.ts:71-74)
```

`gui/src/api.ts:loadInjectedSession()` reads those tags on boot. Verified live
against the running 2.43.0 proxy on port 10100:

```text
curl -i -H 'Host: 127.0.0.1:10100' http://127.0.0.1:10100/opencodex-session
HTTP/1.1 200 OK
<meta name="opencodex-session-token" content="ocx_session_CO-4g0m5B_...">
```

So on the happy path the prompt is unreachable. The interesting question is what
happens when that mint fails.

## The fallback that should not be a fallback

`gui/src/api.ts:resolveTokenAfter401()` (around line 247) handles a 401 like this:

```ts
const renewed = await Promise.race([reBootstrapSessionToken(plane), watchdog]);
if (renewed.kind === "minted") return renewed.token;
if (renewed.kind === "failed") return null;
const prompted = await requestAdminToken(token => verifyAdminToken(plane, token));
```

`reBootstrapSessionToken` maps **any 4xx** to `"unavailable"`:

```ts
if (!response.ok) return response.status >= 400 && response.status < 500
  ? { kind: "unavailable" } : { kind: "failed" };
```

And `"unavailable"` is precisely the branch that raises the password box.

Now read the mint conditions (`src/server/gui-session.ts:172-183`):

```ts
if (!isApiAuthRequired(config)) {
  if (!isLoopbackHostname(host.hostname) || !isAllowedManagementOrigin(req, config)) return null;
  ...
}
```

with `isApiAuthRequired(config) === !isLoopbackHostname(config.hostname)`
(`src/server/auth-cors.ts:285`).

That yields the defect in one sentence: **on a loopback install the only ways to
get a 401 from the bootstrap are a Host or Origin mismatch — a misconfiguration
the admin token cannot fix.** Typing a token there is not a recovery path; it is
a dead end wearing a login form.

And when the bind genuinely is non-loopback, the token is real and required —
but the dialog explains none of that, which is exactly #3353.

## Why the notice is already red and empty (#3483)

`gui/src/admin-token-dialog.ts:76-79` builds the error element up front:

```ts
validationError.className = "notice notice-err";
validationError.hidden = true;
```

`hidden` works only because the UA stylesheet says `[hidden] { display: none }`,
and that rule is the weakest one in the cascade. `gui/src/styles.css:1307` then
says:

```css
.notice { ... display: flex; ... }
```

An author rule with an explicit `display` beats the UA `[hidden]` rule, so the
element stays laid out. It has `notice-err` borders and padding
(`styles.css:1355-1359`) and no text, which renders as the empty red box in the
screenshot. The bug is a CSS cascade defect, not a logic error — which is why no
existing test caught it: happy-dom asserts `hidden === true` happily while a real
browser paints the box.

## What this unit changes

1. Never prompt a standalone/loopback dashboard. Tell the user what is actually
   wrong instead. (`010`)
2. When the prompt is legitimate, make it self-explanatory and link to a real
   setup guide. Fix the empty notice while in there. (`020`)
3. Triage the Windows baseline and #3320 and land what is provable. (`030`)
4. Deliver as a stacked PR chain, admin-merged to `dev`. (`040`)

## Constraints carried from the request

- No repository-wide local suite on this workstation. Focused `bun test <file>`
  plus `bun run typecheck`; heavy probes go to SSH hosts.
- A Windows baseline is already in flight on `desktop-c795oh4` under
  `/c/ocxwin` (lock `/c/ocxwin/.suite.lock`, shards `base-1..4`). It is read-only
  evidence for this unit and must not be disturbed.
