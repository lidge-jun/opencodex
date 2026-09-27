//! Provider marks for the native menu bar panel.
//!
//! The SVG files are the dashboard's own (`gui/public/provider-icons`), embedded at build time so
//! the panel needs no web view or file access. `ALIASES` and the paint sets mirror
//! `PROVIDER_ICON_ALIASES` and `providerIconPaint` in `gui/src/provider-icons.ts`;
//! `gui/tests/provider-icons-native.test.ts` fails when the two drift apart.

/// One provider's mark and how to paint it: `image` as drawn, `mask` as a template tinted with
/// the label color, `plate` / `dark-plate` on a constant light or dark plate.
pub struct ProviderIcon {
    pub svg: &'static str,
    pub paint: &'static str,
}

macro_rules! svg {
    ($file:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../gui/public/provider-icons/",
            $file
        ))
    };
}

const ALIASES: &[(&str, &str)] = &[
    ("anthropic", "claude-color.svg"),
    ("anthropic-apikey", "claude-color.svg"),
    ("claude-cli", "claude-color.svg"),
    ("azure-openai", "openai.svg"),
    ("chatgpt", "openai.svg"),
    ("cloudflare-ai-gateway", "cloudflare-ai-gateway-color.svg"),
    ("cloudflare-workers-ai", "cloudflare-ai-gateway-color.svg"),
    ("cline", "cline-color.svg"),
    ("cline-pass", "cline-color.svg"),
    ("command-code", "commandcode-color.svg"),
    ("commandcode", "commandcode-color.svg"),
    ("cursor", "cursor-color.svg"),
    ("deepseek", "deepseek-color.svg"),
    ("devin", "devin.svg"),
    ("firepass", "firepass-color.svg"),
    ("fireworks", "fireworks-color.svg"),
    ("github", "github-copilot-color.svg"),
    ("github-copilot", "copilot-color.svg"),
    ("gitlab-duo", "gitlab-duo-color.svg"),
    ("google", "gemini-color.svg"),
    ("google-antigravity", "antigravity-color.svg"),
    ("google-vertex", "gemini-color.svg"),
    ("groq", "groq-color.svg"),
    ("huggingface", "huggingface-color.svg"),
    ("kimi", "kimi-color.svg"),
    ("kimi-code", "kimi-color.svg"),
    ("kimi-responses", "kimi-color.svg"),
    ("kiro", "kiro-color.svg"),
    ("lm-studio", "lm-studio-color.svg"),
    ("meta-model", "meta.svg"),
    ("meta-muse", "meta.svg"),
    ("mistral", "mistral-color.svg"),
    ("minimax", "minimax.svg"),
    ("minimax-cn", "minimax.svg"),
    ("moonshot", "moonshot-color.svg"),
    ("nvidia", "nvidia-color.svg"),
    ("ollama", "ollama-color.svg"),
    ("ollama-cloud", "ollama-color.svg"),
    ("openai", "openai.svg"),
    ("openai-apikey", "openai.svg"),
    ("opencode-free", "opencode.svg"),
    ("opencode-go", "opencode.svg"),
    ("opencode-zen", "opencode.svg"),
    ("openrouter", "openrouter-color.svg"),
    ("opper", "opper.svg"),
    ("qianfan", "qianfan-color.svg"),
    ("qoder", "qoder.svg"),
    ("qoder-cn", "qoder.svg"),
    ("alibaba", "alibaba-color.svg"),
    ("alibaba-token-plan", "alibaba-color.svg"),
    ("alibaba-token-plan-intl", "alibaba-color.svg"),
    ("baseten", "baseten.svg"),
    ("bizrouter", "bizrouter.svg"),
    ("cerebras", "cerebras.svg"),
    ("crusoe", "crusoe.svg"),
    ("deepinfra", "deepinfra.svg"),
    ("digitalocean", "digitalocean.svg"),
    ("featherless", "featherless.svg"),
    ("hyperbolic", "hyperbolic.svg"),
    ("kilo", "kilo.svg"),
    ("nanogpt", "nanogpt.svg"),
    ("nebius", "nebius.svg"),
    ("neuralwatt", "neuralwatt.svg"),
    ("nous", "nous.svg"),
    ("novita", "novita.svg"),
    ("orcarouter", "orcarouter.svg"),
    ("orcarouter-oauth", "orcarouter.svg"),
    ("packycode", "packycode.svg"),
    ("parallel", "parallel.svg"),
    ("sambanova", "sambanova.svg"),
    ("scaleway", "scaleway.svg"),
    ("stepfun", "stepfun-color.svg"),
    ("siliconflow", "siliconflow.svg"),
    ("synthetic", "synthetic.svg"),
    ("together", "together.svg"),
    ("umans", "umans.svg"),
    ("venice", "venice.svg"),
    ("vultr", "vultr.svg"),
    ("litellm", "litellm.svg"),
    ("zenmux", "zenmux.svg"),
    ("zai", "zai.svg"),
    ("zhipu-bigmodel", "zai.svg"),
    ("zhipu-bigmodel-coding", "zai.svg"),
    ("qwen-cloud", "qwen-portal-color.svg"),
    ("vercel-ai-gateway", "vercel-ai-gateway-color.svg"),
    ("vllm", "vllm-color.svg"),
    ("xai", "grok.svg"),
    ("mimo-free", "xiaomi-color.svg"),
    ("mimo", "xiaomi-color.svg"),
    ("xiaomi", "xiaomi-color.svg"),
    ("xiaomi-mimo", "xiaomi-color.svg"),
];

