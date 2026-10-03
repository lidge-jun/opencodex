export function aggregateJevLevelUsage(...stages: Array<Record<string, number> | undefined>): Record<string, number> | undefined {
  const total = { inputTokens: 0, outputTokens: 0 };
  let reported = false;
  for (const usage of stages) {
    if (!usage) continue;
    for (const [camel, snake] of [["inputTokens", "input_tokens"], ["outputTokens", "output_tokens"]] as const) {
      const value = usage[camel] ?? usage[snake];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue;
      reported = true;
      total[camel] = Math.min(Number.MAX_SAFE_INTEGER, total[camel] + value);
    }
  }
  return reported ? total : undefined;
}
