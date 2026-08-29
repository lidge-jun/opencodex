export type QuickUsageRange = "custom" | "today" | "yesterday";

function localDateTimeValue(date: Date, endOfDay: boolean): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}T${endOfDay ? "23:59" : "00:00"}`;
}

export function quickUsageRangeBounds(
  range: Exclude<QuickUsageRange, "custom">,
  now = new Date(),
): { since: string; until: string } {
  const date = new Date(now);
  if (range === "yesterday") date.setDate(date.getDate() - 1);
  return {
    since: localDateTimeValue(date, false),
    until: localDateTimeValue(date, true),
  };
}
