# Open questions — Provider quota dashboard

## Needs implementation-time verification

- Does each jawcode quota provider still match opencodex's current OAuth
  credential source and provider id?
- Which `../cli-jaw` SVG/logo assets are safe to copy into opencodex, and under
  what license/attribution?
- Should provider custom windows use `customWindows` in the shared component, or
  should adapters map everything into `5h` / `weekly` / `monthly` when possible?
- Should failed reverse-engineered quota sources be visible only in debug/API
  output, or also in a collapsed diagnostics panel later?
- Should ChatGPT forward quota render under both `openai` and `chatgpt` provider
  cards when both are configured, or only under the default/active one?

## Carried assumptions

- User prefers hidden inactive quota over visible unsupported status rows.
- Provider quota belongs on the Providers page under each card, not on the Usage
  page.
- The first useful slice should prioritize visible quota for already logged-in
  xAI and Anthropic, then expand to Kiro and other reverse/local sources.
