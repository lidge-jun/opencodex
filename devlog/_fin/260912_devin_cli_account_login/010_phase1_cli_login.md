# 010 — Phase 1: the Devin CLI login entry

**Work-phase:** wp2. **Write set:** `src/oauth/devin-cli.ts` (NEW),
`tests/providers/devin-cli-login.test.ts` (NEW). Nothing else.

Rewritten after audit rounds 1 and 2. Superseded guidance from the first draft:
inherited stdio (audit blocker 3) and an `XDG_CONFIG_HOME` credential path
(wrong, measured in `004`).

## NEW `src/oauth/devin-cli.ts`

```ts
/**
 * Devin CLI account login.
 *
 * The installed CLI owns its own credential. It writes
 * \`$XDG_DATA_HOME/devin/credentials.toml\` — measured, not assumed — and that file
 * holds a real \`windsurf_api_key\`. opencodex deliberately never reads it: the
 * whole point of this provider is that the child authenticates itself, and
 * lifting that key would hand the proxy a Cognition credential it has no reason
 * to hold.
 *
 * What this module produces is an ACCOUNT ROW. The dashboard Accounts tab is
 * built from OAUTH_PROVIDERS, so a provider absent from that map cannot appear
 * there however it is classified. The stored \`access\` is the marker below — a
 * non-secret constant, present because normalizeCredential drops any credential
 * whose \`access\` is not a string. It is never a bearer token: the devin-cli
 * adapter is runTurn-only, ignores provider.apiKey, and sends empty headers.
 */
export const DEVIN_CLI_SESSION_MARKER = "devin-cli-local-session";
```

### `devinCliCredentialsPath(env, platform)`

Measured layout (`004`), not the config dir:

- override `OPENCODEX_DEVIN_CLI_CREDENTIALS` (absolute only)
- Windows `%APPDATA%/devin/credentials.toml`
- otherwise `${XDG_DATA_HOME ?? ~/.local/share}/devin/credentials.toml`

Used for a presence check only; the bytes are never read.

### `readDevinCliSignedInState(deps)`

```ts
export interface DevinCliLoginDeps {
  resolveBinary?: () => string | undefined;
  credentialsPath?: () => string;
  exists?: (path: string) => boolean;
  /** Fire-and-wait. Enough for the `auth status` probe, which takes no input. */
  run?: (bin: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Interactive spawn, required for `auth login`.
   *
   * `run` cannot express that flow and an earlier draft wrongly reused it: the
   * login child must receive a one-time code AFTER it has printed a URL, so the
   * caller needs a live stdin handle and an incremental stdout stream, not a
   * buffered result. The audit caught the draft specifying both kiro's
   * `stdin: "ignore"` and a paste into that same child.
   */
  spawnInteractive?: (bin: string, args: string[]) => DevinCliLoginChild;
}
export interface DevinCliLoginChild {
  /** Called with each chunk of stdout/stderr as it arrives. */
  onOutput(listener: (chunk: string) => void): void;
  /** Writes the pasted code; the implementation appends the newline. */
  writeLine(text: string): void;
  /** Resolves with the exit code. */
  wait(): Promise<number>;
  /** Terminates the child and its group, for the deadline path. */
  kill(): void;
}
export interface DevinCliSignedInState { signedIn: boolean; reason?: "not-installed" | "signed-out" }
```

1. binary missing -> `{ signedIn: false, reason: "not-installed" }`
2. `devin auth status` — confirmed present and non-interactive. **Exit code is
   authoritative**; there is no `--json` (`devin auth status --json` fails with
   `unexpected argument`), so the prose is only a tiebreaker when the exit code
   is ambiguous. Exit 0 -> signed in.
3. non-zero exit but the credential file exists -> signed in, so a future wording
   or exit-code change degrades to the file check instead of locking the user out
4. otherwise `{ signedIn: false, reason: "signed-out" }`

No `identity` field. `004` measured that neither `auth status` nor
`credentials.toml` exposes an account address, so inventing one would be a lie.

### `loginDevinCli(ctrl, opts, deps)`

1. binary missing -> throw with `DEVIN_CLI_INSTALL_HINT` reused verbatim from
   `src/adapters/devin-cli/binary.ts`.
2. signed in and `!opts?.forceLogin` -> return the credential; import-first, no
   browser, the kiro shape.
3. signed out -> `spawnInteractive(bin, ["auth", "login"])` with **all three
   streams piped**: `stdio: ["pipe", "pipe", "pipe"]`.

   Kiro's runner uses `stdin: "ignore"` (`src/oauth/kiro.ts:151-156`) and an
   earlier draft of this document copied it. That is wrong here, and the audit
   caught it: kiro's CLI completes on its own and kiro then imports the token,
   whereas this flow has to hand a one-time code BACK to the child. With stdin
   ignored the child waits for a paste that can never arrive and the login hangs
   until the deadline. Inheriting the proxy's stdio is equally wrong for the
   opposite reason — dashboard login is `POST /api/oauth/login` inside a launchd
   process with no TTY.

   So: piped stdin to write the code, piped stdout **and stderr** to find the
   prompt. Measured shape of that prompt (`004`):
   `Visit https://app.devin.ai/auth/cli/continue?...&cli_pkce_marker=1 to sign in, then copy the code and paste it below.`
   Scrape the URL, hand it to `ctrl.onAuth({ url, instructions })`, take the code
   from `ctrl.onManualCodeInput()`, and write it to stdin followed by a newline.
   The CLI answers `Login successful! Credentials stored.` on success.
4. If no URL appears within the deadline, abort the child and throw a message
   naming the manual path: run `devin auth login` in a terminal, then press Login
   again — the import-first branch will pick it up.

Returns:

```ts
{
  access: DEVIN_CLI_SESSION_MARKER,
  refresh: DEVIN_CLI_SESSION_MARKER,
  expires: Number.MAX_SAFE_INTEGER,
  source: "local-cli",
}
```

No `email`/`accountId` (see `004`). Marker duplicated and a MAX expiry, matching
the `devin` durable-key shape; `refresh: ""` would trip `detectOAuthWarning`.

### `refreshDevinCliToken()`

Throws `invalid_grant: the Devin CLI owns its own session. Run devin auth login again.`

## NEW `tests/providers/devin-cli-login.test.ts`

Registered in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json` under `providers`.

1. binary absent -> login throws, message carries the install hint
2. `auth status` exit 0 -> signed in; credential is marker/marker/MAX, carries no
   email or accountId, and `exists` was never called on the credential file
   contents (presence only)
3. `auth status` non-zero but file present -> still signed in (wording-change guard)
4. `auth status` non-zero and no file -> signed out
5. signed out + login -> `spawnInteractive` receives `["auth","login"]`, the fake
   child emits the measured `Visit <url> ...` line, that URL reaches `onAuth`, and
   the code from `onManualCodeInput` arrives at `writeLine`. Asserts the child is
   never handed the proxy's own streams
8. a login whose stdin is not writable fails loudly rather than hanging — the
   regression guard for the `stdin: "ignore"` mistake this phase already made once
6. login producing no URL before the deadline -> throws naming the terminal fallback
7. `refreshDevinCliToken` rejects with `invalid_grant`

## Acceptance

- No import from `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`.
- `bun test tests/providers/devin-cli-login.test.ts` green.
- `src/adapters/devin-cli/` untouched in this phase.
