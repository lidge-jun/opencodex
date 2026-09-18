import { expect, test } from "bun:test";
import { heldResponse } from "../helpers/held-response";

// Return the real handler so the fixture contract needs no sockets or timing sleeps.
const fixture = () => heldResponse(handler => handler);

test("held response stays pending until its owner releases it", async () => {
  const held = fixture();
  let settled = false;
  const pending = held.server().then(response => { settled = true; return response; });
  try {
    await held.started;
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    held.release();
  }
  expect((await pending).status).toBe(204);
});

test("finally releases the held handler even when the test body throws", async () => {
  const held = fixture();
  const pending = held.server();
  await held.started;
  expect(() => {
    try {
      throw new Error("simulated assertion failure");
    } finally {
      held.release();
    }
  }).toThrow("simulated assertion failure");
  expect((await pending).status).toBe(204);
});

test("cleanup may release a held response before the handler starts", async () => {
  const held = fixture();
  held.release();
  expect((await held.server()).status).toBe(204);
  await held.started;
});

test("releasing a held response more than once is harmless", async () => {
  const held = fixture();
  const pending = held.server();
  try {
    await held.started;
    held.release();
    held.release();
    expect((await pending).status).toBe(204);
  } finally {
    held.release();
  }
});

test("one held response cannot release another fixture", async () => {
  const first = fixture();
  const second = fixture();
  const firstPending = first.server();
  let secondSettled = false;
  const secondPending = second.server().then(response => { secondSettled = true; return response; });
  try {
    await Promise.all([first.started, second.started]);
    first.release();
    expect((await firstPending).status).toBe(204);
    expect(secondSettled).toBe(false);
  } finally {
    first.release();
    second.release();
  }
  expect((await secondPending).status).toBe(204);
});
