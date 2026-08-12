# WP2 — verification evidence

The criterion in `010` was never "a unit test passes". 91 export tests were
green while the real file was broken. So the close-out is an A/B against the
client's own schema, on the real emitted bytes.

## The decisive check

`@gajae-code/coding-agent@0.7.11` ships its schema as source, so it can be
imported and run against our output directly rather than approximated.

```
ModelsConfigSchema.safeParse({... input: ["text","image","audio"] ...})
→ FAIL {"path":["providers","opencodex","models",0,"input",2],
        "message":"Invalid option: expected one of \"text\"|\"image\""}
```

That is the user's reported error, reproduced from the schema itself
(`models-config-schema.ts:141`, `input: z.array(z.enum(["text","image"]))`).
The bug and the oracle now agree, which is what makes the A/B meaningful.

## A/B on the real emitted file

Both runs: `bun run src/cli/index.ts export --client gajae --out <tmp>`, output
parsed as YAML and handed to the real schema.

| | Models | audio-bearing | Schema |
|---|---|---|---|
| `HEAD~1` (pre-fix) | 34 | `zenmux/meta-muse-spark-1.1` | **FAIL** at `models[31].input[2]` |
| `HEAD` (fixed) | 34 | none | **PASS** |

Two details worth keeping:

- **The model count is unchanged.** `meta-muse-spark-1.1` is still exported, now
  as `[text, image]`. The fix removes a rejected value, not a model — the
  omission branch only fires for a model with nothing acceptable left, and this
  catalog has none.
- The pre-fix index is 31 here versus 30 in the user's report. The catalog moved
  between then and now; the offending entry is the same one.

## Structural check, not grep

Audit round 3 rejected `grep -c audio` as the verification: the string also
occurs in model ids, display names and other providers' preserved blocks, so it
can fail while our output is correct. The check walks
`providers.opencodex.models[*].input` and asserts every value is in
`text|image`. Result: `out-of-enum input values: NONE` across 34 models.

## Gates

| Gate | Result |
|---|---|
| `bun x tsc --noEmit` | clean |
| `bun run test` | **7632 pass, 0 fail**, 7 skip, 507 files |
| `bun run privacy:scan` | passed |
| `tests/client-export-modality-enum.test.ts` | 7 pass |
| existing export/catalog suites | 91 pass |

## The test earns its place

Reverting `config-export.ts` alone makes **5 of 7** new cases fail, including the
whole-catalog assertion. A test that passes with and without the fix would have
been decoration.

## Note on method

A first attempt at this A/B reported "BEFORE FIX → PASS", which was wrong: the
`git stash push` used to revert the file hit a conflict and the fix was never
actually removed, so the "before" run measured the fixed code. Re-done by
extracting `HEAD~1:src/clients/config-export.ts` directly. The worktree was
restored afterwards and matches HEAD; the six pre-existing stashes are intact.

Recording this because the failure mode — a verification that silently measures
the wrong build and reports green — is exactly the class of thing this unit
exists to stop.
