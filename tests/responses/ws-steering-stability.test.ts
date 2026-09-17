import { expect, spyOn, test } from "bun:test";
import { NativeSteeringChannel, NATIVE_STEERING_WAIT_MS as WAIT,
  NATIVE_STEERING_TOOL_WAIT_MS as TOOL_WAIT } from "../../src/server/responses/native-steering";
import { NativeSteeringReplay, MAX_NATIVE_STEERING_REPLAY_BYTES as REPLAY_LIMIT } from "../../src/server/responses/native-steering-replay";
import { beginInjection, injectionConfig, installInjectionFixture, InjectionSocket,
  waitForInjection, fallbackCalls, type Frame } from "../helpers/native-injection-fixture";

installInjectionFixture();

/** Synchronous monotonic clock: exercise real owner transitions without wall-clock sleeps. */
function clock() {
  let now = 1_000;
  const timers = new Map<object, { due: number; run: () => void }>();
  const time = spyOn(performance, "now").mockImplementation(() => now);
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay = 0) => {
    const timer = { unref() { return timer; } };
    timers.set(timer, { due: now + delay, run });
    return timer;
  }) as unknown as typeof setTimeout);
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: object) => { timers.delete(timer); }) as typeof clearTimeout);
  return {
    get pending() { return timers.size; },
    advance(ms: number, fire = true) {
      now += ms;
      if (!fire) return;
      for (let count = 0; count < 100; count++) {
        const ready = [...timers.entries()].find(([, value]) => value.due <= now);
        if (!ready) return;
        timers.delete(ready[0]); ready[1].run();
      }
      throw new Error("fixture timer rescheduled without progress");
    },
    restore() { schedule.mockRestore(); cancel.mockRestore(); time.mockRestore(); },
  };
}
const steer = (input = "change", id = "root") => ({ type: "response.steer", previous_response_id: id, input });
const accepted = (id = "s1", parent = "root") => ({ type: "response.steer.accepted", steer: { id, previous_response_id: parent } });
const terminal = (id = "root", output: Frame[] = []) => ({ type: "response.completed", response: { id, status: "completed", output } });
const stub = { type: "function_call_output", call_id: "saved-call" };
const pending = (id = "s1") => ({ type: "response.steer.pending", steer: { id, previous_response_id: "root" }, reason: "waiting_for_required_input", required_input: [stub] });
const continuation = () => ({ type: "response.create", previous_response_id: "root", input: [{ ...stub, output: "saved result" }] });

/** Every fixture restores timer hooks even when demonstrating a pre-fix failure. */
function unit(run: (value: ReturnType<typeof unitValue>) => void) {
  const value = unitValue();
  try { run(value); } finally { value.detach(); value.time.restore(); }
}
function unitValue() {
  const time = clock();
  const sent: Frame[] = [];
  const failures: Error[] = [];
  const channel = new NativeSteeringChannel({});
  const detach = channel.attach(frame => sent.push(frame), error => failures.push(error));
  channel.observe({ type: "response.created", response: { id: "root" } });
  const activity = () => channel.observe({ type: "response.in_progress", response: { id: "root" } });
  return { time, sent, failures, channel, detach, activity };
}

test("steer acknowledgement expires despite continuous response activity", () => unit(({ channel, activity, time, failures, sent }) => {
  channel.steer(steer());
  for (let i = 0; i < 2; i++) { time.advance(WAIT / 3); activity(); }
  time.advance(WAIT / 3);
  expect(failures).toHaveLength(1); expect(failures[0].message).toContain("unknown");
  expect(channel.ended).toBe(true); expect(sent).toHaveLength(1);
  time.advance(WAIT * 3); expect(failures).toHaveLength(1);
}));

test("later submissions cannot postpone the oldest unacknowledged steer", () => unit(({ channel, time, failures, sent }) => {
  channel.steer(steer("first")); time.advance(WAIT / 2);
  channel.steer(steer("second")); time.advance(WAIT / 2);
  expect(failures).toHaveLength(1); expect(sent).toHaveLength(2);
}));

