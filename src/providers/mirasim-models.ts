export const MIRASIM_MODELS = [
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
  "claude-opus-4-6",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-5",
  "gpt-6-astra",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "kimi-k3",
] as const;

export const MIRASIM_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-fable-5": 1_000_000,
  "claude-fable-5-1": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "gpt-6-astra": 872_000,
  "gpt-5.6-luna": 372_000,
  "gpt-5.6-sol": 372_000,
  "gpt-5.6-terra": 372_000,
  "kimi-k3": 1_048_576,
};

export const MIRASIM_MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "claude-fable-5": 128_000,
  "claude-fable-5-1": 128_000,
  "claude-haiku-4-5": 64_000,
  "claude-opus-4-6": 128_000,
  "claude-opus-4-8": 128_000,
  "claude-opus-5": 128_000,
  "claude-sonnet-5": 128_000,
  "gpt-6-astra": 128_000,
  "gpt-5.6-luna": 128_000,
  "gpt-5.6-sol": 128_000,
  "gpt-5.6-terra": 128_000,
  "kimi-k3": 128_000,
};

export const MIRASIM_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const MIRASIM_MODEL_REASONING_EFFORTS: Record<string, string[]> = Object.fromEntries(
  MIRASIM_MODELS.map(model => [
    model,
    model === "kimi-k3" ? ["low", "high", "max"] : [...MIRASIM_REASONING_EFFORTS],
  ]),
);

export const MIRASIM_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-fable-5": "Claude Fable 5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-haiku-4-5": "Claude 4.5 Haiku",
  "claude-opus-4-6": "Claude 4.6 Opus",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "gpt-6-astra": "GPT 6 Astra",
  "gpt-5.6-luna": "GPT 5.6 Luna",
  "gpt-5.6-sol": "GPT 5.6 Sol",
  "gpt-5.6-terra": "GPT 5.6 Terra",
  "kimi-k3": "Kimi K3",
};

const MIRASIM_LONG_CONTEXT_BASE_MODELS = MIRASIM_MODELS.filter(model =>
  model.startsWith("claude-") && (MIRASIM_MODEL_CONTEXT_WINDOWS[model] ?? 0) >= 1_000_000
);

export const MIRASIM_SELECTABLE_MODELS = [
  ...MIRASIM_MODELS,
  ...MIRASIM_LONG_CONTEXT_BASE_MODELS.map(model => `${model}[1m]`),
];

for (const model of MIRASIM_LONG_CONTEXT_BASE_MODELS) {
  const alias = `${model}[1m]`;
  MIRASIM_MODEL_CONTEXT_WINDOWS[alias] = MIRASIM_MODEL_CONTEXT_WINDOWS[model]!;
  MIRASIM_MODEL_MAX_OUTPUT_TOKENS[alias] = MIRASIM_MODEL_MAX_OUTPUT_TOKENS[model]!;
  MIRASIM_MODEL_DISPLAY_NAMES[alias] = `${MIRASIM_MODEL_DISPLAY_NAMES[model] ?? model} [1m]`;
  MIRASIM_MODEL_REASONING_EFFORTS[alias] = [
    ...(MIRASIM_MODEL_REASONING_EFFORTS[model] ?? MIRASIM_REASONING_EFFORTS),
  ];
}
