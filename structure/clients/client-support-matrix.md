# Client Support Matrix

The public client support page (`docs-site/src/content/docs/reference/client-support.md` and its
copy under each docs locale) is generated, never edited by hand. It is the one place users read which coding tools
opencodex connects to natively, which it exports or manages a config file for, and which inbound
protocol each speaks.

## Sources

`scripts/generate-client-support-matrix.ts` builds the rows from three registries:

- the export roster, `EXPORT_CLIENT_IDS` and `EXPORT_CLIENTS` in `src/clients/`;
- the managed file integrations, `INTEGRATION_CLIENTS` in `src/integrations/registry.ts`, which must
  stay a subset of the export roster (an integration-only id fails generation instead of vanishing);
- the native owners, parsed from the one-line `NativeIntegrationClientId` union in
  `src/server/management/native-integration-routes.ts`. The scripts are outside the typecheck, so the
  parse refuses any other declaration shape and compares the members with the metadata both ways.

## Curated facts and how they stay true

`scripts/client-support-matrix/metadata.ts` carries what the registries do not: labels, protocol
fields, reviewed claims and linked tests. Generation fails when one no longer holds:

- An export client's protocol is read from its own config, built through `buildClientConfigText`
  with a no-secret loopback fixture. Every named field must be present and every value must map to a
  known protocol. OMP's Responses override is checked per model: the native OpenAI fixture model
  carries it and no other model does.
- Rows whose client picks the endpoint (ZCode, Raycast) and native rows are curated. Each keeps a
  source anchor; the client-selected rows also pin the exporter file's sha256, so any edit asks for a
  fresh review.
- `test-covered` links a reviewed test case. The generator checks that the case exists once, names
  the client, and sits in a file without skip/todo/only/conditional modifiers. It does not prove what
  the case asserts, and the page says so.

Locale chrome lives in `scripts/client-support-matrix/locales.ts`; every locale defines every string.

## Runtime results

`scripts/client-support-matrix/runtime-verified.json` is required and starts with an empty `results` array.
Each result is a reviewed human claim: one exact client product and version, run against one opencodex
version, for a stated scenario, on a real calendar date, with an https evidence link.
`scripts/client-support-matrix/runtime.ts` refuses malformed files, unknown rows, impossible dates,
text outside a plain-punctuation allowlist, links that are not https on a named public host or that carry
credentials or table-breaking characters, and exact duplicates. Ties are ordered by code units, not locale. The page shows the most recent result per
client in its own column (ties break on product, versions and scenario) and counts the rest; the support
level stays independent of it. Generation cannot prove that a linked page is public or shows success, and the
privacy scan cannot either, so evidence is reviewed before a result is committed.
`tests/ci-workflows/client-support-runtime.test.ts` covers the empty state, rendering, selection and every
refusal, including through the CLI (`--check --runtime-data <path>`, which never writes pages).

## Changing a client

Adding or removing a client means adding or removing its metadata and running `bun run docs:clients`.
`bun run docs:clients:check` and `tests/ci-workflows/client-support-matrix.test.ts` fail on a stale
page or a broken claim. Two branches that each pass alone can still fail together, so the check is
re-run on the integration base before merge.
