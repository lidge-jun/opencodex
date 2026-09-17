import { SteeringProbe, type ProbeReport, type ProbeScenario } from "./steering-probe";

type Target = { url: string; model: string; headers: Record<string, string> };
const API = "wss://api.openai.com/v1/responses";
const CHATGPT = "wss://chatgpt.com/backend-api/codex/responses";
const USAGE = "bun scripts/steering-smoke.ts --self-test | --direct <canonical-wss-url> --proxy <loopback-ws-url> --model <model> [--proxy-model <prefixed-model>] [--live --allow-model-requests]";

/** Validate destinations before reading credentials. Default invocation never sends a model request. */
export function probeTargets(args: string[], env: Record<string, string | undefined>): { live: boolean; direct: Target; proxy: Target } {
  const values = new Map<string, string>(); let live = false; let consent = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--live") { if (live) throw new Error(USAGE); live = true; continue; }
    if (key === "--allow-model-requests") { if (consent) throw new Error(USAGE); consent = true; continue; }
    if (!["--direct", "--proxy", "--model", "--proxy-model"].includes(key) || values.has(key) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(USAGE);
    values.set(key, args[++i]);
  }
  const directUrl = values.get("--direct");
  if (directUrl !== API && directUrl !== CHATGPT) throw new Error("Direct destination must be the canonical OpenAI API or ChatGPT Responses WebSocket.");
  let proxyUrl: URL;
  try { proxyUrl = new URL(values.get("--proxy") ?? ""); } catch { throw new Error("A loopback proxy URL is required."); }
  if (!["ws:", "wss:"].includes(proxyUrl.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(proxyUrl.hostname)
    || proxyUrl.username || proxyUrl.password || proxyUrl.search || proxyUrl.hash
    || !["/responses", "/v1/responses", "/backend-api/codex/responses"].includes(proxyUrl.pathname)) throw new Error("Proxy must be a loopback Responses URL without credentials, query or fragment.");
  const model = values.get("--model"); const proxyModel = values.get("--proxy-model") ?? model;
  if (!model || !proxyModel || [model, proxyModel].some(value => value.length > 256 || /[\u0000-\u0020\u007f]/.test(value))) throw new Error("Explicit valid model selectors are required.");
  if (live !== consent) throw new Error("Live execution requires both --live and --allow-model-requests; it can consume model usage.");
  const headers = (kind: "DIRECT" | "PROXY") => {
    const token = live ? env[`STEERING_${kind}_TOKEN`] : undefined;
    if (live && (!token || /[\r\n\0]/.test(token))) throw new Error(`Set STEERING_${kind}_TOKEN in the environment, never on the command line.`);
    return { "OpenAI-Beta": "responses_websockets=2026-02-06", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  };
  const directHeaders: Record<string, string> = headers("DIRECT");
  const account = live && directUrl === CHATGPT ? env.STEERING_DIRECT_ACCOUNT_ID : undefined;
  if (account) { if (/[\r\n\0]/.test(account)) throw new Error("Invalid account header."); directHeaders["chatgpt-account-id"] = account; }
  return { live, direct: { url: directUrl, model, headers: directHeaders }, proxy: { url: proxyUrl.href, model: proxyModel, headers: headers("PROXY") } };
}

/** One root request per scenario, bounded socket, no retries and no arbitrary tool execution. */
export function runSteeringProbe(target: Target, scenario: ProbeScenario): Promise<ProbeReport> {
  return new Promise(resolve => {
    let socket: WebSocket | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let done = false;
    const settle = (report: ProbeReport) => { if (done) return; done = true; clearTimeout(timer); try { socket?.close(); } catch { /* reporting never retries transport */ } resolve(report); };
    const probe = new SteeringProbe(scenario, frame => {
      try { if (socket?.readyState !== WebSocket.OPEN) throw new Error(); socket.send(JSON.stringify(frame)); }
      catch { settle(probe.finish("unknown", "send_outcome_unknown")); }
    });
    try { socket = new WebSocket(target.url, { headers: target.headers, maxPayloadLength: 2 * 1024 * 1024 } as unknown as string[]); }
    catch { settle(probe.finish("unknown", "connection_failed")); return; }
    timer = setTimeout(() => settle(probe.finish("unknown", "probe_deadline")), 120_000);
    socket.addEventListener("open", () => {
      try { socket!.send(JSON.stringify(probe.request(target.model))); }
      catch { settle(probe.finish("unknown", "send_outcome_unknown")); }
    });
    socket.addEventListener("message", event => {
      if (done) return;
      if (typeof event.data !== "string") { settle(probe.finish("failed", "unsupported_wire_frame")); return; }
      try { const report = probe.receive(event.data); if (report) settle(report); }
      catch { settle(probe.finish("unknown", "probe_processing_failed")); }
    });
    socket.addEventListener("error", () => settle(probe.finish("unknown", "connection_error")));
    socket.addEventListener("close", () => settle(probe.finish("unknown", "connection_closed")));
  });
}

/** Offline positive control; no socket, credential lookup or model request. */
export function steeringProbeSelfTest(): ProbeReport {
  const sent: Record<string, any>[] = [];
  const probe = new SteeringProbe("automatic", frame => sent.push(frame));
  for (const frame of [
    { type: "response.created", response: { id: "fixture-root" } },
    { type: "response.steer.accepted", steer: { id: "fixture-steer", previous_response_id: "fixture-root" } },
    { type: "response.incomplete", response: { id: "fixture-root" } },
    { type: "response.created", response: { id: "fixture-next", previous_response_id: "fixture-root" } },
    { type: "response.output_text.delta", delta: "STEERING_PROBE_OK" },
    { type: "response.completed", response: { id: "fixture-next", output: [] } },
  ]) probe.receive(JSON.stringify(frame));
  if (sent.length !== 1 || probe.report?.outcome !== "passed") throw new Error("Offline steering probe control failed.");
  return probe.report;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--self-test") console.log(JSON.stringify({ mode: "offline-fixture", result: steeringProbeSelfTest() }, null, 2));
    else if (!args.length || args.includes("--help")) console.log(USAGE);
    else {
      const targets = probeTargets(args, process.env);
      if (!targets.live) console.log(JSON.stringify({ mode: "plan-only", modelRequestsSent: 0, scenarios: ["automatic", "required-input"], targets: ["direct", "proxy"] }, null, 2));
      else {
        const reports = [];
        for (const label of ["direct", "proxy"] as const) for (const scenario of ["automatic", "required-input"] as const) {
          reports.push({ target: label, ...await runSteeringProbe(targets[label], scenario) });
        }
        console.log(JSON.stringify({ mode: "live-single-attempt", reports }, null, 2));
        process.exitCode = reports.every(report => report.outcome === "passed") ? 0 : 1;
      }
    }
  } catch (error) { console.error(error instanceof Error ? error.message : USAGE); process.exitCode = 2; }
}
