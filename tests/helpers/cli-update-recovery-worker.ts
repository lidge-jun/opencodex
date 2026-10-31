import { createWorkerCommitWindow } from "../../src/codex/cli-update-selection-gate";
declare const self: Worker;
if (!Bun.isMainThread) self.onmessage = event => {
  const message = event.data;
  const window = createWorkerCommitWindow(message);
  if (!window.tryEnter()) throw new Error("fixture_gate_not_acquired");
  if (message.fixtureCommitted && !window.commit()) throw new Error("fixture_commit_failed");
  // Deliberately lose the owner without a result. No installer is ever spawned.
  self.onmessage = null;
};
