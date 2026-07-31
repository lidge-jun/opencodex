# 010 — Documentation update contract

## `006_jawcode_import_matrix.md`

- One row per candidate, with exact jawcode source, OpenCodex owner, decision, rationale, and implementation gate.
- Required decisions: Cursor version, bounded 429, GPT-5.6 tiers, Antigravity retired model, OpenCode Go Kimi, Anthropic thinking, Google tool-argument/header behavior, Anthropic organization identity, safety/invalid-prompt behavior, LiteLLM metadata, Z.AI weekly limit, Fugu/Sakana, floating model hub semantics.
- A decision is not permission to implement; `IMPORT` and `ADAPT` still carry their required proof.
- Every row must name `local-source`, `chase-only`, or `live-unverified`; the latter two cannot exceed `RESEARCH`.
- Cursor shared ownership and the chosen version value are separate rows. Antigravity picker exposure and inbound alias compatibility are separate rows.

## `007_model_id_delta.md`

- Record all provider namespace differences and semantic aliases.
- List the 17 OpenRouter source-only IDs and all 11 changed `maxTokens` rows.
- Record GPT-5.6 context/cost discrepancies and exact current OCX exposure.
- Show jawcode pre-policy and final policy values separately. Treat costs as a separate non-consumed field.
- Split `kimi-k2.7-code` from `kimi-k2.7-code-highspeed` and classify every OpenRouter source-only ID by its actual OCX exposure path.
- Distinguish model discovery, metadata enrichment, built-in provider ownership, and actual wire support.

## `008_logic_delta.md`

- Explain line-level behavioral differences rather than commit-title summaries.
- Explicitly document why direct ports are rejected or no-ops where OCX architecture already makes the jawcode fix unnecessary.
- Separate general Anthropic requests from the web-search sidecar.
- Separate metadata fields generated from fields consumed.

## Existing docs

- README reading order must include 006–008 and define the expanded decision vocabulary.
- 005 should become an executive backlog: point to the detailed matrix, correct Anthropic and bounded-429 classifications, and make retired Antigravity plus GPT-5.6 contract verification visible.

## Verification

```bash
rg -n "IMPORT|ADAPT|NOOP|REJECT|RESEARCH" devlog/_chase/_model/00{5,6,7,8}*.md
rg -n "gpt-5.6-(luna|sol|terra)|gemini-3.1-pro-high|kimi-k2.7-code|cli-2026" devlog/_chase/_model
find devlog/_chase/_model -maxdepth 1 -type f -name '*.md' -print | sort
python3 - <<'PY'
from pathlib import Path
import re
root = Path('devlog/_chase/_model')
for file in root.glob('*.md'):
    for target in re.findall(r'\[[^]]+\]\(([^)]+)\)', file.read_text()):
        if target.startswith(('#', 'http://', 'https://')):
            continue
        path = (file.parent / target.split('#', 1)[0]).resolve()
        assert path.exists(), f'{file}: missing {target}'
PY
git diff --check
```
