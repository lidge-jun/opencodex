import { describe, expect, test } from "bun:test";
import {
  parseWmicCreationDate,
  parseWmicListRecords,
} from "../src/lib/windows-wmic";

describe("parseWmicListRecords", () => {
  test("parses real /format:list output with alphabetical key order", () => {
    // WMIC emits requested keys alphabetically per block: CommandLine,
    // CreationDate, Name, ProcessId — ProcessId CLOSES a record. The parser
    // must not attribute a record's fields to its predecessor.
    const output = [
      "\r",
      "\r",
      'CommandLine="C:\\tools\\codex.exe" app-server --serve\r',
      "CreationDate=20260808120000.000000+480\r",
      "Name=codex.exe\r",
      "ProcessId=41\r",
      "\r",
      "\r",
      'CommandLine="C:\\Windows\\System32\\cmd.exe" /c codex\r',
      "CreationDate=20260808120100.000000+480\r",
      "Name=cmd.exe\r",
      "ProcessId=42\r",
      "\r",
    ].join("\n");
    const records = parseWmicListRecords(output);
    expect(records).toEqual([
      {
        processId: 41,
        name: "codex.exe",
        commandLine: '"C:\\tools\\codex.exe" app-server --serve',
        creationDate: "20260808120000.000000+480",
      },
      {
        processId: 42,
        name: "cmd.exe",
        commandLine: '"C:\\Windows\\System32\\cmd.exe" /c codex',
        creationDate: "20260808120100.000000+480",
      },
    ]);
  });

  test("parses a final record without a trailing blank line", () => {
    const records = parseWmicListRecords([
      "CommandLine=codex app-server",
      "ProcessId=7",
    ].join("\n"));
    expect(records).toEqual([{ processId: 7, name: undefined, commandLine: "codex app-server", creationDate: undefined }]);
  });

  test("appends continuation lines to a multi-line CommandLine", () => {
    const records = parseWmicListRecords([
      "CommandLine=codex app-server",
      "--second-line",
      "ProcessId=9",
    ].join("\n"));
    expect(records[0]?.commandLine).toBe("codex app-server\n--second-line");
  });

  test("drops records with unusable ProcessIds", () => {
    for (const block of [
      "CommandLine=x\nProcessId=not-a-number",
      "CommandLine=x\nProcessId=9007199254740992",
      "CommandLine=x\nProcessId=1",
      "CommandLine=x",
    ]) {
      expect(parseWmicListRecords(block)).toEqual([]);
    }
  });

  test("a block without ProcessId never leaks fields into the next record", () => {
    const records = parseWmicListRecords([
      "CommandLine=orphan",
      "",
      "CommandLine=codex app-server",
      "ProcessId=5",
    ].join("\n"));
    expect(records).toEqual([
      { processId: 5, name: undefined, commandLine: "codex app-server", creationDate: undefined },
    ]);
  });
});

describe("parseWmicCreationDate", () => {
  test("converts a WMIC CreationDate with offset to epoch ms", () => {
    const value = parseWmicCreationDate("20260808120000.000000+480");
    expect(value).toBe(Date.UTC(2026, 7, 8, 12, 0, 0, 0) - 480 * 60_000);
  });

  test("handles fractional seconds and missing offset", () => {
    const value = parseWmicCreationDate("20260808120000.123456");
    expect(value).toBe(Date.UTC(2026, 7, 8, 12, 0, 0, 123));
  });

  test("returns null for unparseable values", () => {
    expect(parseWmicCreationDate(undefined)).toBeNull();
    expect(parseWmicCreationDate("")).toBeNull();
    expect(parseWmicCreationDate("garbage")).toBeNull();
    expect(parseWmicCreationDate("2026080812")).toBeNull();
  });
});
