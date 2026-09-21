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
