export declare function planUpdateRuntimeHandling(input: {
  ownership: { owner: string; installId: string; consentGeneration: number } | null;
  ownershipUnknown?: boolean;
  serviceInstalled: boolean;
}): {
  mayReplacePackage: boolean;
  mayStopRuntime: boolean;
  mayRestoreService: boolean;
  notice: string | null;
};

export declare function planStoppedRuntimeRecovery(input: {
  stopAttempted: boolean;
  ownership: { owner: string; installId: string; consentGeneration: number } | null;
  ownershipUnknown?: boolean;
  sameOwner: boolean;
  liveness: "live" | "dead" | "unknown";
  serviceInstalled: boolean;
  launcherUsable: boolean;
  hadRuntimeState: boolean;
}): {
  action: "none" | "manual" | "service" | "direct";
  reason: string;
};

type RuntimeTarget = { port: number; hostname: string };
type RuntimeLiveness = "live" | "dead" | "unknown";

export declare function inspectPackageRuntimeLiveness(input: {
  capturedTarget: RuntimeTarget;
  readCurrentTarget():
    | { kind: "target"; target: RuntimeTarget }
    | { kind: "absent" }
    | { kind: "unknown" };
  probe(target: RuntimeTarget): RuntimeLiveness;
}): {
  current: RuntimeLiveness | "absent";
  captured: RuntimeLiveness;
  overall: RuntimeLiveness;
};
