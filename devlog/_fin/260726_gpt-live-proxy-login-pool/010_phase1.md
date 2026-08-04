# 010 — Login pool CLI implementation

External write root:
`/Users/jun/Developer/new/700_projects/gpt-live-proxy`.

## MODIFY / NEW map

- NEW `src/account_pool.rs`: strict 1 MiB/256-account metadata, fixed keyring
  namespace, generated credential IDs, versioned secret payload containing token
  and optional raw account id, private path checks, cross-process lock,
  sync+rename writes, and recoverable pending add/remove journal.
- NEW `src/cli.rs`: exact account-name/option grammar; bounded stdin/env secret
  source; `login add/list/current/use/remove`; `serve --account`; 0/1/2 exits;
  stable redacted text/JSON; non-OAuth/private-vs-official help.
- MODIFY `src/main.rs`: synchronous dispatch before Tokio; no args still call
  `Config::from_env`; `serve` loads the selected account first.
- MODIFY `src/lib.rs`: export modules.
- MODIFY `Cargo.toml`, `Cargo.lock`: keyring `=3.6.3` with explicit native
  stores plus vendored sync Secret Service and crypto-rust; filesystem locking,
  random IDs and zeroization; keep MSRV 1.86.
- NEW `tests/account_cli.rs`: process contract and poisoned-pool no-arg tests.
- MODIFY `.github/workflows/ci.yml`: add Windows Rust coverage.
- MODIFY `README.md`; NEW `docs/130_login-pool-cli.md`.
- DELETE: none.

The selected account owns all upstream identity fields as one bundle. Unrelated
bind/admission/CORS/logging/limit environment values still flow through the
existing `Config::from_source` constructor.

## Security and transaction invariants

- Metadata and output contain no bearer, raw account id, token fragment, service
  name override or keyring lookup id.
- Reject symlinks/insecure Unix dirs and all invalid records before keychain I/O.
- After keychain retrieval, separately size-bound/decode/validate the secret
  payload and enforce profile plus `account_id_configured` consistency before
  constructing runtime config.
- A durable `pending` record precedes keychain mutation. Recovery completes or
  aborts that exact operation before any later command, including faults at each
  metadata/keyring boundary. Failures remain recoverable and redact secrets.
- `remove` validates `--yes` before touching storage. Current removal leaves no
  current. First add auto-selects unless `--no-use`.
- Production native-store unavailability fails closed; mock storage is only
  injected through the test seam.

## Tests

- grammar, non-UTF-8 argv, duplicate options, bounded/empty/CRLF stdin and env
- exact lexical text/JSON, exit codes, stdout/stderr ownership and help boundary
- corrupt/versioned/oversized metadata; symlink/insecure path; invalid IDs
- add/remove journal recovery at every injected fault and rollback failure
- concurrent writers and lost-update prevention
- keyring unavailable/locked/ambiguous/missing errors
- raw ChatGPT account-id recovery and actual header insertion after restart
- full upstream env/account precedence cross-product
- remove current/last, empty current, first `--no-use`
- poisoned pool ignored by no-arg startup
- no-arg startup retains the existing ChatGPT env default; only `login add`
  defaults to the official-surface API-key profile
- canary absent from all output, metadata, temp files, errors and git diff

## Verification

All commands must exit 0:

```bash
cargo fmt --all -- --check
cargo test --locked --all-features
cargo clippy --locked --all-targets --all-features -- -D warnings
npm ci --prefix conformance/node --ignore-scripts --no-audit --no-fund
npm test --prefix conformance/node
node scripts/verify-official-fixtures.mjs
node scripts/mutation-check.mjs
cargo +1.86 check --locked --all-targets --all-features
cargo audit
gitleaks git . --no-banner --redact
```

Run isolated native-keychain add/list/current/use/remove/serve smoke where the
host supports it, then scan captured output and config tree for canary bytes.