test("acknowledgement removes only its submission deadline", () => unit(({ channel, time, failures, activity }) => {
  channel.steer(steer("first")); time.advance(10_000); channel.steer(steer("second"));
  time.advance(10_000); channel.observe(accepted());
  time.advance(WAIT - 20_000); activity(); expect(failures).toHaveLength(0);
  time.advance(10_000); expect(failures).toHaveLength(1);
}));

test("an unacknowledged steer keeps its deadline during a tool wait for another steer", () => unit(({ channel, time, failures }) => {
  channel.steer(steer("one")); channel.steer(steer("two")); channel.observe(accepted());
  channel.observe(terminal()); time.advance(1000); channel.observe(pending());
  time.advance(WAIT - 1000); expect(failures).toHaveLength(1);
}));

test("automatic successor has a fixed deadline from parent termination", () => unit(({ channel, time, failures, activity }) => {
  channel.steer(steer()); channel.observe(accepted());
  time.advance(20_000); channel.observe(terminal());
  time.advance(40_000); activity(); time.advance(49_999); activity();
  expect(failures).toHaveLength(0); time.advance(1); expect(failures).toHaveLength(1);
}));

test("acceptance after the terminal cannot restart the successor deadline", () => unit(({ channel, time, failures, activity }) => {
  channel.steer(steer()); time.advance(1000); channel.observe(terminal());
  time.advance(40_000); channel.observe(accepted());
  time.advance(49_999); activity(); expect(failures).toHaveLength(0);
  time.advance(1); expect(failures).toHaveLength(1);
}));

test("repeated required-input notifications share the first parent tool deadline", () => unit(({ channel, time, failures }) => {
  channel.steer(steer("one")); channel.steer(steer("two"));
  channel.observe(accepted()); channel.observe(accepted("s2")); channel.observe(terminal());
  time.advance(1000); channel.observe(pending());
  time.advance(TOOL_WAIT - 1); channel.observe(pending("s2"));
  expect(failures).toHaveLength(0); time.advance(1); expect(failures).toHaveLength(1);
}));

test("saved results get a new successor deadline and late pending cannot extend it", () => unit(({ channel, time, failures, sent }) => {
  channel.steer(steer()); channel.observe(accepted()); channel.observe(terminal()); channel.observe(pending());
  time.advance(200_000); expect(channel.continue(continuation())).toBe(true);
  time.advance(WAIT - 1); channel.observe(pending());
  expect(failures).toHaveLength(0); time.advance(1);
  expect(failures).toHaveLength(1); expect(sent).toHaveLength(2);
}));

test("early saved results start a successor deadline before required-input notification", () => unit(({ channel, time, failures }) => {
  channel.steer(steer()); channel.observe(accepted());
  channel.observe(terminal("root", [{ type: "function_call", call_id: stub.call_id }]));
  time.advance(1000); channel.continue(continuation());
  time.advance(WAIT - 1); channel.observe(pending());
  expect(failures).toHaveLength(0); time.advance(1); expect(failures).toHaveLength(1);
}));

test("a dispatched continuation keeps its deadline when accepted steering fails", () => unit(({ channel, time, failures, sent }) => {
  channel.steer(steer()); channel.observe(accepted()); channel.observe(terminal()); channel.observe(pending());
  channel.continue(continuation()); time.advance(20_000);
  channel.observe({ type: "response.steer.failed", steer: { id: "s1", previous_response_id: "root" } });
  time.advance(WAIT - 20_000); expect(failures).toHaveLength(1); expect(sent).toHaveLength(2);
}));

test("an acknowledgement cannot rescue an expired deadline before the timer callback runs", () => unit(({ channel, time, failures }) => {
  channel.steer(steer()); time.advance(WAIT, false);
  expect(() => channel.observe(accepted())).toThrow("unknown");
  expect(failures).toHaveLength(1); expect(channel.ended).toBe(true);
}));

