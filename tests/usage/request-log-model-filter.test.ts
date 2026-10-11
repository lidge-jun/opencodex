import { expect, test } from "bun:test";
import { queryRequestLogs } from "../../src/server/request-log-filter";
import { log } from "../helpers/request-log-entry";

test("model filters accept the printed provider/model and the bare ID before pagination", () => {
  const rows = [
    log({ requestId: "anthropic", provider: "anthropic", model: "same-model" }),
    log({ requestId: "other", provider: "other", model: "same-model" }),
    log({ requestId: "slash", provider: "custom", model: "vendor/model" }),
    log({ requestId: "miss", provider: "anthropic", model: "different-model" }),
  ];
  const query = (model: string, extra = "") => queryRequestLogs(rows, new URLSearchParams("model=" + encodeURIComponent(model) + extra));
  expect(query("anthropic/same-model").logs.map(row => row.requestId)).toEqual(["anthropic"]);
  expect(query("same-model").logs.map(row => row.requestId)).toEqual(["anthropic", "other"]);
  expect(query("vendor/model").logs.map(row => row.requestId)).toEqual(["slash"]);
  expect(query("custom/vendor/model").logs.map(row => row.requestId)).toEqual(["slash"]);
  expect(query("missing/same-model").logs).toEqual([]);
  expect(query("Anthropic/same-model").logs).toEqual([]);
  expect(query("anthropic/same-model", "&provider=other").logs).toEqual([]);
  expect(query("same-model", "&limit=1")).toMatchObject({ total: 2, logs: [rows[1]] });
});

test("qualified model failover matching keeps provider and model from the same attempt", () => {
  const row = log({
    requestId: "fallback", provider: "anthropic", model: "initial",
    attempts: [
      { ordinal: 1, provider: "anthropic", model: "initial", adapter: "anthropic", status: 429, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "unreported" },
      { ordinal: 2, provider: "other", model: "served", adapter: "openai", status: 200, durationMs: 7, sendCount: 1, recoveryKinds: [], usageStatus: "reported" },
    ],
  });
  const query = (model: string) => queryRequestLogs([row], new URLSearchParams({ model }));
  expect(query("other/served").logs).toEqual([row]);
  expect(query("served").logs).toEqual([row]);
  expect(query("anthropic/served").logs).toEqual([]);
  expect(query("other/initial").logs).toEqual([]);
});
