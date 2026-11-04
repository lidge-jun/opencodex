import { readFileSync } from "node:fs";
const detail = process.argv[2];
// Refuse at the existing native spend gate, using its own exception and catch path.
Bun.plugin({ name: "native spend denial fixture", setup(build) {
  build.onLoad({ filter: /src\/server\/messages-native\.ts$/ }, ({ path }) => {
    const source = readFileSync(path, "utf8");
    const anchor = "if (!physicalBudget.spendEnforced && !spendTracker.charge()) throw new NativeMessagesSpendRefusal();";
    if (source.split(anchor).length !== 2) throw new Error("Native spend gate changed");
    return { contents: source.replace(anchor, "throw new NativeMessagesSpendRefusal();"), loader: "ts" };
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
  console.log("WORKFLOW " + JSON.stringify({ status: response.status, sends, text: await response.text(), code: ctx.errorCode, header: response.headers.get("x-opencodex-local-refusal") }));
} finally { release(); }
