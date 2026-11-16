# OAuth Credential Siblings

`src/oauth/credential-siblings.ts` names the registry rows that sign in through another provider's
login instead of owning one. Today that is only `kimi-responses`, which signs in through `kimi`: the
registry's `oauthId !== id` rows, restated as a plain constant so the dashboard can import it, and pinned
to the registry by `tests/oauth/oauth-credential-siblings.test.ts`. Other OAuth presets keep their own logins.

The auth store keeps one slot per login, and a sibling row never gets a slot of its own:

- Every account-set API in `src/oauth/store.ts` (credential, account set, selection, pause, alias,
  reauth marks, merge, removal) maps a sibling name to its owner's slot before it reads or writes.
- `resolveAccessSnapshotForAccount` in `src/oauth/index.ts` resolves a sibling under the owner's name,
  so the refresh, its in-process single flight and its refresh-intent lock are the owner's. The returned
  snapshot keeps the sibling's provider label, which is what request-time account admission compares
  against the route. A rotating Kimi refresh token is therefore refreshed once for both rows.
- A sibling is not an OAuth login provider: `/api/oauth/login` refuses `provider: "kimi-responses"`. A
  login through the owner may name the sibling in `row` (`LoginOpts.publishRow`), and the login then
  publishes only that row through `upsertOAuthProvider(config, owner, row)`, leaving the owner's row as
  it is, or absent. Any `row` that does not share the login is refused before the login starts.
- `/api/oauth/status`, `/api/oauth/accounts` and the account `active`, `pause`, `alias` and `DELETE`
  routes answer a sibling name with the owner's slot. Logging out of the owner signs out both rows and
  also clears the sibling's model cache.
- Removing a provider row through the management API goes through
  `src/server/management/provider-credential-release.ts`: the login is released only when no configured
  row that signs in through the same slot remains, so removing `kimi` keeps the login while
  `kimi-responses` still uses it, and removing the last row removes the login. "Signs in" is routing's
  effective auth (`rowUsesOAuthLogin`): a registry OAuth entry counts whatever its stored `authMode`
  says, unless the entry allows a key override and the row selects it. The check runs inside the
  serialized auth-store write (`releaseProviderAccountSetUnlessRetained`) and reads both the live config
  and the persisted config.json, so a row published while the release waited (including a re-created
  row of the removed name) keeps the login. A login written by another process before its row reaches
  config.json can still be released, as for every provider before #8087. Local `ocx provider remove`
  never deletes logins, as for other providers.
- Generic OAuth failover keys account health by the slot (`src/oauth/generic-account-failover.ts`), so
  wherever failover consults account eligibility, the sibling sees a cooldown recorded through the
  owner. Reactive rotation still requires the row's stored `authMode` to be `oauth`, which rows added
  through the dashboard or `upsertOAuthProvider` always carry.
- Quota probes and the Accounts tab stay on the owner (`kimi`); the sibling row has no quota bars of its own.

The dashboard picker lists `kimi-responses` (`dashboardPreset: true`). When the owner is already signed
in, adding it posts the preset row to `/api/providers` with no login; otherwise it logs in through `kimi`
with `row: "kimi-responses"`. A sibling row's status and login buttons resolve through the owner.
`ocx provider add kimi-responses` (local or `--live`) adds the row and points at `ocx login kimi`.
