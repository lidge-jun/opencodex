import { describe, expect, test } from "bun:test";
import { formatUptime } from "../gui/src/formatUptime";

describe("dashboard uptime formatting", () => {
  test("keeps short uptimes in seconds", () => {
    expect(formatUptime(0, "ko")).toBe("0초");
    expect(formatUptime(299.9, "ko")).toBe("299초");
  });

  test("uses minutes after five minutes", () => {
    expect(formatUptime(300, "ko")).toBe("5분");
    expect(formatUptime(3599, "ko")).toBe("59분");
  });

  test("uses hours and minutes after one hour", () => {
    expect(formatUptime(3600, "ko")).toBe("1시간");
    expect(formatUptime(64685, "ko")).toBe("17시간 58분");
  });

  test("uses days and hours after one day", () => {
    expect(formatUptime(86400, "ko")).toBe("1일");
    expect(formatUptime(183600, "ko")).toBe("2일 3시간");
  });

  test("uses compact localized units", () => {
    expect(formatUptime(3720, "en")).toBe("1h 2m");
    expect(formatUptime(93600, "zh")).toBe("1天 2小时");
  });
});
