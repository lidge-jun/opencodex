import { expect, test } from "bun:test";
import { readJsonIfOk, readJsonOrThrow } from "../src/fetch-json";

test("readJsonIfOk returns null for non-OK responses", async () => {
  const res = new Response("nope", { status: 500 });
  expect(await readJsonIfOk(res)).toBeNull();
});

test("readJsonIfOk returns null for malformed OK JSON (does not throw)", async () => {
  const res = new Response("{not-json", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  expect(await readJsonIfOk(res)).toBeNull();
});

test("readJsonIfOk returns undefined for empty OK bodies", async () => {
  const res = new Response("", { status: 200 });
  expect(await readJsonIfOk(res)).toBeUndefined();
});

test("readJsonOrThrow surfaces server error messages", async () => {
  const res = Response.json({ error: "locked" }, { status: 503 });
  await expect(readJsonOrThrow(res, "fallback")).rejects.toThrow("locked");
});

test("readJsonOrThrow prefers error, then message, then fallback", async () => {
  await expect(
    readJsonOrThrow(Response.json({ message: "repair marker" }, { status: 500 }), "fallback"),
  ).rejects.toThrow("repair marker");
  await expect(
    readJsonOrThrow(Response.json({ error: "err", message: "msg" }, { status: 500 }), "fallback"),
  ).rejects.toThrow("err");
  await expect(
    readJsonOrThrow(Response.json({ detail: "other" }, { status: 500 }), "fallback"),
  ).rejects.toThrow("fallback");
});

test("readJsonOrThrow accepts Response-like mocks that only implement json()", async () => {
  const mock = {
    ok: true,
    status: 200,
    json: async () => ({ hello: "world" }),
  } as unknown as Response;
  expect(await readJsonOrThrow<{ hello: string }>(mock)).toEqual({ hello: "world" });
});
