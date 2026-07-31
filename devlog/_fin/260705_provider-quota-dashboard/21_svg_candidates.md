# SVG candidates — Provider quota dashboard

## Baseline assets already present in cli-jaw

Use these directly from `../cli-jaw/public/assets/providers` or copy them into
opencodex when implementation starts:

- `openai.svg` -> `openai`, `openai-apikey`, `chatgpt`
- `grok-color.svg` / `grok.svg` -> `xai`
- `claude-color.svg` / `claude.svg` -> `anthropic`
- `gemini-color.svg` / `gemini.svg` -> `google`, `google-vertex`
- `antigravity-color.svg` / `antigravity.svg` -> `google-antigravity`
- `cursor-color.svg` / `cursor.svg` -> `cursor`
- `kiro-color.svg` / `kiro.svg` -> `kiro`
- `copilot-color.svg` / `copilot.svg` -> `github-copilot`
- `opencode.svg` -> `opencode-go`, `opencode-zen`

## Collected SVG candidates

Downloaded candidates live under:

`devlog/_plan/260705_provider-quota-dashboard/svg-candidates/providers/`

The `manifest.json` in the same folder records the source URL for every file.

### Simple Icons, CC0-1.0

- `openrouter-color.svg`
- `deepseek-color.svg`
- `ollama-color.svg`
- `mistral-color.svg`
- `vllm-color.svg`
- `lm-studio-color.svg`
- `moonshot-color.svg`
- `kimi-color.svg` (Moonshot AI alias)
- `qwen-portal-color.svg`
- `github-copilot-color.svg`
- `gitlab-duo-color.svg` (GitLab proxy brand)
- `cloudflare-ai-gateway-color.svg` (Cloudflare proxy brand)
- `vercel-ai-gateway-color.svg`
- `xiaomi-color.svg`
- `nvidia-color.svg`
- `huggingface-color.svg`
- `qianfan-color.svg` (Baidu proxy brand)
- `alibaba-color.svg` (Alibaba Cloud proxy brand)

### LobeHub icons-static-svg, MIT

- `groq-color.svg`
- `fireworks-color.svg`
- `firepass-color.svg` (Fireworks alias)

## Official sources found but not auto-collected as SVG

- Kimi / Moonshot official public icon is WebP:
  `https://statics.moonshot.cn/moonshot-ai/assets/static/kimi-icon.ByIGCGon.webp`
- Z.ai official direct SVG exists:
  `https://z-cdn.chatglm.cn/z-ai/static/logo.svg`
- MiniMax official brand pack is a ZIP:
  `https://filecdn.minimax.chat/public/MiniMax%20Logo.zip`
- Qwen official public icon found as PNG:
  `https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.2.70/favicon.png`
- OpenCode official brand page exposes PNG previews and advertises SVG downloads:
  `https://opencode.ai/brand`
- GitHub Copilot official brand toolkit exposes current PNG assets and notes the
  old standalone Copilot logo is deprecated:
  `https://brand.github.com/brand-identity/copilot`

## Remaining gaps

- `azure-openai`: Simple Icons no longer exposed an `azure`/`microsoftazure`
  slug during this pass. Use a Microsoft/Azure-approved brand source later or
  fall back to `openai.svg` with an Azure text label.
- No clean SVG candidate was found for `parallel`, `zenmux`, or `nanogpt`.
- `cerebras`, `together`, `venice`, `synthetic`, `kilo`, `neuralwatt`, and
  `umans` still need either official assets or a deliberate generic fallback.

## Sources

- Simple Icons slugs: https://github.com/simple-icons/simple-icons/blob/develop/slugs.md
- Simple Icons README: https://github.com/simple-icons/simple-icons/blob/develop/README.md
- Simple Icons disclaimer/license note: https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md
- LobeHub icons package: https://github.com/lobehub/lobe-icons/blob/master/package.json
- LobeHub static SVG listing: https://app.unpkg.com/%40lobehub/icons-static-svg%401.66.0/files/icons
- SVGL AI directory, used as corroboration only: https://svgl.app/directory/ai
