/** "How the latest request was routed": the same facts as the flow, as a numbered plain-language list. */
import type { ReactNode } from "react";
import { useI18n, LOCALES } from "../../i18n/shared";
import { clientLabel } from "../logs-client-label";
import { buildRouteSteps, candidateWho, type RouteFlow, type RouteStep } from "./flow-model";
import { formatDuration } from "./route-format";
import { FailedDetail, ReasonText } from "./ReasonText";
import { withSlots } from "./slots";
import type { RouteRow } from "./route-rows";

export function RouteSteps({ row, flow }: { row: RouteRow; flow: RouteFlow }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const steps = buildRouteSteps(row, flow);

  const text = (step: RouteStep): ReactNode => {
    switch (step.kind) {
      case "asked":
        return withSlots(t(step.combo ? "routeLive.stepAskedCombo" : "routeLive.stepAsked", { client: "{client}", model: "{model}" }), {
          client: clientLabel(flow.client.value, t), model: <code>{step.requested}</code>,
        });
      case "why":
        return withSlots(t("routeLive.stepWhy", { reason: "{reason}" }), { reason: <ReasonText kind="why" code={step.reasonCode} /> });
      case "skipped":
        return withSlots(t("routeLive.stepSkipped", { who: "{who}", reason: "{reason}" }), {
          who: <strong>{candidateWho(step.candidate)}</strong>,
          reason: step.candidate.reasonCode ? <ReasonText kind="skip" code={step.candidate.reasonCode} /> : "",
        });
      case "try": {
        const who = <strong>{candidateWho(step.candidate)}</strong>;
        if (step.ok) {
          return withSlots(t("routeLive.stepTryOk", { who: "{who}", duration: "{duration}" }), {
            who, duration: formatDuration(step.candidate.durationMs ?? row.durationMs, localeTag),
          });
        }
        return withSlots(t(step.moveOn ? "routeLive.stepTryFailedNext" : "routeLive.stepTryFailed", { who: "{who}", result: "{result}" }), {
          who, result: <FailedDetail status={step.candidate.httpStatus ?? row.status} code={step.candidate.reasonCode} />,
        });
      }
      case "none":
        return t("routeLive.stepNone");
    }
  };

  return (
    <ol className="rl-steps">
      {steps.map((step, index) => (
        <li key={index} className={`rl-step rl-step--${step.kind}${step.kind === "try" ? (step.ok ? " rl-step--ok" : " rl-step--bad") : ""}`}>
          {text(step)}
        </li>
      ))}
    </ol>
  );
}
