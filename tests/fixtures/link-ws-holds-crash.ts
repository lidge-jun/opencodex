/**
 * Crash points for the link WebSocket activity-hold store (design T4 section 5). Arms the fence and
 * writes holds in a scratch directory, then terminates abruptly at the point named on stdin.
 */
import { readFileSync, writeSync } from "node:fs";
import { createActivityHolds } from "../../src/link/ws-activity-holds";
import { LINK_WS_LIMITS } from "../../src/server/index/link-websocket-limits";

const options = JSON.parse(readFileSync(0, "utf8")) as { dir: string; point: string; links: string[] };
// Exit handlers run on any orderly exit, including an error thrown after the kill returned; an abrupt
// kill never runs them. The parent asserts this sentinel is absent, on every platform.
process.on("exit", () => { try { writeSync(1, "\n(orderly exit)"); } catch { /* the parent closed its end */ } });
const kill = (point: string): never => {
  // Name the point first: the parent then knows which crash point the child actually reached.
  writeSync(1, point);
  // An abrupt kill everywhere (TerminateProcess on Windows), never an orderly exit that would run
  // exit handlers a real crash skips.
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL returned");
};
let holdWrites = 0;
const holds = createActivityHolds({
  dir: options.dir,
  linkIds: () => options.links,
  limits: LINK_WS_LIMITS,
  writeHooks: {
    beforeRename(_temp, target) {
      if (options.point === "during-fence-write" && target.endsWith("ws-run-state.json")) kill("during-fence-write");
      if (target.endsWith("activity-holds.json") && options.point === "during-hold-write" && ++holdWrites === 1) kill("during-hold-write");
    },
    afterRename(target) {
      if (options.point === "after-holds-before-clean" && target.endsWith("activity-holds.json") && stopping) kill("after-holds-before-clean");
    },
  },
});
let stopping = false;
holds.start();
if (!holds.arm()) throw new Error("arm failed");
if (options.point === "after-fence-write") kill("after-fence-write");
holds.add(options.links[0]!, { threadHash: holds.threadHash("thread-a"), pendingKeys: ["k1"], runningMarks: 1, untracked: false });
stopping = true;
holds.stop();
throw new Error("crash point was not reached");

