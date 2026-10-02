import { expect, spyOn, test } from "bun:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
  BOOTSTRAP_MAX_DECODED_BYTES, injectPickerModels, isPickerBootstrapRequest,
  narrowBootstrapAcceptEncoding, rewriteBootstrapBody, rewrittenHeaders,
} from "../../src/claude/intercept/picker-bootstrap";

const models = [{ id: "ocx-model", name: "Routed", contextWindow: 128_000 }];
function fixture() {
  return {
    model_selector_config: [
      { id: "cowork", models: [{ id: "cowork-original" }] },
      { id: "code", models: [{ id: "claude-native", name: "Native", section: "main",
        thinking: { enabled: true }, capabilities: ["image"], fast_mode: true,
        min_version: "1", clientVersionGate: "2", badge: "old", tooltip: "old",
        description: "old", context_window: 100 }] },
    ],
    model_selector_state: { current: "claude-native" },
  };
}

test("request matcher accepts only GET bootstrap paths", () => {
  for (const prefix of ["edge-api", "api"]) {
    expect(isPickerBootstrapRequest("GET", `/${prefix}/bootstrap`)).toBe(true);
    expect(isPickerBootstrapRequest("GET", `/${prefix}/bootstrap/org-123/app_start/`)).toBe(true);
    expect(isPickerBootstrapRequest("POST", `/${prefix}/bootstrap`)).toBe(false);
    expect(isPickerBootstrapRequest("HEAD", `/${prefix}/bootstrap`)).toBe(false);
    expect(isPickerBootstrapRequest("GET", `/${prefix}/bootstrap/other`)).toBe(false);
  }
  expect(narrowBootstrapAcceptEncoding()).toBe("gzip, deflate, br");
});

test("injection clones an eligible native row only into Code", () => {
  const body = fixture();
  const before = structuredClone(body);
  expect(injectPickerModels(body, [...models, models[0]!])).toBe(1);
  const code = body.model_selector_config[1]!.models;
  expect(code).toHaveLength(2);
  const inserted = code[1] as unknown as Record<string, unknown>;
  expect(inserted.id).toBe("ocx-model");
  expect(inserted.name).toBe("Routed");
  expect(inserted.context_window).toBe(128_000);
  expect(inserted.thinking).toEqual({ enabled: true });
  expect(inserted.capabilities).toEqual(["image"]);
  for (const key of ["fast_mode", "min_version", "clientVersionGate", "badge", "tooltip", "description"]) {
    expect(inserted).not.toHaveProperty(key);
  }
  expect(body.model_selector_config[0]).toEqual(before.model_selector_config[0]);
  expect(body.model_selector_state).toEqual(before.model_selector_state);
  expect(injectPickerModels(body, models)).toBe(0);
});

test("disabled or deprecated native rows cannot serve as templates", () => {
  for (const property of [{ disabled: true }, { disabled_reason: "blocked" }, { section: "deprecated" }]) {
    const body = fixture();
    Object.assign(body.model_selector_config[1]!.models[0]!, property);
    expect(injectPickerModels(body, models)).toBe(0);
  }
});

test("supported encodings become identity encoded JSON", () => {
  const plain = Buffer.from(JSON.stringify(fixture()));
  for (const [encoding, encoded] of [
    [undefined, plain], ["identity", plain], ["gzip", gzipSync(plain)],
    ["x-gzip", gzipSync(plain)], ["deflate", deflateSync(plain)], ["br", brotliCompressSync(plain)],
  ] as const) {
    const output = rewriteBootstrapBody(encoded, encoding, models);
    expect(output).not.toBeNull();
    expect(JSON.parse(output!.toString()).model_selector_config[1].models[1].id).toBe("ocx-model");
  }
});

