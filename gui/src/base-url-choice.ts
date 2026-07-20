/**
 * Resolve a baseUrlChoices selection to the form baseUrl value.
 * Known presets write their fixed URL; custom keeps the previous/custom text.
 */
export function baseUrlForChoice(
  choices: Array<{ id: string; label: string; baseUrl?: string }> | undefined,
  choiceId: string,
  previousBaseUrl: string,
): string {
  const choice = choices?.find(c => c.id === choiceId);
  if (!choice) return previousBaseUrl;
  if (choice.baseUrl) return choice.baseUrl;
  // Switching into custom: clear known preset URLs so the field is empty for paste.
  const known = new Set((choices ?? []).map(c => c.baseUrl?.replace(/\/+$/, "")).filter(Boolean));
  const prev = previousBaseUrl.trim().replace(/\/+$/, "");
  if (known.has(prev)) return "";
  return previousBaseUrl;
}

export function matchChoiceId(
  choices: Array<{ id: string; label: string; baseUrl?: string }> | undefined,
  baseUrl: string,
): string {
  if (!choices?.length) return "custom";
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  for (const choice of choices) {
    if (!choice.baseUrl) continue;
    if (choice.baseUrl.replace(/\/+$/, "") === normalized) return choice.id;
  }
  return choices.some(c => c.id === "custom") ? "custom" : choices[0]!.id;
}
