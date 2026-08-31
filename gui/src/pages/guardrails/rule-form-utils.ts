export function parseGuardrailsCaptureGroups(value: string): number[] | null {
  if (value.trim() === "") return [];
  const tokens = value.split(",").map(token => token.trim());
  const groups = tokens.map(token => Number(token));
  return tokens.some((token, index) => token === "" || !Number.isInteger(groups[index]) || groups[index]! <= 0)
    ? null
    : groups;
}
