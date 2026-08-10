import { describe, expect, test } from "bun:test";
import { printSubcommandUsage } from "../src/cli/help";

describe("ocx help allowance", () => {
  test("printSubcommandUsage allowance mentions snapshot commands", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      printSubcommandUsage("allowance");
    } finally {
      console.log = log;
    }
    const text = lines.join("\n");
    expect(text).toContain("ocx allowance");
    expect(text).toContain("snapshot");
    expect(text).toContain("clear-reservations");
  });
});