fn paint(file: &str) -> &'static str {
    match file {
        "cerebras.svg"
        | "deepinfra.svg"
        | "grok.svg"
        | "kimi-color.svg"
        | "neuralwatt.svg"
        | "nous.svg"
        | "novita.svg"
        | "ollama-color.svg"
        | "opencode.svg"
        | "opper.svg"
        | "packycode.svg"
        | "siliconflow.svg"
        | "synthetic.svg"
        | "vercel-ai-gateway-color.svg"
        | "zenmux.svg" => "mask",
        "baseten.svg" | "kilo.svg" | "sambanova.svg" | "venice.svg" | "zai.svg" => "plate",
        "bizrouter.svg" | "featherless.svg" | "hyperbolic.svg" | "nebius.svg" | "parallel.svg"
        | "umans.svg" => "dark-plate",
        _ => "image",
    }
}

fn svg(file: &str) -> Option<&'static str> {
    Some(match file {
        "alibaba-color.svg" => svg!("alibaba-color.svg"),
        "antigravity-color.svg" => svg!("antigravity-color.svg"),
        "baseten.svg" => svg!("baseten.svg"),
        "bizrouter.svg" => svg!("bizrouter.svg"),
        "cerebras.svg" => svg!("cerebras.svg"),
        "claude-color.svg" => svg!("claude-color.svg"),
        "cline-color.svg" => svg!("cline-color.svg"),
        "cloudflare-ai-gateway-color.svg" => svg!("cloudflare-ai-gateway-color.svg"),
        "commandcode-color.svg" => svg!("commandcode-color.svg"),
        "copilot-color.svg" => svg!("copilot-color.svg"),
        "crusoe.svg" => svg!("crusoe.svg"),
        "cursor-color.svg" => svg!("cursor-color.svg"),
        "deepinfra.svg" => svg!("deepinfra.svg"),
        "deepseek-color.svg" => svg!("deepseek-color.svg"),
        "devin.svg" => svg!("devin.svg"),
        "digitalocean.svg" => svg!("digitalocean.svg"),
        "featherless.svg" => svg!("featherless.svg"),
        "firepass-color.svg" => svg!("firepass-color.svg"),
        "fireworks-color.svg" => svg!("fireworks-color.svg"),
        "gemini-color.svg" => svg!("gemini-color.svg"),
        "github-copilot-color.svg" => svg!("github-copilot-color.svg"),
        "gitlab-duo-color.svg" => svg!("gitlab-duo-color.svg"),
        "grok.svg" => svg!("grok.svg"),
        "groq-color.svg" => svg!("groq-color.svg"),
        "huggingface-color.svg" => svg!("huggingface-color.svg"),
        "hyperbolic.svg" => svg!("hyperbolic.svg"),
        "kilo.svg" => svg!("kilo.svg"),
        "kimi-color.svg" => svg!("kimi-color.svg"),
        "kiro-color.svg" => svg!("kiro-color.svg"),
        "litellm.svg" => svg!("litellm.svg"),
        "lm-studio-color.svg" => svg!("lm-studio-color.svg"),
        "meta.svg" => svg!("meta.svg"),
        "minimax.svg" => svg!("minimax.svg"),
        "mistral-color.svg" => svg!("mistral-color.svg"),
        "moonshot-color.svg" => svg!("moonshot-color.svg"),
        "nanogpt.svg" => svg!("nanogpt.svg"),
        "nebius.svg" => svg!("nebius.svg"),
        "neuralwatt.svg" => svg!("neuralwatt.svg"),
        "nous.svg" => svg!("nous.svg"),
        "novita.svg" => svg!("novita.svg"),
        "nvidia-color.svg" => svg!("nvidia-color.svg"),
        "ollama-color.svg" => svg!("ollama-color.svg"),
        "openai.svg" => svg!("openai.svg"),
        "opencode.svg" => svg!("opencode.svg"),
        "openrouter-color.svg" => svg!("openrouter-color.svg"),
        "opper.svg" => svg!("opper.svg"),
        "orcarouter.svg" => svg!("orcarouter.svg"),
        "packycode.svg" => svg!("packycode.svg"),
        "parallel.svg" => svg!("parallel.svg"),
        "qianfan-color.svg" => svg!("qianfan-color.svg"),
        "qoder.svg" => svg!("qoder.svg"),
        "qwen-portal-color.svg" => svg!("qwen-portal-color.svg"),
        "sambanova.svg" => svg!("sambanova.svg"),
        "scaleway.svg" => svg!("scaleway.svg"),
        "siliconflow.svg" => svg!("siliconflow.svg"),
        "stepfun-color.svg" => svg!("stepfun-color.svg"),
        "synthetic.svg" => svg!("synthetic.svg"),
        "together.svg" => svg!("together.svg"),
        "umans.svg" => svg!("umans.svg"),
        "venice.svg" => svg!("venice.svg"),
        "vercel-ai-gateway-color.svg" => svg!("vercel-ai-gateway-color.svg"),
        "vllm-color.svg" => svg!("vllm-color.svg"),
        "vultr.svg" => svg!("vultr.svg"),
        "xiaomi-color.svg" => svg!("xiaomi-color.svg"),
        "zai.svg" => svg!("zai.svg"),
        "zenmux.svg" => svg!("zenmux.svg"),
        _ => return None,
    })
}

/// The mark for a provider id, matched case-insensitively like the dashboard.
pub fn icon(provider: &str) -> Option<ProviderIcon> {
    let key = provider.to_ascii_lowercase();
    let (_, file) = ALIASES.iter().find(|(alias, _)| *alias == key)?;
    Some(ProviderIcon {
        svg: svg(file)?,
        paint: paint(file),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_alias_resolves_to_an_embedded_mark() {
        for (alias, _) in ALIASES {
            let icon = icon(alias).unwrap_or_else(|| panic!("{alias} has no embedded file"));
            assert!(icon.svg.contains("<svg"), "{alias} is not SVG markup");
        }
    }

    #[test]
    fn lookup_is_case_insensitive_and_unknown_ids_have_no_mark() {
        assert_eq!(icon("OpenAI").map(|icon| icon.paint), Some("image"));
        assert_eq!(icon("xai").map(|icon| icon.paint), Some("mask"));
        assert_eq!(icon("zai").map(|icon| icon.paint), Some("plate"));
        assert_eq!(icon("nebius").map(|icon| icon.paint), Some("dark-plate"));
        assert!(icon("my-private-endpoint").is_none());
    }
}
