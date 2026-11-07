import { expect, test } from "bun:test";
import { recentFailures } from "../src/pages/home-failures";
import { classifyRequestOutcome } from "../../src/usage/request-outcome";

/*
 * Home's "errors today" headline counts the same rows the Logs page counts as failed: both read
 * the shared outcome classifier, so a client cancel is not an error on one page and fine on the other.
 */
const NOW = 1_000_000;
const rows = [
  { id: "ok", timestamp: NOW, status: 200 },
  { id: "server-error", timestamp: NOW, status: 502 },
  { id: "client-cancel", timestamp: NOW, status: 499 },
  { id: "cancel-reason", timestamp: NOW, status: 200, closeReason: "client_cancel" as const },
  { id: "failed-terminal", timestamp: NOW, status: 200, terminalStatus: "failed" },
  { id: "incomplete", timestamp: NOW, status: 200, terminalStatus: "incomplete" },
  { id: "old-error", timestamp: NOW - 10, status: 500 },
];

test("Home counts failures with the shared classifier, within the window", () => {
  expect(recentFailures(rows, NOW - 1).map(row => row.id)).toEqual(["server-error", "failed-terminal"]);
});

test("Home and Logs agree on every row in the window", () => {
  const inWindow = rows.filter(row => row.timestamp >= NOW - 1);
  const logsFailed = inWindow.filter(row => classifyRequestOutcome(row) === "failed").map(row => row.id);
  expect(recentFailures(rows, NOW - 1).map(row => row.id)).toEqual(logsFailed);
});

test("a 499 client cancel is not an error on Home", () => {
  expect(recentFailures([{ timestamp: NOW, status: 499 }], 0)).toEqual([]);
});
