# Incident lane — Codex sign-in lockout after an applied integration (#5261)

Status: OPEN, dispatched out of band and ahead of the phase 2 bundles. This is a user-reported
incident, not a roadmap item.

## What was reported

A Windows 11 user on 2.59.0 configured the Codex integration, repeatedly failed to add an account
pool, then could not call any model from Codex. After restarting, Codex would no longer sign in at
all: the client showed only "Unable to load sign-in requirements" and a Retry button. The reporter's
own analysis is that every Codex request was being routed to the local proxy on port 10100 and hung
there.

## Why this outranks a model-routing bug

The damaging part is not the failed inference. It is that the user is locked out of Codex sign-in
while the integration stays applied. A reboot does not clear an applied integration, so the lockout
survives it, and the failure surface offers no recovery the user can act on — the only visible
control is Retry against the endpoint that is failing. A user in that state cannot reach the
product that would let them undo the change.

## What the lane must establish from source, not assume

1. What the Codex integration apply path actually writes, and whether its scope covers only
   inference or also the authentication and sign-in bootstrap.
2. What happens to those requests when the proxy is absent or hung: a bounded timeout, a fail-open
   path, or an indefinite wait.
3. Whether Windows can reach a state where the integration stays applied while the service is not
   running, including after a reboot.
4. Whether a recovery path exists that does not require the proxy to be running, and whether a user
   in the failure state can discover it.
5. The account-pool add failure that triggered the sequence, recorded precisely rather than assumed
   to share a cause.
6. Whether anything already on `dev` since 2.59.0 changes this path.

## Fix standard

Having the integration applied must not be able to lock a user out of Codex sign-in. Either the
authentication and sign-in bootstrap stays off the proxy path, or an unavailable proxy produces a
detectable failure and a discoverable recovery. Whichever holds, it is fixed by a regression that
simulates the dead-proxy state.

## Execution constraint specific to this lane

The incident is a configuration change that locked a user out. The lane therefore may not run the
proxy, start or restart the service, or modify any credential or configuration file on the working
machine; doing so would reproduce the damage locally. Verification is static source review plus
exact-head hosted CI.
