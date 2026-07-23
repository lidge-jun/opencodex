import { describe, it, expect } from "vitest";

// Inline the format functions since they live in the component files
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

describe("formatTokens", () => {
  it("formats small numbers as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with K suffix", () => {
    expect(formatTokens(1_000)).toBe("1.0K");
    expect(formatTokens(12_345)).toBe("12.3K");
    expect(formatTokens(999_999)).toBe("1000.0K");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_100_000)).toBe("2.1M");
    expect(formatTokens(15_500_000)).toBe("15.5M");
  });
});

describe("formatUptime", () => {
  it("formats minutes only", () => {
    expect(formatUptime(0)).toBe("0m");
    expect(formatUptime(300)).toBe("5m");
    expect(formatUptime(3599)).toBe("59m");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(3600)).toBe("1h 0m");
    expect(formatUptime(5400)).toBe("1h 30m");
    expect(formatUptime(86399)).toBe("23h 59m");
  });

  it("formats days and hours", () => {
    expect(formatUptime(86400)).toBe("1d 0h");
    expect(formatUptime(259200)).toBe("3d 0h");
    expect(formatUptime(345600)).toBe("4d 0h");
  });
});
