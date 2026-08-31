export declare const PENDING_TEARDOWN_PREFIX: string;
export declare const PENDING_TEARDOWN_SUFFIX: string;
export declare const PENDING_TEARDOWN_UNREADABLE_SUFFIX: string;
export declare function isPendingTeardownFileName(name: unknown): boolean;
export declare function isQuarantinedTeardownFileName(name: unknown): boolean;
export declare function isAnyTeardownObligationFileName(name: unknown): boolean;
export declare function pendingTeardownNonceFromFileName(name: string): string | null;
export declare function hasPendingTeardownIn(readdir: (dir: string) => string[], dir: string): boolean;
