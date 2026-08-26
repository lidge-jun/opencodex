# 003 — Delivery: four issues, four pull requests

Each pain point gets its own issue and its own PR. Nothing here merges without
the maintainer saying so.

## Issue set

| # | Template | Title | Area |
|---|----------|-------|------|
| I1 | `bug_report.yml` | First-time OAuth add shows no copyable authorization link | Dashboard |
| I2 | `feature_request.yml` | Device-code logins need one consistent hint on every surface | Dashboard |
| I3 | `feature_request.yml` | Let the operator stop the proxy from opening its own browser | Authentication and account pool |
| I4 | `bug_report.yml` | A pasted redirect URL with fragment parameters is rejected as having no code | Authentication and account pool |

All four use `Client or integration: OpenCodex dashboard` where the form asks,
and every required field is filled — the `enforce-issue-quality` gate closes
untemplated issues rather than nudging them.

### I1 — required-field content

**Summary.** Once a provider is added, its workspace panel shows the
authorization URL with a copy button. During the *first* login for that
provider, started from the add-provider dialog, no link is shown at all — only
"Waiting for browser…". The proxy opens the URL in the OS default browser, so
an operator who needs a different browser profile, or who is running the
dashboard against a remote host, has no way to reach the login.

**Reproduction.**

1. Start with no xAI provider configured.
2. Open the dashboard, Providers, Add provider, Accounts tab.
3. Press Log in on a provider that is not yet added.
4. Observe: a spinner and "Waiting for browser…". No URL, no copy button, no
   device code, no paste field.
5. Add the provider, log out, press Log in from its workspace panel instead.
6. Observe: the URL, a copy button, and a device code when the provider sends
   one.

**Expected.** Step 4 offers the same recovery affordances as step 6.

### I2 — required-field content

**Goal.** Finish a device-code login from the dashboard without guessing.

**Blocker.** The user code is rendered on exactly one of four login surfaces.
The add-provider dialog reads only `url` and `instructions` from the login
response and drops `deviceCode`. One provider never sets `deviceCode` at all
and puts the code inside a prose string, so no surface can render it as a
code.

**Expected behavior.** Every surface that can start a login shows, when the
provider supplies them: the user code with a copy button, the verification URL
with a copy button, and a field to paste a redirect URL or code.

### I3 — required-field content

**Goal.** Complete an OAuth login in a chosen browser profile, or on a
different machine from the one running the proxy.

**Blocker.** `POST /api/oauth/login` always opens the authorization URL with
the platform opener, which resolves the default browser and therefore the
default profile. There is no request field, config key, or environment
variable to decline. With the dashboard open against a remote host, the
browser opens on the host.

**Expected behavior.** An explicit operator choice not to open a browser,
per login and persistently. Default behavior is unchanged: without that
choice, the browser opens exactly as it does today.

### I4 — required-field content

**Summary.** A redirect URL whose `code` and `state` arrive in the fragment
is rejected with "no authorization code found in input", although the paste
hint explicitly asks for the full URL from the address bar.

**Reproduction.** Start a login, complete it in a browser, paste a redirect of
the form `http://localhost:1455/callback#code=…&state=…` into the paste
field. Observe the rejection.

**Expected.** The code is read from the fragment, and state is still enforced.

## Pull requests

| PR | Closes | Base | Title |
|----|--------|------|-------|
| P1 | I2 | `dev` | `fix(gui): show the device code and authorization link on every login surface` |
| P2 | I1 | P1 head | `fix(gui): render the login hint during a first-time provider add` |
| P3 | I3 | `dev` | `feat(oauth): let the operator decline a proxy-side browser open` |
| P4 | I4 | `dev` | `fix(oauth): read code and state from a redirect URL fragment` |

P2 targets P1's head because it mounts the component P1 introduces; the
`enforce-target` check skips the wrong-base gate for a stacked child, and P2
retargets to `dev` once P1 lands.

### The disclosure P1 must carry

P1's Summary states the behavior change plainly rather than letting it hide in
the diff:

> Setting `deviceCode` for the one device provider that omitted it also stops
> the proxy from auto-opening that provider's verification URL, because the
> login route skips the browser open whenever a device code is present. This
> aligns it with the other two device providers and means no provider-supplied
> verification URL is handed to a local process spawn. The URL remains visible
> and copyable on every surface.

A reviewer reading only `kimi.ts` would not see the route.

## What is not delivered here

Recorded so the next cycle inherits them rather than rediscovering them:

- Allowlisting provider-supplied verification URIs for the two device
  providers that pass them through (security issue, own PR).
- Expiry countdown and poll-interval display.
- `ocx login`'s one-shot paste prompt, which does not re-prompt after a bad
  paste the way the dashboard does.
- A browser/profile picker built on an operator-supplied command.
