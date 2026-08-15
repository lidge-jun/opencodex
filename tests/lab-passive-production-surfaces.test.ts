import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLabCommand } from "../src/cli/lab";
import {
  LAB_QUERY_MAX_PAGE_SIZE,
  PASSIVE_PRODUCTION_MAX_LIMIT,
} from "../src/lab/query";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";

const HOMES: string[] = [];
const originalOpenCodexHome = process.env.OPENCODEX_HOME;

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-passive-surfaces-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
});

function config(): OcxConfig {
  return { providers: {} } as OcxConfig;
}

async function apiGet(home: string, path: string): Promise<Response> {
  process.env.OPENCODEX_HOME = home;
  const req = new ManagementRequest(`http://127.0.0.1${path}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), config(), {
    refreshCodexCatalog: async () => {},
  });
  expect(response).not.toBeNull();
  return response!;
}

describe("CL-09 passive production read surfaces", () => {
  test("management API uses the passive query limit without widening generic Lab pages", async () => {
    const home = tempHome();
    const subjectId = "a".repeat(64);

    const accepted = await apiGet(
      home,
      `/api/lab/production-signals?subjectId=${subjectId}&limit=${PASSIVE_PRODUCTION_MAX_LIMIT}`,
    );
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as {
      signals: unknown[];
      summary: { recentProductionAttempts: number };
    };
    expect(acceptedBody.signals).toEqual([]);
    expect(acceptedBody.summary.recentProductionAttempts).toBe(0);

    const tooHigh = await apiGet(
      home,
      `/api/lab/production-signals?subjectId=${subjectId}&limit=${PASSIVE_PRODUCTION_MAX_LIMIT + 1}`,
    );
    expect(tooHigh.status).toBe(400);
    const tooHighBody = await tooHigh.json() as { error: { code: string; message: string } };
    expect(tooHighBody.error.code).toBe("invalid_limit");
    expect(tooHighBody.error.message).toContain(`1 to ${PASSIVE_PRODUCTION_MAX_LIMIT}`);

    const generic = await apiGet(home, `/api/lab/verdicts?limit=${LAB_QUERY_MAX_PAGE_SIZE + 1}`);
    expect(generic.status).toBe(400);
    const genericBody = await generic.json() as { error: { code: string; message: string } };
    expect(genericBody.error.code).toBe("invalid_limit");
    expect(genericBody.error.message).toContain(`1 to ${LAB_QUERY_MAX_PAGE_SIZE}`);
  });

  test("CLI reports malformed passive subject ids as the actual usage error", async () => {
    const home = tempHome();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      expect(await handleLabCommand(
        ["production-signals", "--subject", "not-a-subject-id"],
        { configDir: home },
      )).toBe(2);
      expect(errors.join("\n")).toContain("--subject must be an exact Lab route subject id");
      expect(errors.join("\n")).not.toContain("lab read failed");
    } finally {
      console.error = originalError;
    }
  });
});
