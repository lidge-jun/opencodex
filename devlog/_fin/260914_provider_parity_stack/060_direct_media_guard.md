# Direct implementation: media admission

This fifth layer follows PR #4539. ChatGPT authored the production changes and regression
tests directly in an isolated worktree, rather than handing this implementation to the prior
native authoring session. The outcome closes the silent-success part of F5, not native media
transport: recognized audio/file inputs either stay on an existing native wire or receive an
explicit conversion error. Legacy function-image conversion also refuses instead of losing
its result. The canonical current contract is in
[adapter registry](../../../structure/adapters/registry.md#untranslated-input-media).

The pure scanner inspects typed content arrays only. The registry owns final translated
build/runTurn/local-completion admission, and Chat owns rejection before a lossy projection.
No new fetch, decoding, credential access, provider capability declarations or vendor CLI
permissions are introduced. Desired regression coverage includes unchanged native Responses
and Azure bodies, final hook ordering, typed runTurn error, legacy media failure, and real HTTP
rejection with zero upstream sends. Public Pi documentation records the pending behavior.

The connected Mac runs no product verification by explicit user instruction. Tests are
written for hosted CI; their presence alone is not a passing result. This direct layer does
not reuse another session's PABCD identity or claim unperformed formal phase transitions.
