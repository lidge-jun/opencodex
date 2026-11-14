import type { ReactNode } from "react";
import { useT } from "../../i18n/shared";
import { reasonKey, type ReasonKind } from "./route-reasons";
import { withSlots } from "./slots";

/** Plain-language reason for a routing code; a code the registry lacks shows raw, in `<code>`. */
export function ReasonText({ kind, code }: { kind: ReasonKind; code: string }): ReactNode {
  const t = useT();
  const key = reasonKey(kind, code);
  return key ? t(key) : <code>{code}</code>;
}

/** "{status} · {reason}" for a try that failed; the reason part is dropped when no code was recorded. */
export function FailedDetail({ status, code }: { status: number; code?: string }): ReactNode {
  const t = useT();
  if (!code) return <>{status}</>;
  return <>{withSlots(t("routeLive.detailFailed", { status, reason: "{reason}" }), { reason: <ReasonText kind="fail" code={code} /> })}</>;
}
