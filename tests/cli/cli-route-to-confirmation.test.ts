import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { handleRouteToCommand, type RouteToDeps } from "../../src/cli/route-to";
import { createTempHome, type TempHome } from "../helpers/temp-home";
let home: TempHome, out: ReturnType<typeof spyOn>, err: ReturnType<typeof spyOn>;
beforeEach(() => { home = createTempHome("route-confirm-"); out = spyOn(console, "log").mockImplementation(() => {}); err = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { out.mockRestore(); err.mockRestore(); home.remove(); });
const id = "lnk_0123456789abcdef";
function status(device = id, client = "aside", applied: string | null = "current", alias = "child") {
  return { schema: "ocx.route-to/1", devices: [{ id: device, alias, clients: [{ client, intent: "on", source: "device", applied }] }] };
}
function fixture(body: unknown, code = 200): RouteToDeps {
  return { readChildContext: () => null, baseUrl: "http://127.0.0.1:18274", fetchImpl: (async () => Response.json(body, { status: code })) as typeof fetch };
}
test.each([
  { body: status("wrong"), device: id },
  { body: status(id, "codex"), device: id },
  { body: status(id, "aside", "current", "wrong-alias"), device: "child" },
  { body: status(id), device: undefined },
])("mutation rejects missing requested device/client: $device", async ({ body, device }) => {
  expect(await handleRouteToCommand(["aside", "on", ...(device ? ["--device", device] : [])], fixture(body))).not.toBe(0);
  expect(err.mock.calls.flat().join("\n")).toContain("unverified");
  expect(out.mock.calls).toHaveLength(0);
});
test.each(["child", id])("matching pending mutation remains valid for %s", async device => {
  expect(await handleRouteToCommand(["aside", "on", "--device", device], fixture(status(id, "aside", null)))).toBe(0);
});
test.each([false, true])("failed sync prints matrix before returning nonzero (json %s)", async json => {
  const body = { ...status(), syncs: [{ id, state: "failed", reason: "fixture_failed" }] };
  expect(await handleRouteToCommand(["sync", "--device", id, ...(json ? ["--json"] : [])], fixture(body, 502))).not.toBe(0);
  const printed = out.mock.calls.flat().join("\n");
  expect(printed).toContain("fixture_failed");
  if (json) expect(JSON.parse(printed)).toEqual(body);
});
test("failed sync in a successful HTTP response still exits nonzero", async () => {
  expect(await handleRouteToCommand(["sync", "--device", id], fixture({ ...status(), syncs: [{ id, state: "failed" }] }))).not.toBe(0);
});
