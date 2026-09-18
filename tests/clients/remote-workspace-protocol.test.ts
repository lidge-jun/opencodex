import { describe, expect, test } from "bun:test";
import {
  parseRemoteWorkspaceAgentMessage,
  parseRemoteWorkspaceHubMessage,
  remoteWorkspaceToolsForCapabilities,
  serializeRemoteWorkspaceAgentMessage,
  truncateRemoteWorkspaceUtf8,
} from "../../src/remote-control";

describe("Remote Workspace protocol contracts", () => {
  test("presence carries the explicit read-only capability set", () => {
    const encoded = serializeRemoteWorkspaceAgentMessage({
      version: 1, type: "presence", capabilities: ["workspace.read"],
    });
    expect(parseRemoteWorkspaceAgentMessage(encoded)).toEqual({
      version: 1, type: "presence", capabilities: ["workspace.read"],
    });
    expect(remoteWorkspaceToolsForCapabilities(["workspace.read"])).toEqual([
      "list_directory", "read_file",
    ]);
  });

  test("rejects unknown fields, versions and capabilities at the wire boundary", () => {
    for (const value of [
      { version: 2, type: "presence", capabilities: ["workspace.read"] },
      { version: 1, type: "presence", capabilities: ["workspace.admin"] },
      { version: 1, type: "presence", capabilities: ["workspace.read"], root: "/" },
    ]) expect(() => parseRemoteWorkspaceAgentMessage(JSON.stringify(value))).toThrow();
    expect(() => parseRemoteWorkspaceHubMessage(JSON.stringify({
      version: 1, type: "ciphertext", sessionId: "not-a-session", payload: "A".repeat(32),
    }))).toThrow("session ID");
  });

  test("refuses oversized control messages before interpreting their fields", () => {
    expect(() => parseRemoteWorkspaceAgentMessage(" ".repeat(96 * 1024 + 1))).toThrow("length");
  });

  test("UTF-8 limits preserve complete scalar values at byte boundaries", () => {
    expect(truncateRemoteWorkspaceUtf8("A😀한", 4)).toBe("A");
    expect(truncateRemoteWorkspaceUtf8("A😀한", 5)).toBe("A😀");
    expect(truncateRemoteWorkspaceUtf8("A😀한", 8)).toBe("A😀한");
    expect(truncateRemoteWorkspaceUtf8("한", 0)).toBe("");
    expect(() => truncateRemoteWorkspaceUtf8("x", -1)).toThrow("limit");
  });
});
