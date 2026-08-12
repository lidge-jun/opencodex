# 001 — What references devlog, and what breaks on conversion

Research only. Read at `dev` / `a9903875d`. 295 tracked-file references to `devlog`.

| Class | Hits | Meaning |
|---|---:|---|
| PATH ASSUMPTION | 6 | code actually reads/writes/scans the path |
| POLICY TEXT | 19 | rules about what may live in devlog |
| GITIGNORE/GITMODULES mechanics | 5 | the submodule wiring itself |
| DOC PROSE | 265 | comments citing a devlog unit as provenance; no filesystem access |

The 265 prose hits (166 `src/`, 79 `tests/`, 11 `gui/`, 6 `structure/`, 1 `docs-site/`,
2 `bunfig.toml`) are inert. They do not need to change.

## The two findings that actually matter

### 1. `privacy-scan.ts` EXCLUDES devlog — publishing adds no coverage

`scripts/privacy-scan.ts:12` puts `"devlog/"` in `EXCLUDED_PREFIXES`, and `shouldScan()`
rejects any file matching a prefix. This is independent of gitignore.

So after a conversion `git ls-files` would enumerate `devlog/**`, and `shouldScan()`
would still reject every one. Publishing the directory grants **zero** privacy-scan
coverage until that entry is deleted — and deleting it before sanitization turns CI red,
because the scan would then see the personal-data hits catalogued in `002`.

This inverts the intuition that "public means scanned". It is the opposite: the material
would be public and unscanned.

### 2. `tests/repo-hygiene.test.ts` fails immediately

Lines 85-100 assert that devlog is the ONLY gitlink, that no file under `devlog/` is
tracked, and that `.gitmodules` contains the loose-submodule settings:

```ts
expect(gitlinks.map((entry) => entry.path)).toEqual(["devlog"]);
const devlogFiles = trackedFiles().filter((path) => path.startsWith("devlog/"));
expect(devlogFiles).toEqual([]);
...
expect(gitmodules).toContain('[submodule "devlog"]');
```

Every one of those flips on conversion. The suite must be rewritten as a
tracked-devlog policy, not merely deleted — the intent (public CI never needs a private
remote) is still worth asserting in its new form.

## Lower-severity items

- `scripts/openai-provider-option-final-gates.ts` and `-runtime-smoke.ts` reference
  historical devlog units, but both use `find(existsSync) ?? firstCandidate`, so absence
  is tolerated. They do, however, default to WRITING evidence into
  `devlog/_plan/260717_.../evidence/`, which becomes stageable once devlog is tracked.
  Mitigation: pass `--evidence-dir` outside the tracked tree.
- The scoped `git diff --check` in the final-gates script includes
  `devlog/_chase/_model`. Harmless today because a gitlink hides child diffs; after
  conversion it would begin checking real files there.
- `.npmignore:4` excludes `devlog/` from the published package. Keep it: npm consumers
  have no use for planning notes regardless of the git decision.
- No workflow uses `submodules:` with `actions/checkout`, and there is no markdown lint,
  spell check, link check, or `**/*.md` glob in CI. `tsconfig.json` includes only `src`.
  So CI would not newly process 1689 markdown files.

## Scale, and why the raw numbers mislead

`du -sh devlog` reports 178 MB across 9974 files, which looks alarming. It is not the
publication set:

- `_chase/_litellm` (129 MB) and `_chase/_cca` (11 MB) are vendored third-party project
  trees with their own LICENSE files, and devlog's own `.gitignore` already excludes
  both. `git ls-files` reports **0** tracked files for each.
- The real tracked set is **1620 files / 36 MB**, of which 1620 minus 108 are markdown;
  the non-markdown remainder is 62 PNG, 21 SVG, 14 JSON, 4 patch, and a handful of
  text/tsv/ts files.
- The largest tracked items are seven design-concept PNGs in
  `_fin/260710_docs_site_refresh/assets/` totalling about 16 MB.
- Against a public `.git` that is already 711 MB, adding 36 MB is roughly a 5 percent
  increase. Size is NOT a blocker.

The vendored-tree alarm in the first research pass was a false positive caused by
scanning the working tree instead of the index. Anyone re-running this analysis should
scope to `git ls-files` from the start.