test("invalid, oversized and inapplicable bodies stay untouched", () => {
  const plain = Buffer.from(JSON.stringify(fixture()));
  expect(rewriteBootstrapBody(Buffer.from("not-json"), undefined, models)).toBeNull();
  expect(rewriteBootstrapBody(plain, "zstd", models)).toBeNull();
  expect(rewriteBootstrapBody(Buffer.from("{}"), undefined, models)).toBeNull();
  expect(rewriteBootstrapBody(Buffer.from(" ".repeat(BOOTSTRAP_MAX_DECODED_BYTES + 1)), undefined, models)).toBeNull();
  const hugeCompressed = gzipSync(Buffer.from(" ".repeat(BOOTSTRAP_MAX_DECODED_BYTES + 1)));
  expect(rewriteBootstrapBody(hugeCompressed, "gzip", models)).toBeNull();
});

test("rewritten headers remove stale encoding, length, validators and transfer metadata", () => {
  expect(rewrittenHeaders([
    "Content-Type", "application/json", "Content-Encoding", "gzip", "Content-Length", "19",
    "ETag", "x", "Digest", "x", "Content-MD5", "x", "Transfer-Encoding", "chunked",
    "Set-Cookie", "a=1", "Set-Cookie", "b=2",
  ], 7)).toEqual(["Content-Type", "application/json", "Set-Cookie", "a=1", "Set-Cookie", "b=2", "Content-Length", "7"]);
});

test("the injection outcome names why a bootstrap stayed unchanged, never its values", () => {
  const outcomes: string[] = [];
  const explain = (outcome: { kind: string; reason?: string; added?: number }) => {
    outcomes.push(outcome.kind === "rewritten" ? `rewritten:${outcome.added}` : `unchanged:${outcome.reason}`);
  };
  expect(injectPickerModels({}, models, explain)).toBe(0);
  expect(injectPickerModels({ model_selector_config: [{ id: "cowork", models: [] }, { id: "chat", models: [] }] }, models, explain)).toBe(0);
  expect(injectPickerModels({ model_selector_config: [{ id: "code", models: [{ id: "not-claude" }] }] }, models, explain)).toBe(0);
  expect(injectPickerModels(fixture(), [], explain)).toBe(0);
  expect(injectPickerModels(fixture(), models, explain)).toBe(1);
  expect(rewriteBootstrapBody(Buffer.from("{"), undefined, models, explain)).toBeNull();
  expect(outcomes).toEqual([
    "unchanged:no_model_selector_config",
    "unchanged:no_code_surface(cowork,chat)",
    "unchanged:code:no_template(models=1)",
    "unchanged:no_routes",
    "rewritten:1",
    "unchanged:decode_or_parse_failed",
  ]);
});

test("the Desktop Code surfaces ccd and code both gain the routes; remote ccr and cowork stay untouched", () => {
  const native = { id: "claude-native", name: "Native", section: "main" };
  const body = {
    model_selector_config: [
      { id: "ccd", models: [{ ...native }] },
      { id: "code", models: [{ ...native }] },
      { id: "ccr", models: [{ ...native }] },
      { id: "cowork", models: [{ ...native }] },
    ],
  };
  expect(injectPickerModels(body, models)).toBe(2);
  const ids = (surface: number) => body.model_selector_config[surface]!.models.map(row => row.id);
  expect(ids(0)).toEqual(["claude-native", "ocx-model"]);
  expect(ids(1)).toEqual(["claude-native", "ocx-model"]);
  expect(ids(2)).toEqual(["claude-native"]);
  expect(ids(3)).toEqual(["claude-native"]);
  // Desktop falls back to "code" when "ccd" is absent.
  const fallback = { model_selector_config: [{ id: "code", models: [{ ...native }] }, { id: "ccr", models: [{ ...native }] }] };
  expect(injectPickerModels(fallback, models)).toBe(1);
  expect(fallback.model_selector_config[1]!.models).toHaveLength(1);
});

test("unknown surface ids from the body are counted in the outcome, never echoed", () => {
  const outcomes: string[] = [];
  const secretish = "body-derived-surface-text-7f3a";
  injectPickerModels({ model_selector_config: [{ id: "cowork", models: [] }, { id: secretish, models: [] }, { id: 7, models: [] }] }, models,
    outcome => { outcomes.push(outcome.kind === "unchanged" ? outcome.reason : "rewritten"); });
  expect(outcomes).toEqual(["no_code_surface(cowork,other:2)"]);
  expect(outcomes.join("")).not.toContain(secretish);
});