test("normal response activity refreshes only idle liveness", () => unit(({ channel, activity, time, failures }) => {
  time.advance(250_000); activity(); time.advance(250_000); activity();
  expect(failures).toHaveLength(0); time.advance(300_000);
  expect(failures).toHaveLength(1); expect(channel.ended).toBe(true);
}));

test("a rejected steer removes its hard deadline without ending a live response", () => unit(({ channel, activity, time, failures }) => {
  channel.steer(steer()); time.advance(20_000);
  channel.observe({ type: "response.steer.failed", steer: { previous_response_id: "root" } });
  time.advance(WAIT); activity(); expect(failures).toHaveLength(0);
  expect(channel.observe(terminal())).toBe(true); expect(time.pending).toBe(0);
}));

test("created successor clears old phase deadlines and receives its own idle interval", () => unit(({ channel, time, failures }) => {
  channel.steer(steer()); channel.observe(accepted()); channel.observe(terminal());
  time.advance(WAIT - 1);
  channel.observe({ type: "response.created", response: { id: "next", previous_response_id: "root" } });
  time.advance(WAIT * 2); expect(failures).toHaveLength(0);
  expect(channel.observe(terminal("next"))).toBe(true); expect(time.pending).toBe(0);
}));

test("detach cancels pending deadlines and prevents delayed failure callbacks", () => unit(({ channel, time, detach, failures }) => {
  channel.steer(steer()); detach(); expect(time.pending).toBe(0);
  time.advance(TOOL_WAIT * 2); expect(failures).toHaveLength(0);
}));

const output = [
  { id: "reason", type: "reasoning", encrypted_content: "fixture-opaque-reasoning", summary: [] },
  { id: "tool", type: "function_call", call_id: "saved-call", name: "read", arguments: "{}" },
  { id: "message", type: "message", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] },
];
/** Replay assertions inspect committed cache inputs, not just server events on the wire. */
function replayFixture() {
  const stored: Frame[] = [];
  const replay = new NativeSteeringReplay("initial", (input, response) => stored.push(structuredClone({ input, response })));
  replay.observe({ type: "response.created", response: { id: "root" } });
  output.forEach((item, output_index) => replay.observe({ type: "response.output_item.done", output_index, item }));
  return { replay, stored };
}

test.each(["response.completed", "response.incomplete", "response.failed"])("%s sparse output survives a steering successor prefix", type => {
  const { replay, stored } = replayFixture();
  try {
    replay.submitted(steer()); replay.observe(accepted());
    replay.observe({ type, response: { id: "root", output: [structuredClone(output[2])] } });
    expect(stored).toHaveLength(type === "response.completed" ? 1 : 0);
    replay.observe({ type: "response.created", response: { id: "next", previous_response_id: "root" } });
    replay.observe(terminal("next"));
    expect(stored.at(-1)!.input.slice(1, 4)).toEqual(output);
    expect(JSON.stringify(stored.at(-1)!.input.at(-1))).toContain("change");
  } finally { replay.dispose(); }
});

test("matching terminal echoes appear once even when object-key order differs", () => {
  const { replay, stored } = replayFixture();
  try {
    replay.observe(terminal("root", [{ ...output[2], id: "message" }]));
    expect(stored[0].response.output).toEqual(output);
    expect(stored[0].response.output.map((item: Frame) => item.id)).toEqual(["reason", "tool", "message"]);
  } finally { replay.dispose(); }
});

test.each([
  [{ ...output[0], encrypted_content: "contradiction" }],
  [output[2], output[0]],
  [output[0], output[0]],
])("conflicting terminal content/order/duplicates never enters the shared cache", terminalOutput => {
  const { replay, stored } = replayFixture();
  try {
    expect(() => replay.observe(terminal("root", terminalOutput))).toThrow();
    expect(stored).toHaveLength(0);
  } finally { replay.dispose(); }
});

