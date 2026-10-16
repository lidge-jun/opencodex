# Codex GPT-6.1 Sol 500k default context and Muse Wonder (lane L5)

## Sources (captured 2026-10-13 through Aside's signed-in browser)

- Codex: Tibo Sottiaux (OpenAI), 2026-10-11T23:45:59Z, https://x.com/thsottiaux/status/2109430343346581527 —
  "Day 7/ We have increased default context length for GPT-6.1 Sol to 500k when used through Codex & Work,
  up from 272k ... you can still override it higher or lower, and GPT-6.1 Sol's maximum context length is 1M."
  Follow-up https://x.com/thsottiaux/status/2109430894604026039: no long-context fees for GPT-6.1 Sol when usage
  comes from a subscription. The bundled codex-rs catalog (openai/codex main, last change d63a9b8344 2026-10-06)
  still ships gpt-6.1-sol 272000/872000, so the change is server/Work side.
- Muse: AI at Meta, 2026-10-12T17:02:20Z, https://x.com/AIatMeta/status/2109691148943999167; blog
  https://research.meta.ai/blog/muse-wonder; docs https://dev.meta.ai/docs/models and
  https://dev.meta.ai/docs/pricing-rate-limits: model id muse-wonder-1.0 (preview), 1,048,576-token context,
  input text/image/video/audio/PDF, output text, reasoning effort minimal..max, Model API Standard mode only
  (no Contributor variant), $4.00 input / $20.00 output / $0.20 cached input per 1M tokens, no long-context
  premium, 3,000 RPM / 4M TPM. Muse Wonder Full is Muse Code Power/Maximum plans only, not on Model API.

## Work

- wp1 Muse Wonder: add muse-wonder-1.0 to meta-model (key, Model API) and meta-muse (Muse Code credential)
  rosters with 1,048,576 context, text+image modalities, minimal..max efforts, Standard-only; expected-prices
  overlays (verified 2026-10-13); notes/docs; tests. No reseller rows without evidence; Muse Wonder Full not
  added (no API id).
- wp2 Codex: GPT-6.1 Sol default context 500,000 on the native ChatGPT/Codex route only; API-key routes keep
  272k (API pricing tier unchanged). Max context per evidence. Subscription route: no long-context premium in
  spend estimates. Tests and docs-site.

