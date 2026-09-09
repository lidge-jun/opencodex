# wp4 — stop shipping locale docs that contradict the code

GitHub Pages publishes every locale. Two of them currently tell operators the opposite
of what the code does, and seven document none of the config surfaces added since
`main`.

## Contradiction (fix first)

`src/providers/registry.ts:1604` seeds ClinePass with
`["low","medium","high","xhigh","max"]`, with a comment recording a 2026-08-13 live
probe across every static model. English says the requested tier is preserved.

- `fr/reference/adapters.md:33` — "limite les autres niveaux demandés au niveau `low`"
- `tr/reference/adapters.md:52` — same claim

French's own `fr/guides/providers.md:268` already agrees with English, so the FR docs
contradict each other as well. Rewrite both bullets to match English.

## Missing surfaces

```
defaultModelAliases  en=1 locales=0
promptCacheKey       en=1 locales=0
oauthAccountFailover en=1 locales=0
auto_review_model    en=1 locales=0
noProxy              en=1 locales=0
```

Across fr/ja/ko/ru/tr/zh-cn/zh-tw. `oauthAccountFailover` is the one that matters most:
it defaults ON with 2+ accounts and can spend a second subscription, and the English
page carries a terms-of-service warning that no locale reader will see.

Also stale: fr/ru/tr/zh-tw `adapters.md` still describe Responses passthrough as
untranslated, after this cycle added system-message folding, `truncation` stripping and
`prompt_cache_breakpoint` removal. And `zh-tw/reference/adapters.md:125` still presents
`unsafeAllowNativeLocalExec` as the live control for a sandbox-bypass feature whose
current opt-in is `nativeLocalExec: "on"`.

## Scope decision

Full translation of every English diff into seven locales is not this loop's work and
would produce machine-translated docs nobody verified. The bar here is: **no locale may
state the opposite of the code.**

Priority order:

1. FR/TR ClinePass contradiction — factually wrong, fix now.
2. ZH-TW native-exec flag — security-relevant control, fix now.
3. fr/ru/tr/zh-tw passthrough "no translation" — now false, fix now.
4. The five missing config surfaces — record as a documented gap with an issue rather
   than bulk-translating in this loop.

## English-side corrections in the same pass

`reference/adapters.md:3` and `reference/architecture.md:18,62` say "seven provider
adapters". `src/adapters/registry.ts:53` registers command-code, openai-chat,
anthropic, openai-responses, google, kiro, azure/azure-openai, cursor and mimo-free.
The count was already wrong on `main`; promotion would carry it forward.

`README.md:24,30,34` render three GIFs that `package.json` `files` does not ship, so
they 404 on the npm listing. Either add them to `files` or stop referencing them.

## Verification

`cd docs-site && bun run build` (currently 401 pages, success) plus a re-run of the
locale scan showing the contradictions gone.
