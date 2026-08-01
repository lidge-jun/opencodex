# docs-site Translation Audit — 2026-07-14

Audit of Korean (ko/) and Chinese (zh-cn/) localizations against English source.
All 18 English docs are covered by both translations.

## HIGH — Content Omissions

### Korean: architecture.md missing management API section

ko/reference/architecture.md jumps from bridge behavior to transport/compaction,
omitting English lines 108-121 that document management endpoints, OAuth, usage
aggregation, `OPENCODEX_API_AUTH_TOKEN`, and remote-bind authentication.
Security-relevant: remote authentication requirement is undocumented in Korean.

### Chinese: how-it-works.mdx missing account-pool routing

zh-cn/getting-started/how-it-works.mdx lacks the illustration and complete
"Codex auth account selection" section (English lines 25-40). Authentication
step also omits pool-account resolution and refusal behavior (English lines 66-69).

## MEDIUM — Broken Localized Links

Korean:
- architecture.md:123 `#the-subagent-picker` → should be `#서브에이전트-선택기`
- claude-code.md:230, sidecars.md:129 `#sidecars` → `#사이드카`
- providers.md:157 `#cursor-provider-adapter-cursor` → `#cursor-프로바이더-adapter-cursor`
- codex-integration.md:164 `#ocx-service` → `#ocx-service-subcommand` (also broken in English)

Chinese:
- providers.md:145 `#cursor-provider-adapter-cursor` → `#cursor-provideradapter-cursor`
- codex-integration.md:157 `#ocx-service` → `#ocx-service-subcommand` (inherited from English)

## MEDIUM — Korean Quality

- **Register inconsistency**: claude-code.md uses 해요체 (111 endings) while all
  other docs use 합니다체
- **Terminology drift**: `라우팅 제공자` vs established `프로바이더`; `표면`/`surface`/`서피스`
  alternation; `reasoning effort`/`reasoning 강도`/`reasoning 단계`/`추론 강도`
- **Untranslated code comments**: architecture.md module-map code block (~line 14)

## MEDIUM — Chinese Quality

- **Machine-translation punctuation**: 26 ASCII punctuation artifacts in getting-started
  docs (missing fullwidth commas/parentheses)
- **Mistranslation**: how-it-works.mdx:36 translates "lowers it into" as `降级为`
  (implies downgrade) — should be `转换为` or `规范化为`
- **Terminology inconsistency**: `provider`/`提供商`, `adapter`/`适配器`,
  `sidecar`/`边车` alternation across docs
- **Untranslated module-map comments**: architecture.md:14-34 almost entirely English

## LOW — Style

- Korean AI-translation tells in 11 places: `수행함으로써`, `어댑터를 통해`,
  `합친 것입니다`, `수단은 ... 것입니다`
- Source-parity drift: ko/zh quickstarts include GPT-5.6 three-command example
  absent from English source
