# Result — MiMo surface audit

| Finding | Outcome | Commit | Proof |
|---|---|---|---|
| B-CAT-02/03/05, B-EXT-06 | V2.6 metadata rows (xiaomi, openrouter, opencode-go text-only), `xiaomi`/`xiaomi-mimo` read the xiaomi bundle and default to V2.6, token-plan roster gains V2.6, Go toggle/sidecar lists and Cline Pass catalog gain V2.6 | `b99edfa9a8` | `tests/providers/mimo-v26-catalog.test.ts` 7 red on `0f9254b564`, green after |
| A-01/A-02 | MiMo Free bootstrap bound to its timeout only; each request aborts its own wait; `buildRequest` passes the request signal | `0b5f615fba` | 3 new cases in `tests/providers/mimo-free-provider.test.ts` red (one hangs) on the old code |
| A-03 | Command Code markup filter covers every `xiaomi/mimo-` model | `3bfd160b43` | V2.5 case in `tests/providers/command-code-tool-text.test.ts` red before |
| B-CAT-01 | `COMMAND_CODE_MIMO_CONTEXT_WINDOWS` on both Command Code presets makes MiMo slugs decode on a cold start without a roster | `3bfd160b43` | cold-start decode case red before (`xiaomi-mimo-v2.6-pro` sent verbatim) |
| C-DOC-01/02/03 | English guide and reference, seven locale guides, `structure/providers-and-adapters.md` | wp4 docs commit | token parity across 8 guides; docs-provider-* suites pass |
| B-CAT-04 | Rejected (historical pricing) | — | — |

Follow-ups: route probes for V2.6 image input on OpenCode Go, Zen free, Cline Pass and Command Code; a Command Code
V2.6 effort ladder probe; migrating saved V2.5 defaults before 2026-10-21 if users ask; a guarded repair for
all-or-nothing registry lists such as `noVisionModels`; routing the Command Code OAuth preset over `/provider/v1`.

What did not improve: nothing here proves live gateway behaviour; every V2.6 capability beyond first-party
metadata stays conservative (sidecar) until probed.
