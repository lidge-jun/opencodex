export const KIRO_MODELS = [
  "kiro-auto",
  // OpenAI GPT-5.6 (Kiro experimental, us-east-1) — added to official catalog 2026-07-13
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  // 260923 preemptive: GPT-6 Sol and Luna (OpenAI announced 2026-09-22) added ahead of this provider's own catalog; mirrors the GPT-5.6 Sol/Luna rows. Calls fail upstream until Kiro ships the models.
  "gpt-6-sol",
  "gpt-6-luna",
  "claude-sonnet-5",
  // 260923 preemptive: Claude Opus 5.5 added ahead of Kiro's catalog (kiro.dev did not list it on
  // 2026-09-23). Mirrors claude-opus-5; calls fail upstream until Kiro ships the model.
  "claude-opus-5.5",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4.0",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "minimax-m2.5",
  "minimax-m2.1",
  "glm-5",
  "qwen3-coder-next",
];

// Per-model context windows as documented on Kiro's official model catalog
// (https://kiro.dev/docs/models/ — "Quick comparison", page updated 2026-07-14).
// "Auto" is a router with no fixed window on Kiro's table, so it is intentionally omitted.
export const KIRO_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.6-sol": 272_000,
  "gpt-5.6-terra": 272_000,
  "gpt-5.6-luna": 272_000,
  "gpt-6-sol": 272_000,
  "gpt-6-luna": 272_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-5.5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4.8": 1_000_000,
  "claude-opus-4.7": 1_000_000,
  "claude-opus-4.6": 1_000_000,
  "claude-opus-4.5": 200_000,
  "claude-sonnet-4.6": 1_000_000,
  "claude-sonnet-4.5": 200_000,
  "claude-sonnet-4.0": 200_000,
  "claude-haiku-4.5": 200_000,
  "deepseek-3.2": 128_000,
  "minimax-m2.5": 200_000,
  "minimax-m2.1": 200_000,
  "glm-5": 200_000,
  "qwen3-coder-next": 256_000,
};

const KIRO_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// The GPT-5.6 family (sol/terra/luna) and claude-opus-5 send these values through Kiro's verified
// native effort fields (`reasoning.effort` for the GPT-5.6 models, `output_config.effort` for
// claude-opus-5). Other models map them to bounded thinking instructions until their native
// effort support is verified.
export const KIRO_MODEL_REASONING_EFFORTS: Record<string, string[]> = Object.fromEntries(
  KIRO_MODELS.map(id => [id, KIRO_REASONING_EFFORTS]),
);

export function normalizeKiroModelId(id: string): string {
  let model = id.trim().toLowerCase();
  model = model.replace(/^kiro\//, "").replace(/^kiro-/, "");
  if (model === "auto") return "auto";

  model = model.replace(/-\d{8}$/, "");
  model = model.replace(/-(low|medium|high|xhigh|max)$/, "");
  model = model.replace(/(\d+)-(\d+)/g, "$1.$2");
  model = model.replace(/^claude-([\d.]+)-(sonnet|opus|haiku)$/, "claude-$2-$1");
  return model;
}
