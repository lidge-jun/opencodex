import { describe, expect, test } from "bun:test";
import {
  STOPPED_CLOUDFLARE_TUNNEL,
  canToggleTunnel,
  endpointFromApiPayload,
  isTunnelEnabled,
  isTunnelTransitioning,
  tunnelFromApiPayload,
  tunnelStatusTone,
} from "../gui/src/cloudflare-tunnel";

describe("Cloudflare tunnel UI state", () => {
  test("reads tunnel state from both management API response shapes", () => {
    const running = {
      status: "running",
      mode: "named",
      publicUrl: "https://api.example.com",
      supportsSse: true,
      enabled: true,
      canEnable: true,
    } as const;

    expect(tunnelFromApiPayload({ tunnel: running })).toEqual(running);
    expect(tunnelFromApiPayload(running)).toEqual(running);
  });

  test("keeps the last valid state when a partial payload omits fields", () => {
    const fallback = {
      status: "running",
      mode: "named",
      publicUrl: "https://api.example.com",
      supportsSse: true,
      enabled: true,
      canEnable: true,
    } as const;

    expect(tunnelFromApiPayload({ status: "stopping" }, fallback)).toEqual({
      ...fallback,
      status: "stopping",
    });
    expect(tunnelFromApiPayload(null)).toEqual(STOPPED_CLOUDFLARE_TUNNEL);
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
    const canEnable = { ...STOPPED_CLOUDFLARE_TUNNEL, canEnable: true };
    expect(canToggleTunnel(starting, false)).toBe(false);
    expect(canToggleTunnel(STOPPED_CLOUDFLARE_TUNNEL, false)).toBe(false);
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
  });

  test("maps every status to a semantic badge tone", () => {
    expect(tunnelStatusTone("stopped")).toBe("muted");
    expect(tunnelStatusTone("starting")).toBe("amber");
    expect(tunnelStatusTone("running")).toBe("green");
    expect(tunnelStatusTone("stopping")).toBe("amber");
    expect(tunnelStatusTone("error")).toBe("red");
  });
});