test("oversized retained fields are refused before cloning any picker rows", () => {
  const body = { model_selector_config: [{ id: "code", models: [{
    id: "claude-native", metadata: { retained: "x".repeat(1024 * 1024) },
  }] }] };
  const aliases = Array.from({ length: 32 }, (_, i) => ({ id: `ocx-${i}`, name: `Route ${i}` }));
  const clone = spyOn(globalThis, "structuredClone");
  try {
    expect(injectPickerModels(body, aliases)).toBe(0);
    expect(clone).not.toHaveBeenCalled();
    expect(body.model_selector_config[0]!.models).toHaveLength(1);
  } finally { clone.mockRestore(); }
});

test("a wide retained row is refused even when its individual fields are small", () => {
  const native = { id: "claude-native", ...Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`field${i}`, "x".repeat(32 * 1024)]),
  ) };
  const body = { model_selector_config: [{ id: "code", models: [native] }] };
  expect(injectPickerModels(body, models)).toBe(0);
  expect(body.model_selector_config[0]!.models).toEqual([native]);
});

test("all target surfaces share one expansion budget and refusal is atomic", () => {
  const aliases = Array.from({ length: 32 }, (_, i) => ({ id: `ocx-${i}`, name: `Route ${i}` }));
  for (const ids of [["ccd", "code"], ["code", "code"]]) {
    const body = { model_selector_config: ids.map(id => ({ id, models: [{
      id: "claude-native", metadata: { retained: "x".repeat(40 * 1024) },
    }] })) };
    const clone = spyOn(globalThis, "structuredClone");
    try {
      expect(injectPickerModels(body, aliases)).toBe(0);
      expect(clone).not.toHaveBeenCalled();
      expect(body.model_selector_config.every(surface => surface.models.length === 1)).toBe(true);
    } finally { clone.mockRestore(); }
  }
});

test("compressed Desktop catalogs leave no rewritten body when the output would exceed its cap", () => {
  const body = fixture();
  const text = JSON.stringify({ ...body, padding: "x".repeat(BOOTSTRAP_MAX_DECODED_BYTES - 700) });
  expect(Buffer.byteLength(text)).toBeLessThan(BOOTSTRAP_MAX_DECODED_BYTES);
  const aliases = Array.from({ length: 32 }, (_, i) => ({ id: `ocx-${i}`, name: `Route ${i}` }));
  expect(rewriteBootstrapBody(gzipSync(Buffer.from(text)), "gzip", aliases) === null).toBe(true);
});


test("small nested metadata is independently cloned on both Desktop surfaces", () => {
  const native = { id: "claude-native", thinking: { mode: ["adaptive", "fixed"] }, capabilities: { images: true },
    description: "x".repeat(1024 * 1024), context_window: 200_000 };
  const body = { model_selector_config: ["ccd", "code", "ccr"].map(id => ({ id, models: [native] })) };
  expect(injectPickerModels(body, models)).toBe(2);
  for (const surface of body.model_selector_config.slice(0, 2)) {
    expect(surface.models[0]).toBe(native);
    expect(surface.models[1]!.thinking).toEqual(native.thinking);
    expect(surface.models[1]!.thinking).not.toBe(native.thinking);
    expect(surface.models[1]!.capabilities).toEqual(native.capabilities);
    expect(surface.models[1]!).not.toHaveProperty("description");
    expect(surface.models[1]!.context_window).toBe(128_000);
  }
  expect(body.model_selector_config[2]!.models).toEqual([native]);
});

test("UTF-8 and JSON escapes count toward retained field limits", () => {
  for (const value of ["界".repeat(24 * 1024), "\u0001".repeat(12 * 1024), "\ud800".repeat(12 * 1024)]) {
    const body = { model_selector_config: [{ id: "code", models: [{ id: "claude-native", metadata: value }] }] };
    expect(injectPickerModels(body, models)).toBe(0);
    expect(body.model_selector_config[0]!.models).toHaveLength(1);
  }
});
