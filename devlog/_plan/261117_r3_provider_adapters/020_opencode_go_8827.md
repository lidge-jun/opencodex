# wp2 — carry #8827: drop output.encrypted_content for OpenCode Go Responses

Source: PR #8827 by @Ingwannu, head `f5dd31fa73749b4e87f1e5123af2c5a9e6a4a040`, merge base
`da021e37dc`. Since then `dev` changed only `docs-site/.../reference/adapters.md` (en, es) in other
paragraphs; the net diff applies clean.

## Diff

Apply `git diff da021e37dc f5dd31fa73` verbatim:

- MODIFY `src/adapters/openai-responses/passthrough.ts`: extend the include-cleanup condition
  `|| isKimiCodingResponsesHttpsUrl(url) || arkKimi` with `|| isOpenCodeGoResponsesUrl(url)` and a
  two-line comment. `isOpenCodeGoResponsesUrl` is the existing exact final-URL predicate (confirm the
  import exists in the file at B time).
- MODIFY `src/adapters/openai-responses/request-strips.ts`: one doc-comment line.
- MODIFY `tests/providers/opencode-go-grok46-responses.test.ts`: new describe
  "OpenCode Go Responses include compatibility (#8702)" with model, empty, malformed and lookalike-URL cases.
- MODIFY `structure/transports/responses-wire-shapes.md` (in-place sentence), `structure/providers/opengateway.md`,
  `structure/transports/response-citations.md`, `structure/transports/responses-citations.md` (one-line rewording each).
- MODIFY `docs-site/src/content/docs/reference/adapters.md` and `docs-site/src/content/docs/es/reference/adapters.md`: three lines each.

## Verify

- Red: test hunk only → the new describe fails (the PR recorded 44 pass / 4 fail).
- Green: full diff → `bun test tests/providers/opencode-go-grok46-responses.test.ts tests/responses/responses-muse-tool-choice.test.ts` passes.
- `bun test tests/ci-workflows/docs-spanish-localization.test.ts` passes (external-link parity).

Commit: `fix(responses): normalize OpenCode Go output include`, trailer `Co-authored-by: Ingwannu <…>`, body `Closes #8702`.
