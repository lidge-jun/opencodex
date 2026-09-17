import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { TransientSendBudget } from "../../src/lib/upstream-retry";

/**
 * The production send-budget owner wired the way the responses stack wires it: the adapter's
 * dispatch view, credential-hop reservations, and the pending hop permit all come from
 * `createResponsesSendBudget`, so a test that needs a prepaid hop exercises the same path a
 * real failover takes instead of reimplementing the view.
 */
export function budgetOwner(sendBudget: TransientSendBudget) {
  const translatorBudget = createTranslatorBudget();
  const result = createResponsesSendBudget({
    req: new Request("http://localhost/v1/responses"),
    logCtx: { model: "test", provider: "test" },
    options: { translatorBudget, sendBudget },
  });
  if (result instanceof Response) {
    translatorBudget.dispose();
    throw new Error("Unexpected workflow refusal without a workflow root");
  }
  return { owner: result, dispose: () => translatorBudget.dispose() };
}
