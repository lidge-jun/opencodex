# 020 Intercept on demand (wp2)

## Behaviour

- A serialized, idempotent `ensureClaudeIntercept()` starts the intercept pair (CONNECT proxy, TLS listener, CLI catalog hook,
  Desktop picker runtime/controller when wired) in the running process using the persisted config, reusing the options the
  lifecycle got at `startServer` (dispatch, ports, picker routes). A second call while one is in flight awaits the same start;
  a call when already bound returns the bound state.
- Result is a discriminated outcome: `{ok:true,state}` or `{ok:false, reason}` with reason
  `disabled` (Claude routing off or `claudeCode.intercept.enabled=false`), `client_role`, `ephemeral_port`,
  `port_in_use` (with the port), `failed` (message without secrets). No reason means "restart".
- Callers: the `cliFirstParty` toggle and every Desktop first-party/picker apply route call it before refusing; turning Claude
  routing on (`PUT /api/native-integrations/claude {enabled:true}`) calls it; a new `POST /api/claude-intercept/start`
  (dashboard session) lets the GUI retry explicitly. Status payloads gain `interceptReason` so the GUI can say why.
- Turning routing off does not tear the pair down (existing relay-native behaviour stays).
- The startup path keeps its synchronous contract (AGENTS.md: no await between `Bun.serve` and lab activation); the lifecycle
  only records its options and a starter, it does not change the startup order.

## GUI

- Replace every "restart OpenCodex" instruction for the intercept (ko/en/... `claudeDesktop.firstParty.proxyStopped`,
  `claude.firstParty.disabled`, `claude.firstParty.refusal.interceptUnavailable`) with the concrete reason plus a
  "Start" action that calls the new endpoint, and a port hint for `port_in_use`
  (`claudeCode.intercept.port`). All locales updated.

## Tests

Lifecycle: ensure starts when startup returned null, is idempotent and serialized, maps EADDRINUSE to `port_in_use`.
Route: `cliFirstParty:true` with no bound intercept starts it and succeeds; disabled routing returns `disabled`.
Desktop status reports `interceptReason`. File-size: keep agent-settings-routes.ts under 2000 lines (move to a sibling).

