import { expect, test } from "bun:test";
import { refreshQuotasAfterProviderAddition } from "../src/provider-addition";

test("newly activated ZCode providers skip quota reads entirely", () => {
  const calls: boolean[] = [];
  const refresh = (force: boolean) => calls.push(force);

  refreshQuotasAfterProviderAddition({ adapter: "zcode" }, refresh);
  expect(calls).toEqual([]);

  refreshQuotasAfterProviderAddition(undefined, refresh);
  refreshQuotasAfterProviderAddition({ adapter: "openai-chat" }, refresh);
  expect(calls).toEqual([true, true]);
});
