import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type {
  CollectorEnv,
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../services/telemetry-collector/src/types";
import { repoPath } from "./repo-root";

export interface InMemoryD1Harness {
  sqlite: Database;
  db: D1Database;
  env: CollectorEnv;
  batchCalls: number[];
  close: () => void;
}

export function createInMemoryD1(salt = "test-rate-limit-salt"): InMemoryD1Harness {
  const sqlite = new Database(":memory:");
  const schemaSql = readFileSync(
    repoPath("services", "telemetry-collector", "schema.sql"),
    "utf8",
  );
  sqlite.exec(schemaSql);
  const batchCalls: number[] = [];

  function makeStatement(query: string, boundValues: unknown[] = []): D1PreparedStatement & { isSelect: () => boolean } {
    const executeRun = <T = Record<string, unknown>>(): D1Result<T> => {
      const stmt = sqlite.query(query);
      const info = stmt.run(...(boundValues as never[]));
      return {
        success: true,
        meta: {
          changes: Number(info.changes ?? 0),
          last_row_id: Number(info.lastInsertRowid ?? 0),
          changed_db: Number(info.changes ?? 0) > 0,
        },
      };
    };

    return {
      isSelect(): boolean {
        return sqlite.query(query).columnNames.length > 0;
      },
      bind(...values: unknown[]): D1PreparedStatement {
        return makeStatement(query, values);
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        return executeRun<T>();
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const stmt = sqlite.query(query);
        const results = stmt.all(...(boundValues as never[])) as T[];
        return {
          success: true,
          meta: { changes: 0 },
          results,
        };
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const stmt = sqlite.query(query);
        const row = stmt.get(...(boundValues as never[])) as Record<string, unknown> | null;
        if (!row) return null;
        if (colName !== undefined) {
          return ((row[colName] as T | undefined) ?? null);
        }
        return row as T;
      },
    };
  }

  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      return makeStatement(query);
    },
    async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      batchCalls.push(statements.length);
      const out: D1Result<T>[] = [];
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const stmt of statements) {
          const inspectable = stmt as D1PreparedStatement & { isSelect?: () => boolean };
          if (typeof inspectable.isSelect === "function" && inspectable.isSelect()) {
            out.push(await stmt.all<T>());
          } else {
            out.push(await stmt.run<T>());
          }
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return out;
    },
  };

  return {
    sqlite,
    db,
    env: { DB: db, RATE_LIMIT_SALT: salt },
    batchCalls,
    close: () => sqlite.close(),
  };
}

export function postEventRequest(
  body: string | Uint8Array,
  options: {
    ip?: string;
    origin?: string;
    contentType?: string;
    contentLength?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.contentType !== "") {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  if (options.ip) {
    headers.set("cf-connecting-ip", options.ip);
  }
  if (options.origin) {
    headers.set("origin", options.origin);
  }
  if (options.contentLength) {
    headers.set("content-length", options.contentLength);
  }
  return new Request("https://telemetry.opencodex.me/v1/events", {
    method: "POST",
    headers,
    body,
  });
}
