import { readFileSync } from "node:fs";
const detail = process.argv[2];
const workflowHook = { hits: 0 };
(globalThis as typeof globalThis & { __workflowHook: typeof workflowHook }).__workflowHook = workflowHook;
const nativeFilter = /src[\\/]server[\\/]messages-native\.ts$/;
const filterChecks = {
  forward: nativeFilter.test("/fixture/src/server/messages-native.ts"),
  backward: nativeFilter.test("C:\\fixture\\src\\server\\messages-native.ts"),
};
// Refuse at the existing native spend gate, using its own exception and catch path.
Bun.plugin({ name: "native spend denial fixture", setup(build) {
  build.onLoad({ filter: nativeFilter }, ({ path }) => {
    const source = readFileSync(path, "utf8");
    const anchor = "if (!physicalBudget.spendEnforced && !spendTracker.charge({ workflowAlreadyCounted: true })) throw new NativeMessagesSpendRefusal();";
    if (source.split(anchor).length !== 2) throw new Error("Native spend gate changed");
    return { contents: source.replace(anchor, "globalThis.__workflowHook.hits++; throw new NativeMessagesSpendRefusal();"), loader: "ts" };
  });
} });
const { acquireOwnedSpendHome } = await import("./owned-spend-home");
const { saveConfig } = await import("../../src/config");
const { handleClaudeMessages } = await import("../../src/server/claude-messages");
let sends = 0;
const config: any = { defaultProvider: "fixture", providers: { fixture: { adapter: "anthropic", baseUrl: "http://127.0.0.1:1", apiKey: "fixture", authMode: "key", models: ["wire-model"], allowPrivateNetwork: true, fetch: async () => { sends++; throw new Error("Unexpected send"); } } }, protocols: { rollout: { managedMessagesNative: true } } };
saveConfig(config);
const ctx: any = { model: "", provider: "", ...(detail === "absent" ? {} : { spendRefusalDetail: { scope: detail === "invalid" ? "invalid" : "identity", limit: 987654321, projected: 987654322, ...(detail === "unbound" ? { includesUnboundPoolHistory: true } : {}) } }) };
const release = acquireOwnedSpendHome();
try {
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "fixture/wire-model", max_tokens: 16, messages: [{ role: "user", content: "synthetic" }], stream: true }) }), config, ctx);
  console.log("WORKFLOW " + JSON.stringify({ status: response.status, sends, text: await response.text(), code: ctx.errorCode, header: response.headers.get("x-opencodex-local-refusal"), hookHits: workflowHook.hits, filterChecks }));
} finally { release(); }
