import { describe, expect, test } from "bun:test";
import {
  STOPPED_CLOUDFLARE_TUNNEL,
  buildCloudflareTunnelSetupRequest,
  buildCloudflareTunnelToggleRequest,
  canReconfigureTunnel,
  canToggleTunnel,
  endpointFromApiPayload,
  isTunnelEnabled,
  isTunnelTransitioning,
  shouldOpenTunnelSetup,
  tunnelFromApiPayload,
  tunnelStatusTone,
} from "../gui/src/cloudflare-tunnel";

describe("Cloudflare tunnel UI state", () => {
  test("reads tunnel state from both management API response shapes", () => {
    const running = {
      ...STOPPED_CLOUDFLARE_TUNNEL,
      status: "running",
      mode: "named",
      publicUrl: "https://api.example.com",
      configuredPublicUrl: "https://api.example.com",
      originUrl: "http://127.0.0.1:10100",
      configurationSource: "api",
      supportsSse: true,
      enabled: true,
      canEnable: true,
      canConfigure: true,
      configured: true,
      setupRequired: false,
    } as const;

    expect(tunnelFromApiPayload({ tunnel: running })).toEqual(running);
    expect(tunnelFromApiPayload(running)).toEqual(running);
  });

  test("keeps the last valid state when a partial payload omits fields", () => {
    const fallback = {
      ...STOPPED_CLOUDFLARE_TUNNEL,
      status: "running",
      mode: "named",
      publicUrl: "https://api.example.com",
      supportsSse: true,
      enabled: true,
      canEnable: true,
      canConfigure: true,
      configured: true,
      setupRequired: false,
    } as const;

    expect(tunnelFromApiPayload({ status: "stopping" }, fallback)).toEqual({
      ...fallback,
      status: "stopping",
    });
    expect(tunnelFromApiPayload(null)).toEqual(STOPPED_CLOUDFLARE_TUNNEL);
  });

  test("defaults unconfigured public access to a streaming-capable Named Tunnel", () => {
    expect(STOPPED_CLOUDFLARE_TUNNEL).toMatchObject({
      mode: "named",
      supportsSse: true,
      configured: false,
      setupRequired: true,
    });
    expect(shouldOpenTunnelSetup(STOPPED_CLOUDFLARE_TUNNEL)).toBe(true);
    expect(shouldOpenTunnelSetup({
      ...STOPPED_CLOUDFLARE_TUNNEL,
      configured: true,
      setupRequired: false,
    })).toBe(false);
  });

  test("keeps an explicitly selected legacy Quick Tunnel usable for advanced debugging", () => {
    const quick = tunnelFromApiPayload({
      status: "stopped",
      mode: "quick",
      publicUrl: null,
      supportsSse: false,
      enabled: false,
      canEnable: true,
    });

    expect(quick).toMatchObject({ configured: true, setupRequired: false, canConfigure: true });
    expect(shouldOpenTunnelSetup(quick)).toBe(false);
    expect(canToggleTunnel(quick, false)).toBe(true);
  });

  test("uses only the backend endpoint and preserves the previous value when absent", () => {
    expect(endpointFromApiPayload({ endpoint: "https://api.example.com/v1/responses" }, "local"))
      .toBe("https://api.example.com/v1/responses");
    expect(endpointFromApiPayload({}, "http://127.0.0.1:10100/v1/responses"))
      .toBe("http://127.0.0.1:10100/v1/responses");
  });

  test("disables duplicate transitions and follows the backend admission capability", () => {
    const starting = { ...STOPPED_CLOUDFLARE_TUNNEL, status: "starting" as const };
    const running = {
      ...STOPPED_CLOUDFLARE_TUNNEL,
      status: "running" as const,
      publicUrl: "https://random.trycloudflare.com",
      enabled: true,
    };

    expect(isTunnelTransitioning(starting.status)).toBe(true);
    const canConfigure = { ...STOPPED_CLOUDFLARE_TUNNEL, canConfigure: true };
    const canEnable = {
      ...STOPPED_CLOUDFLARE_TUNNEL,
      configured: true,
      setupRequired: false,
      canEnable: true,
    };
    expect(canToggleTunnel(starting, false)).toBe(false);
    expect(canToggleTunnel(STOPPED_CLOUDFLARE_TUNNEL, false)).toBe(false);
    expect(canToggleTunnel(canConfigure, false)).toBe(true);
    expect(canToggleTunnel(canEnable, false)).toBe(true);
    expect(isTunnelEnabled(running)).toBe(true);
    expect(canToggleTunnel(running, false)).toBe(true);
  });

  test("keeps an enabled error state closable so persisted access can be cleared", () => {
    const failed = {
      ...STOPPED_CLOUDFLARE_TUNNEL,
      status: "error" as const,
      enabled: true,
      error: "cloudflared exited",
    };

    expect(isTunnelEnabled(failed)).toBe(true);
    expect(canToggleTunnel(failed, false)).toBe(true);
    expect(shouldOpenTunnelSetup(failed)).toBe(false);
  });

  test("allows local Named credentials to be rotated only while public access is inactive", () => {
    const local = {
      ...STOPPED_CLOUDFLARE_TUNNEL,
      canConfigure: true,
      canEnable: true,
      configured: true,
      setupRequired: false,
      configurationSource: "local",
      configuredPublicUrl: "https://api.example.com",
    };
    expect(canReconfigureTunnel(local, false)).toBe(true);
    expect(canReconfigureTunnel(local, true)).toBe(false);
    expect(canReconfigureTunnel({ ...local, enabled: true }, false)).toBe(false);
    expect(canReconfigureTunnel({ ...local, configurationSource: "environment" }, false)).toBe(false);
    expect(canReconfigureTunnel({ ...local, configurationEditable: false }, false)).toBe(false);
  });

  test("builds the automatic Named Tunnel setup request without retaining whitespace", () => {
    expect(buildCloudflareTunnelSetupRequest("api", {
      accountId: " account-id ",
      zoneId: " zone-id ",
      hostname: " api.example.com ",
      apiToken: " token ",
      tunnelName: "  ",
    })).toEqual({
      method: "api",
      accountId: "account-id",
      zoneId: "zone-id",
      hostname: "api.example.com",
      apiToken: "token",
      enable: true,
    });
    expect(buildCloudflareTunnelSetupRequest("api", {
      accountId: "account-id",
      zoneId: "zone-id",
      hostname: "new.example.com",
      apiToken: "token",
      replaceExisting: true,
    })).toMatchObject({ replaceExisting: true, enable: true });
  });

  test("builds setup for an existing tunnel from a token or install command", () => {
    expect(buildCloudflareTunnelSetupRequest("token", {
      publicUrl: " https://api.example.com ",
      tunnelToken: " cloudflared service install eyToken ",
    })).toEqual({
      method: "token",
      publicUrl: "https://api.example.com",
      tunnelToken: "cloudflared service install eyToken",
      enable: true,
    });
  });

  test("builds a one-click Quick Tunnel enable request as an explicit mode", () => {
    expect(buildCloudflareTunnelToggleRequest(true, "quick")).toEqual({
      enabled: true,
      mode: "quick",
    });
    expect(buildCloudflareTunnelToggleRequest(false, "quick")).toEqual({
      enabled: false,
    });
  });

  test("maps every status to a semantic badge tone", () => {
    expect(tunnelStatusTone("stopped")).toBe("muted");
    expect(tunnelStatusTone("starting")).toBe("amber");
    expect(tunnelStatusTone("running")).toBe("green");
    expect(tunnelStatusTone("stopping")).toBe("amber");
    expect(tunnelStatusTone("error")).toBe("red");
  });
});
