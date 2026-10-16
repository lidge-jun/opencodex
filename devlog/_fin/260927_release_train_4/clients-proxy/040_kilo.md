# Phase 4: Kilo managed config (#5272)

`030_qoder.md` remains held; this phase reconciles the shared export-client
union and GUI roster against current `dev`. The PR's 57-file slice includes a JSONC
writer extension; preserve unrelated parsed client state during apply and disable,
and restore original comment-bearing bytes from the snapshot on undo.

## Exact change map

- NEW `src/clients/config-export/kilo.ts`: generate the documented Kilo
  provider block and resolve the active global config path. Before, no Kilo
  export exists. After, a config is selected only when later legacy files
  cannot override its managed `provider.opencodex` block. If two candidate
  files can supply that block, status and apply refuse with a clear conflict;
  no first-file-wins write that appears successful but is ineffective.
- MODIFY `src/clients/config-export.ts`, `contracts.ts`,
  `src/integrations/registry.ts`, `target.ts`, `state.ts`, `writer.ts`,
  `mutation-plan.ts`, `config-io.ts`, and `src/lib/jsonc.ts` only as required
  for JSONC parsing and the common ownership contract. The parser must reject
  non-roundtrippable syntax before mutation; the snapshot keeps original
  comment-bearing bytes recoverable for undo.
- MODIFY the CLI export/help/registry entries, GUI integration registry and
  affected locale keys, public integration documentation, and
  `structure/clients/integrations.md` for the actual Kilo path.
- NEW/MODIFY `tests/clients/kilo-client.test.ts` and adjacent config/GUI
  tests: add a two-file precedence conflict fixture with distinct provider
  values, byte-exact restore of an initial comment-bearing file, unsafe path
  refusal, and Windows-shaped home/path resolution. Register test files in
  both test-layout manifests.

## Acceptance and proof

Activation: explicit apply to an unambiguous Kilo install writes only owned
fields; disabling preserves unrelated parsed values; restoring returns the original bytes.
Conflict activation: a later candidate file contains the same provider key;
status and mutation both refuse before snapshot/write. Run
`bun test tests/clients/kilo-client.test.ts
tests/config/client-config-export.test.ts`, the relevant `gui/tests`,
`bun run test:changed`, `bun run typecheck`, `bun run lint:gui`,
`bun run build:gui`, `bun run structure:check`, `bun run privacy:scan`,
and `bun run skill:surface:check` if capabilities change. Check screenshot,
merged file-size cap, union/locale counts, explicit credential/path security
review, exact-head CI, and post-merge `dev`.
