import { describe, expect, test } from "bun:test";
import { runLinkCommand, type LinkStatusPayload } from "../../src/cli/link";
import type { LinkStore } from "../../src/link/store";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { DISPATCH_COMMANDS } from "../../src/cli/dispatch";
import { findCommand } from "../../src/cli/registry";

type RequestCall = { url: string; init: RequestInit | undefined };

function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  return {
    stdout,
    stderr,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function fakeFetch(body: unknown, calls: RequestCall[], status = 200): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

const issueResponse = {
  linkId: "lnk_0123456789abcdef",
  apiKeyId: "key-link-1",
  key: "ocx_data_0123456789012345678901234567890123456789",
  listenerPort: 19100,
};

const statusResponse: LinkStatusPayload = {
  role: "home",
  listener: { state: "listening", port: 19100 },
  links: [{
    id: issueResponse.linkId,
    alias: "child-home",
    direction: "hub-initiated",
    state: "connected",
    since: "2026-09-25T00:00:00.000Z",
    reason: null,
    tunnelPort: 19200,
  }],
  child: null,
};

describe("ocx link", () => {
  test("port prints one JSON document and no diagnostics", async () => {
    const output = captureOutput();
    try {
      const code = await runLinkCommand(["port", "--json"], { choosePort: async () => 19300 });
      expect(code).toBe(0);
      expect(output.stdout).toEqual([JSON.stringify({ port: 19300 })]);
      expect(output.stderr).toEqual([]);
    } finally {
      output.restore();
    }
  });

  test("issue posts the loopback admin header and prints the exact K2 payload", async () => {
    const calls: RequestCall[] = [];
    const output = captureOutput();
    try {
      const code = await runLinkCommand(["issue", "--alias", "child-home", "--tunnel-port", "19200", "--json"], {
        baseUrl: "http://127.0.0.1:19101",
        fetchImpl: fakeFetch(issueResponse, calls),
        readAdminToken: () => "ocx_admin_test-token",
      });
      expect(code).toBe(0);
      expect(JSON.parse(output.stdout.join("\n"))).toEqual(issueResponse);
      expect(output.stderr).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:19101/api/link/issue");
      expect(new Headers(calls[0]?.init?.headers).get("x-opencodex-api-key")).toBe("ocx_admin_test-token");
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ alias: "child-home", tunnelPort: 19200 });
    } finally {
      output.restore();
    }
  });

  test("rejects a malformed issue response without exposing its key on stderr", async () => {
    const calls: RequestCall[] = [];
    const output = captureOutput();
    const malformed = { ...issueResponse, extra: "unexpected" };
    try {
      const code = await runLinkCommand(["issue", "--alias", "child-home", "--tunnel-port", "19200"], {
        baseUrl: "http://127.0.0.1:19101",
        fetchImpl: fakeFetch(malformed, calls),
        readAdminToken: () => "ocx_admin_test-token",
      });
      expect(code).toBe(1);
      expect(output.stdout).toEqual([]);
      expect(output.stderr.join("\n")).not.toContain(issueResponse.key);
    } finally {
      output.restore();
    }
  });

  test("status uses the running management API and validates the K16 payload", async () => {
    const calls: RequestCall[] = [];
    const output = captureOutput();
    try {
      const code = await runLinkCommand(["status", "--json"], {
        baseUrl: "http://127.0.0.1:19101",
        fetchImpl: fakeFetch(statusResponse, calls),
        readAdminToken: () => "ocx_admin_test-token",
      });
      expect(code).toBe(0);
      expect(JSON.parse(output.stdout[0]!)).toEqual(statusResponse);
      expect(calls[0]?.url).toBe("http://127.0.0.1:19101/api/link/status");
      expect(new Headers(calls[0]?.init?.headers).get("x-opencodex-api-key")).toBe("ocx_admin_test-token");
    } finally {
      output.restore();
    }
  });

  test("offline status projects the local store with idle link states", async () => {
    const store: LinkStore = {
      version: 1,
      listenerPort: 19100,
      links: [{
        id: issueResponse.linkId,
        alias: "child-home",
        direction: "hub-initiated",
        hostKeyFingerprint: "SHA256:abcdefghijklmnop",
        tunnelPort: 19200,
        apiKeyId: issueResponse.apiKeyId,
        createdAt: "2026-09-25T00:00:00.000Z",
      }],
    };
    const output = captureOutput();
    try {
      const code = await runLinkCommand(["status"], {
        findLiveProxy: async () => null,
        readStore: () => store,
      });
      expect(code).toBe(0);
      expect(JSON.parse(output.stdout[0]!)).toEqual({
        role: "home",
        listener: { state: "listening", port: 19100 },
        links: [{
          id: issueResponse.linkId,
          alias: "child-home",
          direction: "hub-initiated",
          state: "idle",
          since: "2026-09-25T00:00:00.000Z",
          reason: null,
          tunnelPort: 19200,
        }],
        child: null,
      });
    } finally {
      output.restore();
    }
  });

  test("revoke sends DELETE and prints only the link id", async () => {
    const calls: RequestCall[] = [];
    const output = captureOutput();
    try {
      const code = await runLinkCommand(["revoke", "--link-id", issueResponse.linkId, "--json"], {
        baseUrl: "http://127.0.0.1:19101",
        fetchImpl: fakeFetch({ linkId: issueResponse.linkId }, calls),
        readAdminToken: () => "ocx_admin_test-token",
      });
      expect(code).toBe(0);
      expect(JSON.parse(output.stdout[0]!)).toEqual({ linkId: issueResponse.linkId });
      expect(calls[0]?.url).toBe(`http://127.0.0.1:19101/api/link/${issueResponse.linkId}`);
      expect(calls[0]?.init?.method).toBe("DELETE");
    } finally {
      output.restore();
    }
  });

  test("revoke of a link the Home no longer has succeeds, and any other 404 still fails", async () => {
    const output = captureOutput();
    try {
      const gone = await runLinkCommand(["revoke", "--link-id", issueResponse.linkId, "--json"], {
        baseUrl: "http://127.0.0.1:19101",
        fetchImpl: fakeFetch({ error: { code: "link_not_found", message: "The link was not found." } }, [], 404),
        readAdminToken: () => "ocx_admin_test-token",
      });
      expect(gone).toBe(0);
      expect(JSON.parse(output.stdout[0]!)).toEqual({ linkId: issueResponse.linkId });
      const unrouted = await runLinkCommand(["revoke", "--link-id", issueResponse.linkId, "--json"], {
        baseUrl: "http://127.0.0.1:19101",
        fetchImpl: fakeFetch({ error: { message: "not found" } }, [], 404),
        readAdminToken: () => "ocx_admin_test-token",
      });
      expect(unrouted).not.toBe(0);
      const refused = await runLinkCommand(["revoke", "--link-id", issueResponse.linkId, "--json"], {
        baseUrl: "http://127.0.0.1:19101",
        fetchImpl: fakeFetch({ error: { code: "key_revoke_failed" } }, [], 502),
        readAdminToken: () => "ocx_admin_test-token",
      });
      expect(refused).not.toBe(0);
      expect(output.stdout).toHaveLength(1);
    } finally {
      output.restore();
    }
  });

  test("rejects malformed status responses", async () => {
    const output = captureOutput();
    try {
      const code = await runLinkCommand(["status"], {
        baseUrl: "http://127.0.0.1:19101",
        fetchImpl: fakeFetch({ ...statusResponse, child: { alias: "x" } }, []),
        readAdminToken: () => "ocx_admin_test-token",
      });
      expect(code).toBe(1);
      expect(output.stdout).toEqual([]);
      expect(output.stderr.join("\n")).toContain("invalid link API response");
    } finally {
      output.restore();
    }
  });

  test("registers the canonical command and all four capability leaves", () => {
    expect(findCommand("link")?.name).toBe("link");
    expect(DISPATCH_COMMANDS).toContain("link");
    expect(CAPABILITIES.filter(cap => cap.command[0] === "link").map(cap => cap.command.join(" "))).toEqual([
      "link port",
      "link issue",
      "link status",
      "link revoke",
    ]);
  });
});
