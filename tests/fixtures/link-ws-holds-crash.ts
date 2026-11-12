/**
 * Crash points for the link WebSocket activity-hold store (design T4 section 5). Arms the fence and
 * writes holds in a scratch directory, then kills itself with SIGKILL at the point named on stdin.
 */
import { readFileSync } from "node:fs";
import { createActivityHolds } from "../../src/link/ws-activity-holds";
import { LINK_WS_LIMITS } from "../../src/server/index/link-websocket-limits";

const options = JSON.parse(readFileSync(0, "utf8")) as { dir: string; point: string; links: string[] };
const kill = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("unreachable"); };
let holdWrites = 0;
const holds = createActivityHolds({
  dir: options.dir,
  linkIds: () => options.links,
  limits: LINK_WS_LIMITS,
  writeHooks: {
    beforeRename(_temp, target) {
      if (options.point === "during-fence-write" && target.endsWith("ws-run-state.json")) kill();
      if (target.endsWith("activity-holds.json") && options.point === "during-hold-write" && ++holdWrites === 1) kill();
    },
    afterRename(target) {
      if (options.point === "after-holds-before-clean" && target.endsWith("activity-holds.json") && stopping) kill();
    },
  },
});
let stopping = false;
holds.start();
if (!holds.arm()) throw new Error("arm failed");
if (options.point === "after-fence-write") kill();
holds.add(options.links[0]!, { threadHash: holds.threadHash("thread-a"), pendingKeys: ["k1"], runningMarks: 1, untracked: false });
stopping = true;
holds.stop();
kill();

