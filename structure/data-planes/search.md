# Search Data Plane

## Standalone Search and exact account selectors

`POST /v1/alpha/search` retains the selected model in its request body. When that value is an
account-qualified native selector, the server resolves the public namespace, uses only the mapped
stored Codex credential, and sends the bare native model upstream. That exact path is fail-closed:
it does not consult Pool active state or affinity when selecting, and its outcomes cannot rotate
the active Pool account. An account-wide credential failure still quarantines that credential and
clears stale ordinary Pool affinities so they cannot reappear after reauthentication. Quota and
transient outcomes from an exact request leave Pool affinities untouched. Ordinary search requests
keep the normal Direct/Pool sidecar behavior.

Standalone Images and Live requests currently carry neither the account-qualified model selector
nor a trustworthy thread correlation from the Codex client. They therefore retain normal provider
routing. Do not infer an exact account from caller-supplied account headers, process-global last
selection, connection identity, or other ambient state; concurrent threads could cross-route
credentials. Extending exact routing to those endpoints requires an opaque client correlation that
can be bound server-side to a previously validated selector.