test("merged sparse output still enforces the unchanged serialized replay budget", () => {
  const remembered: unknown[] = [];
  const replay = new NativeSteeringReplay([], (_, value) => remembered.push(value));
  try {
    replay.observe({ type: "response.created", response: { id: "root" } });
    const one = { id: "large-wire", type: "reasoning", encrypted_content: "x".repeat(REPLAY_LIMIT / 2) };
    replay.observe({ type: "response.output_item.done", output_index: 0, item: one });
    expect(() => replay.observe(terminal("root", [{ ...one, id: "large-terminal" }]))).toThrow("budget");
    expect(remembered).toHaveLength(0);
  } finally { replay.dispose(); }
});

test("real steering handler preserves sparse output through automatic and ordinary successors", async () => {
  const settings = { ...injectionConfig(), codexNativeInjection: false, codexNativeSteering: true };
  const { ws, socket, send, sent, id } = await beginInjection({ multi_agent: undefined }, settings);
  for (let index = 0; index < output.length; index++) {
    socket.emit({ type: "response.output_item.added", output_index: index, item: output[index] });
    socket.emit({ type: "response.output_item.done", output_index: index, item: output[index] });
  }
  send(steer("preserve the reasoning", id)); socket.emit(accepted("s1", id));
  socket.emit({ type: "response.incomplete", response: { id, status: "incomplete", incomplete_details: { reason: "steered" }, output: [output[2]] } });
  socket.emit({ type: "response.created", response: { id: "next", previous_response_id: id } });
  socket.emit(terminal("next")); await waitForInjection(() => !ws.data.nativeControl);
  send({ type: "response.create", model: "gpt-5.6-sol", previous_response_id: "next", input: "ordinary followup" });
  await waitForInjection(() => InjectionSocket.all.length === 2 && InjectionSocket.all[1].frames.length > 0);
  const next = InjectionSocket.all[1];
  const history = JSON.stringify(next.frames[0].input);
  expect(history).toContain("fixture-opaque-reasoning"); expect(history).toContain("saved-call");
  expect(history).toContain("preserve the reasoning"); expect(history).toContain("ordinary followup");
  expect(sent.find(frame => frame.type === "response.incomplete")?.response.output).toEqual([output[2]]);
  expect(fallbackCalls).toBe(0); next.emit(terminal(next.root));
  await waitForInjection(() => !ws.data.nativeControl);
});

test("accepted input allows active work beyond the acknowledgement window until a safe boundary", () => unit(({ channel, time, failures, activity }) => {
  channel.steer(steer()); channel.observe(accepted());
  for (let i = 0; i < 4; i++) { time.advance(WAIT - 1); activity(); }
  expect(failures).toHaveLength(0); channel.observe(terminal());
  time.advance(WAIT); expect(failures).toHaveLength(1);
}));

test("a new steer cannot rescue an expired submission when timers are delayed", () => unit(({ channel, time, failures, sent }) => {
  channel.steer(steer()); time.advance(WAIT, false);
  expect(() => channel.steer(steer("late"))).toThrow("unknown");
  expect(sent).toHaveLength(1); expect(failures).toHaveLength(1);
}));

test("a late continuation cannot rescue an expired tool wait", () => unit(({ channel, time, failures, sent }) => {
  channel.steer(steer()); channel.observe(accepted()); channel.observe(terminal()); channel.observe(pending());
  time.advance(TOOL_WAIT, false);
  expect(() => channel.continue(continuation())).toThrow("unknown");
  expect(sent).toHaveLength(1); expect(failures).toHaveLength(1);
}));

test("wall-clock corrections cannot change monotonic acknowledgement deadlines", () => unit(({ channel, time, failures, activity }) => {
  const wallClock = spyOn(Date, "now").mockReturnValue(0);
  try {
    channel.steer(steer()); time.advance(WAIT - 1); wallClock.mockReturnValue(10 ** 15); activity();
    expect(failures).toHaveLength(0); time.advance(1); expect(failures).toHaveLength(1);
  } finally { wallClock.mockRestore(); }
}));
