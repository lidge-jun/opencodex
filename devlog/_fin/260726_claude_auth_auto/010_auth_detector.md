# 010 — WP1: Claude auth presence detector (3-value)

Contract from `000`/`001`; audit fold-backs from `002` (blockers 1, 5, 7). This doc
is the implementation contract.

## NEW — `src/claude/auth-detect.ts`

Pure aggregation over injectable IO, so every source is testable without touching the
real home directory, keychain, or environment.

```ts
/**
 * Claude auth presence detection.
 *
 * THREE values, not two. `unknown` means a source could not be READ (denied keychain,
 * permission error, corrupt JSON) — treating that as `absent` is the F1 failure: a
 * subscriber silently flipped into proxy mode. The resolver (WP2) maps unknown to the
 * historical default (subscription), never to proxy.
 */
export type AuthPresence = "present" | "absent" | "unknown";

export type AuthSourceId =
  | "claude-json-oauth"        // S1: ~/.claude.json oauthAccount
  | "claude-credentials-file"  // S2: ~/.claude/.credentials.json
  | "macos-keychain"           // S3: security find-generic-password
  | "exported-env";            // S5: ANTHROPIC_API_KEY / a USER's ANTHROPIC_AUTH_TOKEN

// S4 (opencodex's own anthropic OAuth credential) was REMOVED by the audit: it is a
// provider credential the Claude CLI never consumes, so it is not evidence the
// client can run natively (002 §5).

export interface AuthSourceResult {
  source: AuthSourceId;
  presence: AuthPresence;
  /** One short, credential-free line for the GUI reason badge. */
  detail?: string;
}

export interface AuthDetectDeps {
  /** Parsed <CLAUDE_CONFIG_DIR|~>/.claude.json, undefined when missing, throws on corrupt. */
  readClaudeJson(): Record<string, unknown> | undefined;
  /** true/false for .credentials.json in the same directory, throws on read error. */
  credentialsFileExists(): boolean;
  /** present/absent/unknown for the macOS keychain probe; absent on non-Darwin. */
  keychainProbe(): AuthPresence;
  /**
   * The environment to inspect for S5. The CLI passes the SAME base env the launch
   * will use, so detection and the spawned process can never disagree (002 R2-2):
   *   detectClaudeAuth({ ...defaultAuthDetectDeps(), ...injected, env: () => base })
   * Callers inject with `Omit<Partial<AuthDetectDeps>, "env">` so a test fake cannot
   * replace this binding (002 R3-3).
   */
  env(): NodeJS.ProcessEnv;
}

// NOTE: no `hasOcxAnthropicCredential` — S4 was removed by the audit (002 §5).

export interface AuthDetectResult {
  /** Aggregate: present if ANY source is present; unknown if none present but ANY unknown. */
  presence: AuthPresence;
  /** The source that proved presence, when any — feeds the GUI reason badge. */
  foundBy?: AuthSourceId;
  sources: AuthSourceResult[];
  /** True when env carries OUR OWN dummy marker (ANTHROPIC_AUTH_TOKEN ===
      "opencodex-proxy"). The resolver strips it on an auto→subscription launch;
      it must never count as user auth (002 §1 — the feedback loop). */
  staleProxyMarker: boolean;
}

/** The one owned value. Exported so the CLI, system-env and tests share it. */
export const PROXY_MARKER = "opencodex-proxy";

export function detectClaudeAuth(deps: AuthDetectDeps): AuthDetectResult;
```

Aggregation rule (the safety contract, c-detect):

```ts
const results = collectSources(deps); // each catches its own errors -> "unknown"
const staleProxyMarker = deps.env().ANTHROPIC_AUTH_TOKEN === PROXY_MARKER;
if (results.some(r => r.presence === "present")) {
  return { presence: "present", foundBy: results.find(r => r.presence === "present")!.source, sources: results, staleProxyMarker };
}
if (results.some(r => r.presence === "unknown")) return { presence: "unknown", sources: results, staleProxyMarker };
return { presence: "absent", sources: results, staleProxyMarker };
```

`staleProxyMarker` rides EVERY branch — a result that omitted it on one path would be
the same class of half-applied guard the audit caught (002 R2-2).

Per-source rules:

- S1: file missing → absent. `oauthAccount` object with a non-empty string
  `emailAddress` → present. Corrupt JSON / read error → unknown. The path honours
  `CLAUDE_CONFIG_DIR` (repo convention, `src/oauth/local-token-detect.ts:64-68`) —
  an alternate Claude profile must not read as false-absent. This is best-effort
  evidence on current Claude Code, not a guaranteed contract; the aggregation rule
  (any present wins, unknown never becomes absent) is what keeps that safe.
- S2: under the same `CLAUDE_CONFIG_DIR`-aware directory: missing → absent; exists →
  present; stat/read error → unknown.
- S3: non-Darwin → absent (no keychain). Darwin: `security find-generic-password -s
  "Claude Code-credentials"` with NO `-g`/`-w` (metadata only — those flags display
  secret material): exit 0 → present; exit 44 (item not found) → absent; timeout /
  spawn error / any other exit → unknown. 1.5s timeout.
- S5: `ANTHROPIC_API_KEY` non-empty → present. `ANTHROPIC_AUTH_TOKEN` non-empty →
  present UNLESS the value is exactly `opencodex-proxy`: that is OUR OWN dummy
  marker (injected by buildClaudeEnv and the system-env file), so it is not user
  auth — it sets `staleProxyMarker: true` and counts as absent for this source.

Default IO wiring (same module, exported as `defaultAuthDetectDeps()`): real paths via
`CLAUDE_CONFIG_DIR` ?? `~/.claude`, `spawnSync("security", …)` for S3.

## TESTS — `tests/claude-auth-detect.test.ts` (NEW)

- S1 present/absent/corrupt-JSON → present/absent/unknown;
- S2 missing/exists/stat-error → absent/present/unknown; `CLAUDE_CONFIG_DIR` honoured;
- S3 non-Darwin absent; exit 0 → present; exit 44 → absent; timeout → unknown;
- S5 API key → present; user AUTH_TOKEN → present; `ANTHROPIC_AUTH_TOKEN=opencodex-proxy`
  → absent for the source AND `staleProxyMarker: true`;
- the keychain probe command contains no `-g` or `-w` flag (string assertion);
- aggregate: any present wins over unknowns; unknown beats absent; all-absent → absent;
- **the F1 invariant**: every-unknown → `unknown`, NEVER `absent`;
- `staleProxyMarker` is set on all three aggregate branches;
- the CLI's production call binds `env` to its launch base (default-dependency path
  exercised, not only an injected fake).

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/claude-auth-detect.test.ts` | pass |
| `bun x tsc --noEmit` | clean |
