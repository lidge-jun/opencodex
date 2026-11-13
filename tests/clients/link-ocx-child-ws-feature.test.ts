import { describe, expect, test } from "bun:test";
import { OCX_CHILD_CARGO_RUN_MS, ocxChildCargoTest, ocxChildToolchain } from "../helpers/ocx-child-cargo";

// Lane T6-4: the ocx-child link WebSocket through the real binary, in a build with the link-ws-test-gate
// feature (native/ocx-child/tests/link_websocket.rs). Its own file, so its Cargo run has a process to itself;
// the run without the feature is in link-ocx-child-ws-gate.test.ts.

describe("ocx-child link WebSocket with the test gate", () => {
  test.skipIf(ocxChildToolchain.bin === null)("the real-binary link WebSocket tests pass", () => {
    const out = ocxChildCargoTest(["--features", "link-ws-test-gate", "--test", "link_websocket"]);
    expect(out).toContain("with_the_gate_an_advertising_home_carries_frames_both_ways ... ok");
  }, OCX_CHILD_CARGO_RUN_MS);
});
