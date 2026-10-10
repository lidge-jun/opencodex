import { getConfigDir } from "../config/paths";
import { MessageBudget } from "../messaging/budget";
import { readMessageInput } from "../messaging/input";
import { RemoteCapacity } from "../messaging/remote-contract";
import { enrollRemoteHost, handleEnrollmentControl, probeRemoteHost, removeRemoteHost } from "../messaging/remote-enrollment";
import { remoteControl } from "../messaging/remote-auth";
import { ownerEndpoint, startRemoteOwner } from "../messaging/remote-owner";
import { remotePortCandidate } from "../messaging/remote-ports";
import { remoteSessions, sendRemoteMessage } from "../messaging/remote-send";
import { RemoteMessageStore } from "../messaging/remote-store";
import { messageFailure } from "../messaging/send";
import { messageCodexHome } from "./message-runtime";
import { terminalSafeText } from "./runtime-api";
import type { RemoteMessageArgs } from "./message-remote-args";

/** Activate remote resources only after an explicit remote command's pure parser succeeds. */
export async function runRemoteMessageCommand(args: RemoteMessageArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const store = new RemoteMessageStore(getConfigDir()), controller = new AbortController(), capacity = new RemoteCapacity();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const emit = (value: unknown) => console.log(args.json || args.action.startsWith("_")
    ? JSON.stringify(value) : terminalSafeText(JSON.stringify(value)));
  try {
    if (args.action === "serve") {
      const owner = await startRemoteOwner(store, messageCodexHome(env), args.hosts, controller.signal);
      try {
        emit({ protocol: "ocx-message-remote/1", running: true, port: owner.port });
        await Promise.race([owner.finished, new Promise<void>(resolve => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
          if (controller.signal.aborted) resolve();
        })]);
        if (!controller.signal.aborted) { emit({ running: false, error: { code: "owner_retired", message: "Foreground messaging owner retired; restart explicitly after resolving its route/configuration failure." } }); return 1; }
      } finally { await owner.close(); }
      return 0;
    }
    const budget = new MessageBudget(30000, controller.signal);
    try {
      if (args.action === "enable") { store.enable(args.port ?? store.read()?.port ?? 39176); emit(store.publicState()); }
      else if (args.action === "disable") { store.disable(); emit(store.publicState()); }
      else if (args.action === "hosts-list") emit(store.publicState());
      else if (args.action === "status") {
        const state = store.read(); let running = false, routes: unknown = [];
        if (state?.enabled) {
          try { const result = await remoteControl(state, ownerEndpoint(state), "message/routes", {}, budget);
            running = true; routes = result; } catch { /* Disabled/offline is not activation or repair. */ }
        }
        emit({ ...store.publicState(), running, routes });
      } else if (args.action === "hosts-probe") emit({ ssh: args.ssh, fingerprint: (await probeRemoteHost(args.ssh, budget, capacity)).fingerprint });
      else if (args.action === "hosts-add") emit(await enrollRemoteHost(store, args.alias, args.ssh, args.fingerprint, budget, capacity));
      else if (args.action === "hosts-remove") {
        const receipt = await removeRemoteHost(store, args.host, budget, capacity); emit(receipt);
        return receipt.remote === "removed" ? 0 : 3;
      } else if (args.action === "_control") {
        emit(handleEnrollmentControl(store, JSON.parse(await readMessageInput(Bun.stdin.stream(), budget))));
      } else if (args.action === "_port") { store.requireEnabled(); emit({ port: remotePortCandidate() }); }
      else if (args.action === "remote-operation") {
        if (args.local.action === "sessions") emit(await remoteSessions(store, args.host, budget));
        else {
          const body = await readMessageInput(Bun.stdin.stream(), budget);
          const receipt = await sendRemoteMessage(store, { ...args.local, host: args.host, body },
            { home: messageCodexHome(env), senderId: env.CODEX_THREAD_ID }, budget);
          emit(receipt); return receipt.status === "queued" ? 0 : receipt.status === "unknown" ? 3 : 1;
        }
      }
      return 0;
    } finally { budget.dispose(); }
  } catch (error) {
    // Control errors never echo stdin, SSH output, keys or paths; a failed enrollment keeps its transaction.
    const failure = messageFailure(error), unknown = ["enrollment_unknown", "remote_control_unknown", "cleanup_incomplete"].includes(failure.code);
    emit({ schema: "ocx-message-error/1", ...(unknown ? { status: "unknown" } : args.action === "remote-operation" && args.local.action === "send" ? { status: "not_sent" } : {}), error: failure }); return unknown ? 3 : 1;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
