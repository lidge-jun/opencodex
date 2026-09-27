export declare const PNPM_READ_CWD: string;
/** The callback must complete synchronously before its temporary workspace is cleaned. */
export declare function withPnpmCommandCwd<T>(args: readonly string[], run: (cwd: string) => T): T;
export declare function pnpmReadEnvironment(env?: Record<string, string | undefined>): Record<string, string | undefined>;
