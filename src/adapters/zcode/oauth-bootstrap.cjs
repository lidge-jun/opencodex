// Runs with a private profile (optional OS sandbox) using the unmodified official Desktop host.
// OAuth HTTP, polling, credentials and refresh belong exclusively to ZCode.
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const send = value => write(JSON.stringify(value) + "\n");
let stage = "native_oauth_failed";
const parent = new EventEmitter();
parent.postMessage = () => {};
process.parentPort = parent;
const timer = setTimeout(() => { send({ type: "error", code: "login_expired" }); process.exit(1); }, 300_000);
async function main() {
  fs.mkdirSync((process.env.ZCODE_DATA_BASE_DIR || process.env.HOME) + "/.zcode/v2", { recursive: true, mode: 0o700 });
  const dir = (process.argv[3] || "/zcode") + "/resources/app.asar/out/host";
  let classes = [];
  for (const name of fs.readdirSync(dir).filter(n => n.startsWith("chunk-") && n.endsWith(".js"))) {
    const source = fs.readFileSync(dir + "/" + name, "utf8");
    if (source.includes('"ChannelClient"') && source.includes('"MessagePortProtocol"')) {
      classes = Object.values(await import(dir + "/" + name)); break;
    }
  }
  const Client = classes.find(v => v?.name === "ChannelClient");
  const Protocol = classes.find(v => v?.name === "MessagePortProtocol");
  const left = new EventEmitter(), right = new EventEmitter();
  for (const [a, b] of [[left, right], [right, left]]) {
    a.postMessage = data => queueMicrotask(() => b.emit("message", { data, ports: [] }));
    a.start = () => {}; a.close = () => a.emit("close");
    a.addEventListener = a.on.bind(a); a.removeEventListener = a.off.bind(a);
  }
  const client = new Client(new Protocol(left));
  await import(dir + "/index.js");
  parent.emit("message", { data: { type: "init-local" }, ports: [right] });
  const oauth = client.getChannel("oauth");
  if (process.argv[2] === "capabilities") {
    const providers = await oauth.call("getProviders", []);
    if (!providers.some(p => (p.id ?? p.providerId) === "zai" && p.enabled)) throw new Error();
    send({ type: "capabilities", supported: true }); return;
  }
  const publish = async result => {
    stage = "session_restore_failed";
    if (result?.kind !== "session" || result.provider !== "zai" || typeof result.userInfo?.id !== "string" || !result.userInfo.id) throw new Error();
    // Official service materializes/refreshes built-in provider credentials and model config.
    stage = "model_setup_failed";
    const models = client.getChannel("model-provider");
    await models.call("getAll", []);
    await models.call("refreshCodingPlanApiKey", ["builtin:zai-coding-plan"]);
    send({ type: "authenticated", subjectHash: createHash("sha256").update("zai\0" + result.userInfo.id).digest("hex") });
  };
  if (process.argv[2] === "refresh") {
    stage = "session_restore_failed";
    const session = await oauth.call("restoreCachedSessionState", []);
    if (session?.status !== "authenticated") throw new Error();
    await publish({ kind: "session", provider: "zai", userInfo: session.userInfo }); return;
  }
  if (process.argv[2] !== "login") throw new Error();
  const flow = await oauth.call("startOAuthWithPolling", ["zai"]);
  const url = new URL(flow.authorizeUrl);
  if (url.protocol !== "https:" || url.hostname !== "chat.z.ai" || url.username || url.password) throw new Error();
  send({ type: "authorization", url: url.href });
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const result = await oauth.call("pollPendingOAuth", []);
    if (!result) continue;
    if (result.kind !== "session" || result.provider !== "zai" || typeof result.userInfo?.id !== "string" || !result.userInfo.id) throw new Error();
    await publish(result);
    return;
  }
}
main().then(() => { clearTimeout(timer); process.exit(0); }).catch(() => {
  send({ type: "error", code: stage }); process.exit(1);
});
