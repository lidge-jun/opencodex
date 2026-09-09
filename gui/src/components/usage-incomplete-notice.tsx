import { useT } from "../i18n/shared";
import { Notice } from "../ui";
import { readUsageMetadata } from "../usage-summary-resource";

export function UsageIncompleteNotice({ data }: { data: unknown }) {
  const t = useT();
  return readUsageMetadata(data).usageIncomplete
    ? <Notice tone="warn">{t("usage.incomplete")}</Notice>
    : null;
}
