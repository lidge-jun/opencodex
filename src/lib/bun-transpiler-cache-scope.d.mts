export declare const TRANSPILER_CACHE_ENV: "BUN_RUNTIME_TRANSPILER_CACHE_PATH";

export declare function scopeTranspilerCacheToRuntime<T extends Record<string, string | undefined>>(
  env: T,
  runtimeVersion: string | null | undefined,
  join: (...parts: string[]) => string,
  platform?: NodeJS.Platform,
): T;
