export interface D1ResultMeta {
  changes: number;
  duration?: number;
  last_row_id?: number;
  changed_db?: boolean;
}

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  meta: D1ResultMeta;
  results?: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface ScheduledController {
  scheduledTime: number;
  cron?: string;
  noRetry?: () => void;
}

export interface CollectorEnv {
  DB: D1Database;
  RATE_LIMIT_SALT: string;
}

export type TelemetryStatsRange = "7d" | "30d" | "90d" | "365d";

export type TelemetryStatsV1 = {
  schemaVersion: 1;
  generatedAt: string;
  range: TelemetryStatsRange;
  totals: {
    activeInstalls: number;
    avgDailyActiveInstalls: number;
    newInstalls: number;
    activeMinutes: number;
    requests: number;
    tokens: {
      input: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
      reasoning: number;
    };
  };
  daily: Array<{
    day: string;
    activeInstalls: number;
    newInstalls: number;
    activeMinutes: number;
    requests: number;
    failed: number;
    tokens: number;
  }>;
  dailyByProvider: Array<{
    day: string;
    providerKind: string;
    requests: number;
    tokens: number;
  }>;
  heatmap: Array<{
    day: string;
    activeInstalls: number;
  }>;
  providers: Array<{
    providerKind: string;
    requests: number;
    tokens: number;
  }>;
  models: Array<{
    modelFamily: string;
    requests: number;
    tokens: number;
  }>;
  versions: Array<{
    version: string;
    installs: number;
    newInstalls: number;
  }>;
  platforms: Array<{
    os: string;
    arch: string;
    installs: number;
  }>;
  channels: Array<{
    installChannel: string;
    installs: number;
    newInstalls: number;
  }>;
  outcomes: {
    completed: number;
    failed: number;
    incomplete: number;
    aborted: number;
  };
  errors: Array<{
    cause: string;
    count: number;
  }>;
};
