# 040 — Other non-LLM changes in scope

| Item | Decision |
|---|---|
| `grok-imagine-image-quality` / `-pro` retirement | Covered by 010 |
| `grok-imagine-video-1.5`, `-1.5-lite` | Covered by 020 |
| Grok Voice 3.0 (`reasoning.effort` high/none), Voice 2.0 deprecation, `grok-voice-transcribe-1.0` → 2.0 routing, STT `vad_threshold`/`filler_words`/`smart_turn_timeout`, TTS voices and `optimize_streaming_latency` | Excluded: OpenCodex has no xAI audio surface; `/v1/audio/transcriptions` and realtime are OpenAI-only (`src/server/audio-upstream.ts`) |
| xAI deferred image requests, image/video webhooks, `storage_options`, `output.upload_urls`, SIP | Excluded: the bridges are synchronous; no caller asks for them |
| xAI video edit/extend, `reference_audios`, `generate_audio` | Excluded from this PR: the bridge does not expose them today; `reference_audios` is a candidate follow-up |
| OAuth inference host (`cli-chat-proxy.grok.com` vs `api.x.ai`) for the image relay | Unchanged: live OAuth calls to `api.x.ai/v1/images` and `/v1/videos` succeed and bill the subscription weekly pool; noted as undocumented |
| `scripts/model-metadata.source.json` imagine rows | Excluded: vendored LiteLLM snapshot |
| OpenAI image API (`gpt-image-2.6-*` defaults, SVG/GIF, `gpt-image-2` shutdown 2027-02-10) | No change: the OpenAI `/v1/images` relay forwards the body verbatim (`src/server/images.ts`), so new parameters and models pass through; OpenCodex hard-codes no OpenAI image model |
| OpenAI transcription model (`gpt-4o-transcribe`) | Unchanged: the OpenAI report names no replacement |
| GPT-6.2 Astra/Sol catalog | Out of scope here (LLM catalog; separate lane) |
