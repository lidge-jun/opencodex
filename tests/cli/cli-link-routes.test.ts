import { expect, test } from "bun:test";
import { runLinkCommand } from "../../src/cli/link";

const LINK = "lnk_0123456789abcdef";
type RequestCall = { url: string; init: RequestInit | undefined };

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  return { stdout, stderr, restore: () => { console.log = originalLog; console.error = originalError; } };
}

function fakeFetch(body: unknown, calls: RequestCall[], status = 200): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const DOC = { linkId: LINK, pin: "pen-alpha", routes: ["alpha-lan", "pen-alpha"] };

async function run(args: string[], body: unknown = DOC, status = 200) {
  const calls: RequestCall[] = [];
  const output = captureOutput();
  try {
    const code = await runLinkCommand(["routes", ...args], { baseUrl: "http://127.0.0.1:19101", fetchImpl: fakeFetch(body, calls, status), readAdminToken: () => "ocx_admin_test-token" });
    return { code, calls, stdout: output.stdout, stderr: output.stderr };
  } finally {
    output.restore();
  }
}

test("routes lists a link's routes with its pin", async () => {
  const result = await run(["--link-id", LINK, "--json"]);
  expect(result.code).toBe(0);
  expect(result.calls[0]?.url).toBe("http://127.0.0.1:19101/api/link/" + LINK + "/routes");
  expect(result.calls[0]?.init?.method ?? "GET").toBe("GET");
  expect(JSON.parse(result.stdout.join("\n"))).toEqual(DOC);
  const text = await run(["--link-id", LINK]);
  expect(text.stdout).toEqual(["0  alpha-lan", "1  pen-alpha  (pin)"]);
});

test.each([
  [["add", "--link-id", LINK, "--route", "alpha-lan"], { op: "add", route: "alpha-lan" }],
  [["add", "--link-id", LINK, "--route", "alpha-lan", "--position", "0"], { op: "add", route: "alpha-lan", position: 0 }],
  [["remove", "--link-id", LINK, "--route", "alpha-lan"], { op: "remove", route: "alpha-lan" }],
  [["order", "--link-id", LINK, "--routes", "alpha-lan,pen-alpha"], { op: "order", routes: ["alpha-lan", "pen-alpha"] }],
] as const)("routes %j posts %j and prints the document", async (args, body) => {
  const result = await run([...args, "--json"]);
  expect(result.code).toBe(0);
  expect(result.calls[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(result.calls[0]?.init?.body))).toEqual(body);
  expect(JSON.parse(result.stdout.join("\n"))).toEqual(DOC);
});

test.each([
  [["--link-id", "nope"]],
  [["add", "--link-id", LINK]],
  [["add", "--link-id", LINK, "--route", "-oProxyCommand=sh"]],
  [["order", "--link-id", LINK, "--routes", "alpha-lan,,pen-alpha"]],
  [["rename", "--link-id", LINK]],
  [["add", "--link-id", LINK, "--route", "alpha-lan", "--extra"]],
] as const)("usage errors send nothing: %j", async args => {
  const result = await run([...args]);
  expect(result.code).toBe(2);
  expect(result.calls).toHaveLength(0);
});

test.each([
  ["another link id", { ...DOC, linkId: "lnk_fedcba9876543210" }],
  ["a pin missing from the routes", { ...DOC, routes: ["alpha-lan"] }],
  ["an extra field", { ...DOC, extra: 1 }],
  ["a route that is not an alias", { ...DOC, routes: ["-x", "pen-alpha"] }],
] as const)("a response with %s is rejected", async (_label, body) => {
  const result = await run(["--link-id", LINK, "--json"], body);
  expect(result.code).toBe(1);
});

test("a refused add exits 5 and shows only the code and its fixed cause", async () => {
  const result = await run(["add", "--link-id", LINK, "--route", "alpha-lan", "--json"], { error: { code: "route_unproven", message: "The route did not prove the link's pinned host key.", cause: "hostkey" } }, 409);
  expect(result.code).toBe(5);
  expect(result.stderr.join("\n")).toContain("route_unproven (hostkey)");
});

test("an unknown cause word is not echoed", async () => {
  const result = await run(["add", "--link-id", LINK, "--route", "alpha-lan"], { error: { code: "route_unproven", message: "x", cause: "alpha-lan.example" } }, 409);
  expect(result.code).toBe(5);
  expect(result.stderr.join("\n")).not.toContain("alpha-lan.example");
});

test("an edit stored but not applied exits 1 and says the routes are stored and a restart applies them", async () => {
  const body = { error: { code: "routes_stored_reload_failed", message: "The routes were stored, but the running proxy did not apply them. Restart the proxy to apply them.", linkId: LINK, pin: "pen-alpha", routes: ["alpha-lan", "pen-alpha"] } };
  const result = await run(["add", "--link-id", LINK, "--route", "alpha-lan"], body, 500);
  expect(result.code).toBe(1);
  const stderr = result.stderr.join("\n");
  expect(stderr).toContain("routes_stored_reload_failed");
  expect(stderr).toContain("stored");
  expect(stderr).toContain("restart");
  expect(stderr).toContain("ocx link routes --link-id " + LINK + " reads them");
});

