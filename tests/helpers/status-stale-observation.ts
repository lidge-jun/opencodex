import { spyOn } from "bun:test";
import * as probes from "../../src/cli/status-probes";

// Observe the human invocation's own real probe. A second CLI process can see
// a different refusal/timeout and cannot certify what this invocation observed.
const probe = probes.probeUncleanExitState;
spyOn(probes, "probeUncleanExitState").mockImplementation(async (...args) => {
  const result = await probe(...args);
  console.error(`OCX_TEST_STALE_OBSERVATION=${JSON.stringify(result)}`);
  return result;
});
