export type Holder = "sync" | "update" | "free" | "unknown";
export type Observation = "free" | "active" | "unknown";
export type Acquisition = { kind: "acquired"; release(): void } | { kind: "busy"; holder: Exclude<Holder, "free"> };
export declare function tryAcquireUpdateSyncMutex(home: string, kind: "sync" | "update", deps?: { now?: () => number; processAlive?: (pid: number) => boolean }): Acquisition;
export declare function inspectUpdateSyncMutex(home: string): Holder;
export declare function inspectUpdateMarker(home: string): Observation;
export declare function isUpdateInFlight(home: string, deps?: { mutex(home: string): Holder; ownershipLease(home: string): Observation; marker(home: string): Observation }): boolean;
