import { afterEach, expect, test } from "bun:test";
import { fetchArtificialAnalysisTable, loadCapabilityTable, MAX_TABLE_BYTES, MAX_TABLE_PAGES } from "../../src/codex/role-capability";
import type { OcxConfig } from "../../src/types";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });

const freeList = "https://artificialanalysis.ai/api/v2/language/models/free";
const legacyList = "https://artificialanalysis.ai/api/v2/data/llms/models";
const pageUrl = (page: number) => `${freeList}?page=${page}`;
const row = (name: string, score: number, pad = "") => ({ name, slug: name, pad, evaluations: { artificial_analysis_intelligence_index: score, artificial_analysis_coding_index: null } });
const page = (page: number, hasMore: boolean, data: unknown[]) => Response.json({ tier: "free", pagination: { page, page_size: 200, total_pages: hasMore ? page + 1 : page, has_more: hasMore }, data });

function transport(answer: (url: URL) => Response) {
  const requests: string[] = [];
  const keys: (string | null)[] = [];
  const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(input));
    keys.push(new Headers(init?.headers).get("x-api-key"));
    return answer(new URL(String(input)));
  }, { preconnect: nativeFetch.preconnect }) as typeof fetch;
  return { requests, keys, fetchImpl };
}

test("reads every page of the free model list and stops when has_more is false", async () => {
  const { requests, keys, fetchImpl } = transport(url => url.searchParams.get("page") === "1"
    ? page(1, true, [row("model-a", 70)])
    : page(2, false, [row("model-b", 60)]));
  const table = await fetchArtificialAnalysisTable("aa-pages-fixture", fetchImpl);
  expect(requests).toEqual([pageUrl(1), pageUrl(2)]);
  expect(keys).toEqual(["aa-pages-fixture", "aa-pages-fixture"]);
  expect(table.domains.coding?.get("model-a")).toBe(70);
  expect(table.domains.coding?.get("model-b")).toBe(60);
  expect(table.domains.general?.get("model-b")).toBe(60);
});

test.each([
  ["missing", {}],
  ["a string", { pagination: { page: 1, has_more: "true" } }],
  ["null", { pagination: { page: 1, has_more: null } }],
])("a page whose pagination.has_more is %s fails the read instead of ending the list", async (_label, pagination) => {
  const { requests, fetchImpl } = transport(() => Response.json({ tier: "free", ...pagination, data: [row("model-a", 70)] }));
  await expect(fetchArtificialAnalysisTable("aa-no-pagination-fixture", fetchImpl)).rejects.toThrow("pagination.has_more");
  expect(requests).toEqual([pageUrl(1)]);
});

test("a list that never ends stops at the page cap and falls back to price", async () => {
  const { requests, fetchImpl } = transport(url => page(Number(url.searchParams.get("page")), true, [row("endless", 50)]));
  await expect(fetchArtificialAnalysisTable("aa-cap-fixture", fetchImpl)).rejects.toThrow(`more than ${MAX_TABLE_PAGES} pages`);
  expect(requests).toEqual(Array.from({ length: MAX_TABLE_PAGES }, (_, index) => pageUrl(index + 1)));
  globalThis.fetch = fetchImpl;
  const result = await loadCapabilityTable({ codexRoleCapability: { artificialAnalysis: { apiKey: "aa-cap-load-fixture" } } } as OcxConfig);
  expect(result).toMatchObject({ source: null, domains: {}, fallbackReason: "Artificial Analysis could not be read" });
});

test("the byte bound covers all pages together", async () => {
  const half = "x".repeat(Math.ceil(MAX_TABLE_BYTES / 2));
  const { requests, fetchImpl } = transport(url => url.searchParams.get("page") === "1"
    ? page(1, true, [row("first-half", 70, half)])
    : page(2, false, [row("second-half", 60, half)]));
  await expect(fetchArtificialAnalysisTable("aa-bytes-fixture", fetchImpl)).rejects.toThrow("byte bound");
  expect(requests).toEqual([pageUrl(1), pageUrl(2)]);
});

test("measured tiers survive the legacy list answering 410 Gone", async () => {
  const { requests, fetchImpl } = transport(url => url.href.startsWith(legacyList)
    ? new Response(JSON.stringify({ error: "Gone" }), { status: 410 })
    : page(1, false, [row("model-a", 70), row("model-b", 60)]));
  globalThis.fetch = fetchImpl;
  const table = await loadCapabilityTable({ codexRoleCapability: { artificialAnalysis: { apiKey: "aa-gone-fixture" } } } as OcxConfig);
  expect(requests).toEqual([pageUrl(1)]);
  expect(table.source?.name).toBe("Artificial Analysis");
  expect(table.fallbackReason).toBeUndefined();
  expect(table.domains.coding?.get("model-a")).toBe(70);
});
