/** Declaration for the plain-ESM runtime-ownership rule shared with `bin/ocx.mjs`. */
export declare function planUpdateRuntimeHandling(input: {
  ownership: { owner: string; installId: string; consentGeneration: number } | null;
  ownershipUnknown?: boolean;
  serviceInstalled: boolean;
}): {
  stopRuntime: boolean;
  refreshService: boolean;
  notice: string | null;
};
