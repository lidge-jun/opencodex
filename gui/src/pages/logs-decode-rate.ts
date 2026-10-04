/** Older cached DTOs have no timing basis. Do not infer one from other row fields. */
export function decodeRateLabelKeys(result: { timingBasis?: string }) {
  switch (result.timingBasis) {
    case "generation-window":
      return { short: "logs.decodeBasis.generation", detail: "logs.detail.decodeGeneration" } as const;
    case "legacy-post-visible-output":
      return { short: "logs.decodeBasis.legacy", detail: "logs.detail.decodeLegacy" } as const;
    default:
      return { short: "logs.decodeBasis.unknown", detail: "logs.detail.decodeUnknown" } as const;
  }
}
