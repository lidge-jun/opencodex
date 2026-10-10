# wp3 — #4207: connected catalog reports success while the local Codex CLI rejects it

Work-phase 3 of the L4 lane, stacked on wp2. No carried PR: this issue had none.

## The gap

Subagent Bernoulli mapped the client path. `connectClient` downloads at `connect.ts:542` and
writes the hub's bytes verbatim at `:545-549`; `syncConnectedClient` writes the same way at
`:667`. The only validation in between is `validateRemoteCatalog`
(`hub-client.ts:145`), which checks JSON shape — object, `models` array, unique non-empty
slugs — and nothing about reasoning levels. `src/client` never imports the effort clamp.

So the connection state proves the hub is reachable and the credential works, and is then
reported as readiness. The reporter's Codex CLI 0.135.0 exited before its first request on
`unknown variant \`max\``, while `ocx connect status --json` said `connected` with the catalog
present. `ocx status` even reported an active effort clamp for that same older runtime: the
local machinery already knew the ladder, and the client path simply never consulted it.

## Decision

The packet records it: **fail closed — block local readiness rather than reporting success.**
Not a locally clamped projection, which would make the client silently disagree with hub truth.

## Shape

- `catalogEffortCompatibility(models, supported)` in `src/codex/catalog/effort.ts` — pure, no
  mutation, reports the rejected efforts and the models carrying them. It sits beside
  `clampCatalogModelsToObservedCodexSupport`, which mutates; that is correct for a file this
  process owns and wrong for one that must keep matching the hub.
- `src/client/catalog-compatibility.ts` — assesses a downloaded body against the observed local
  ladder and throws `ClientCatalogIncompatibleError` when it cannot be consumed.
- Both hub-download writes are gated **before** the write. Refusing before the write is stronger
  than writing and restoring: there is no window in which an unparseable catalog exists on disk,
  and `writtenCatalogFingerprint` stays null so the existing rollback correctly does nothing.
- The two restore paths (`connect.ts:126`, `:729`) are deliberately **not** gated. Refusing to
  restore a catalog this machine already accepted would strand the client with none at all.

## Decisions I had to make

**An unobservable ladder does not block.** `codexSupportedReasoningEfforts` returns null when
`codex debug models --bundled` cannot be observed. That is not evidence of incompatibility, and a
client machine may legitimately have no Codex CLI. I read the issue's *"preserve the prior
known-good catalog if compatibility cannot be established"* as the incompatible branch — the
alternative to the compatible-projection branch offered in the same sentence — not as the
inconclusive one. Recorded in the PR body too, because the other reading is defensible.

**An invented command was caught before it shipped.** The first draft of the refusal recommended
`ocx codex-runtime`, which does not exist. `AGENTS.md` records this exact failure mode — a
documented `ocx request-history` that never existed — so every command in the message was
checked against the CLI registry. It now names `CODEX_CLI_PATH` and `ocx sync`, with `ocx doctor`
for diagnosis, matching `doctor.ts`'s existing advice.

## Audit

Bohr reviewed the diff adversarially and returned `SAFE_TO_PUSH`: no strict-tsc failure on the
new `src/` lines (checked by hand, since typecheck was NOT RUN), no import cycle into
`src/client` and no module-load side effect, Lab boundary untouched, all four
`atomicWriteFile(DEFAULT_CATALOG_PATH, …)` sites classified, and the gate proven to precede
`commitClientConnection`. One nit folded: a test title claimed write ordering that only the
source-scan test actually asserts, and was renamed.

## Not run

`bun test`, `bun run test`, `bun run test:changed`, `bun run typecheck`, `bun run build:gui`
and `bun install` are NOT RUN by operator instruction. Hosted CI on the exact pushed head is
the only product evidence this round accepts.
