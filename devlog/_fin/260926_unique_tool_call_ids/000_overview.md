# Unique tool-call ids for positionally-minting chat upstreams

Unit opened 2026-09-26.

- [010_remint.md](010_remint.md) — the `openai-chat` lane. **DONE.**

Origin: a DeepSeek V4.1 Flash conversation through this proxy looped with a thinking-only turn that
never terminated, while the same client against the same gateway on a GLM model was unaffected.
The two models differ in the id they mint (positional vs random), which is the whole defect.
