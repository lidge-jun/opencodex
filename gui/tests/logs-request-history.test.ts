import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requestHistoryUrl, type RequestHistoryFilters } from "../src/pages/logs-request-history";

const emptyFilters: RequestHistoryFilters = {
  provider: "",
  model: "",
  requestedModel: "",
  status: "",
  inboundProtocol: "",
  apiKeyId: "",
  profileId: "",
  fallback: "",
};

test("request history URL uses server filters and an opaque encoded cursor", () => {
  const url = new URL(requestHistoryUrl("http://127.0.0.1:11435", {
    ...emptyFilters,
    provider: "open ai",
    requestedModel: "policy/fast",
    status: "429",
    fallback: "true",
  }, "cursor + / ="));

  expect(url.pathname).toBe("/api/request-history");
  expect(url.searchParams.get("limit")).toBe("200");
  expect(url.searchParams.get("provider")).toBe("open ai");
  expect(url.searchParams.get("requestedModel")).toBe("policy/fast");
  expect(url.searchParams.get("status")).toBe("429");
  expect(url.searchParams.get("fallback")).toBe("true");
  expect(url.searchParams.get("cursor")).toBe("cursor + / =");
  expect(url.searchParams.has("model")).toBe(false);
});

test("Logs reads route evidence from the per-request explanation endpoint", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "pages", "Logs.tsx"), "utf8");
  expect(source).toContain("/api/request-history/${encodeURIComponent(detail.requestId)}/route-decision");
  expect(source).toContain('logs.detail.route.loadError');
});
