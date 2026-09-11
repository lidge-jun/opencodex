# 060 — WP6: presets

The linter moved to `050`, where it is consumed. WP6 is presets and the picker
that offers them — content for a UI that already exists rather than UI ahead of
content. The rule table below stays here as the linter's specification; `050`
implements it.

Ask item 10: "클로드 코드의 프리셋을 제공한다든지, 아니면 Grok Build의 어떤
시스템 프롬프트를 제공한다든지 ... 하지만 codex 호환성이 있게 우리가 좀 조작을
해서".

That last clause is the whole phase. `002` §5 establishes that the source
material cannot be shipped as-is; §6 establishes what breaks if it is.

## Presets are authored, not copied

`002` §5, in short:

- `02_cc_prompt.md` is a 15 KB Korean **analysis document** about Claude Code's
  prompt, not the prompt itself.
- `02_gr_prompt.md` is a 24 KB dossier mixing OSS findings with a
  binary-analysis appendix, carrying unresolved `${{ tools.by_kind.* }}`.
- Grok Build's real templates open with "You are Grok" and rely on render-time
  placeholders only MiniJinja expands.

So each preset is **our text**, distilling behavioral intent into
harness-neutral wording, shipped with a provenance line naming the source and
stating that it is an adaptation. No verbatim third-party prompt enters this
repository — which also keeps the licensing question from ever arising.

## Shipped presets

`gui/src/components/codex-set/presets.ts`, each ≤ 2 KB:

| Preset | Distilled intent | Derived from |
|---|---|---|
| Concise output | short answers, no preamble, minimal formatting | Claude Code's brevity directives |
| Plan before editing | state the plan, then edit | Claude Code's planning posture |
| Explain reasoning | narrate why, not just what | Grok Build's confirmation style |
| Test-first | write the failing test first | common agent practice |
| Korean replies | answer in Korean regardless of prompt language | user-requested staple |

Every preset is a **behavioral instruction**. None names a tool, none claims an
identity, none describes the environment. That is what makes them safe to
append, and it is exactly the constraint the linter enforces.

## Linter specification (implemented in WP5)

`gui/src/components/codex-set/prompt-lint.ts` — pure function, no I/O:

```ts
export type LintLevel = "warn" | "info";
export interface LintFinding {
  level: LintLevel;
  rule: string;
  messageKey: TKey;
  span?: [number, number];
}
export function lintPromptLayer(body: string): LintFinding[];
```

Rules, each traceable to `002` §6:

| Rule | Pattern | Level | Why |
|---|---|---|---|
| `identity` | `you are (claude\|grok\|gemini\|gpt-\|chatgpt)` | warn | contradicts base identity — `02_cc_prompt.md:44` |
| `foreign-tool` | `\b(Read\|Edit\|Write\|Bash\|Glob\|Grep)\s+tool\b` | warn | registry defines tools — `model_info.rs:151` |
| `placeholder` | `\$\{\{.*?\}\}` | warn | no MiniJinja over instructions — `context.rs:252` |
| `apply-patch` | `apply_patch` with redefining verbs | warn | same registry argument |
| `approval-vocab` | `always-approve`, `ask mode`, `acceptEdits` | warn | Codex injects its own — `world_state.rs:114` |
| `environment` | claims about cwd, date, network, OS | warn | generated later — `world_state.rs:149` |
| `size` | body > 8 KB | info | **opencodex policy** — see below |

The size rule cites no upstream limit, because none exists.
`developer_instructions` is a plain config string with no cap
(`config_toml.rs:216`), and `002` §6 records that an earlier draft wrongly cited
the 32 KiB AGENTS.md project-doc budget, which governs an unrelated mechanism.
The 8 KB advisory is ours, justified by per-request token cost and by keeping a
hand-editable config file hand-editable. It is `info`, never `warn`.

**Warnings never block.** A user who means to override identity may; the linter
ensures it is a decision rather than an accident. `002` §6 says the same.

Findings render inline in WP5's editor with the offending span highlighted.

## Preset picker

Fills the submenu WP5 left empty. Each entry shows name, one-line description,
provenance, and a preview. Choosing one opens the WP5 editor **pre-filled and
fully editable** — a preset is a starting point, not a locked artifact.

Presets are linted on selection like any other text. If a preset ever trips its
own linter, that is a bug in the preset, and the test below catches it.

## Tests — `gui/tests/codex-set-presets.test.tsx`

Rule-level linter cases live in WP5 (`050` cases 16-19). This phase tests the
presets and the picker:

1. **every shipped preset lints clean** — the self-consistency check
2. every preset is ≤ 2 KB and names no tool, identity, or environment fact
3. picker lists every preset with its provenance line
4. choosing one opens a pre-filled, editable editor
5. the result is an ordinary custom layer — toggleable, editable, deletable
6. preset text is editable before save
7. the submenu appears only in this phase's build — absent when the preset list
   is empty

Case 1 keeps the phase honest: presets that violate our own compatibility rules
would be worse than shipping none.

## i18n

Preset names, descriptions, and lint messages all go through `codexSet.preset.*`
and `codexSet.lint.*` in all six locales. Preset **bodies** stay English —
they are instructions to a model, not UI copy, and a mistranslated behavioral
directive is a functional defect. The Korean-replies preset is the exception
that proves it: its body is English text instructing Korean output.
