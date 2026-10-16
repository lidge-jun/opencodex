import type { RuntimePortState } from "../config/process-state";
import type { LiveProxy } from "../server/proxy-liveness";

import type { UpdateRestartHome } from "./update-restart-home";

export interface UpdateRestartCandidate {
  home: UpdateRestartHome;
  target: LiveProxy & { pid: number };
  runtime: RuntimePortState & { attestationSecret: string };
  cliVersion: string;
}

/** Private in-process evidence; diagnostics and JSON never expose the proof key. */
export class UpdateRestartRequired extends Error {
  #candidate: UpdateRestartCandidate;
  constructor(candidate: UpdateRestartCandidate) {
    super("restart_version_skew_cli_newer");
    this.#candidate = candidate;
  }
  candidate(): UpdateRestartCandidate { return this.#candidate; }
}
