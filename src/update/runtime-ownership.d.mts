/** Declaration for the plain-ESM runtime-ownership rule shared with `bin/ocx.mjs`. */
export declare function parseRecordedOwnership(raw: string | null | undefined): {
  owner: string;
  installId: string;
  consentGeneration: number;
} | null;

export declare function planUpdateRuntimeHandling(input: {
  ownership: { owner: string; installId: string; consentGeneration: number } | null;
  ownershipUnknown?: boolean;
  serviceInstalled: boolean;
}): {
  stopRuntime: boolean;
  refreshService: boolean;
  notice: string | null;
};
