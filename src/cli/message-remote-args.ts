import { validAlias, validPort, REMOTE_LIMITS } from "../messaging/remote-contract";
import { isSshAlias } from "../link/ssh-argv";
import { parseMessageArgs, type MessageArgs } from "./message-args";
import { isThreadId } from "../messaging/types";

export type RemoteMessageArgs = { action: "enable"; port?: number; json: boolean }
  | { action: "disable" | "status" | "hosts-list" | "_control" | "_port"; json: boolean }
  | { action: "serve"; hosts: string[]; json: boolean }
  | { action: "hosts-probe"; ssh: string; json: boolean }
  | { action: "hosts-add"; alias: string; ssh: string; fingerprint: string; json: boolean }
  | { action: "hosts-remove"; host: string; transaction?: string; json: boolean }
  | { action: "hosts-abandon"; transaction: string; json: boolean }
  | { action: "remote-operation"; host: string; local: MessageArgs; json: boolean };

/** Pure remote syntax validation precedes state, home selection, listeners or SSH allocation. */
export function parseRemoteMessageArgs(argv: readonly string[]): RemoteMessageArgs | null {
  let action = argv[0], start = 1, positional: string | undefined;
  if (action === "sessions" || action === "send") {
    const hostIndex = argv.indexOf("--host");
    if (hostIndex < 0 || argv.lastIndexOf("--host") !== hostIndex || !validAlias(argv[hostIndex + 1])) return null;
    const local = parseMessageArgs([...argv.slice(0, hostIndex), ...argv.slice(hostIndex + 2)]);
    return local ? { action: "remote-operation", host: argv[hostIndex + 1]!, local, json: local.json } : null;
  }
  if (action === "hosts") {
    if (!["list", "probe", "add", "remove", "abandon"].includes(argv[1] ?? "")) return null;
    action = `hosts-${argv[1]}`; start = 2;
    if (action === "hosts-add" || action === "hosts-remove") { positional = argv[start++]; if (!validAlias(positional)) return null; }
  }
  const seen = new Set<string>(), flags: Record<string, string> = {}, hosts: string[] = [];
  for (let index = start; index < argv.length; index++) {
    const flag = argv[index]!;
    if (seen.has(flag) && !(action === "serve" && flag === "--host")) return null;
    seen.add(flag);
    if (flag === "--json") continue;
    const allowed = action === "enable" ? ["--port"] : action === "serve" ? ["--host"]
      : action === "hosts-probe" ? ["--ssh"] : action === "hosts-add" ? ["--ssh", "--fingerprint"]
        : action === "hosts-abandon" || action === "hosts-remove" ? ["--transaction"] : [];
    if (!allowed.includes(flag)) return null;
    const value = argv[++index]; if (!value || value.startsWith("--")) return null;
    flags[flag] = value; if (flag === "--host") hosts.push(value);
  }
  const json = seen.has("--json");
  if (action === "enable") {
    if (flags["--port"] !== undefined && (!/^\d{4,5}$/.test(flags["--port"]) || !validPort(Number(flags["--port"])))) return null;
    return { action, json, ...(flags["--port"] ? { port: Number(flags["--port"]) } : {}) };
  }
  if (action === "serve") return hosts.length <= REMOTE_LIMITS.peers && hosts.every(validAlias)
    && new Set(hosts).size === hosts.length ? { action, hosts, json } : null;
  if (["disable", "status", "hosts-list", "_control", "_port"].includes(action ?? "")) {
    return { action: action as "disable", json };
  }
  if (action === "hosts-remove") {
    const transaction = flags["--transaction"];
    if (transaction !== undefined && !isThreadId(transaction)) return null;
    return { action, host: positional!, json, ...(transaction !== undefined ? { transaction } : {}) };
  }
  if (action === "hosts-abandon" && isThreadId(flags["--transaction"])) return { action, transaction: flags["--transaction"]!, json };
  if ((action === "hosts-probe" || action === "hosts-add") && flags["--ssh"] && isSshAlias(flags["--ssh"])) {
    if (action === "hosts-probe") return { action, ssh: flags["--ssh"], json };
    if (/^SHA256:[A-Za-z0-9+/=]{1,64}$/.test(flags["--fingerprint"] ?? "")) return {
      action, alias: positional!, ssh: flags["--ssh"], fingerprint: flags["--fingerprint"], json,
    };
  }
  return null;
}
