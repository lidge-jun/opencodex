/** An internally constructed local refusal after a native response has already started. */
export class NativeContinuationRefusalError extends Error {
  /** Keep the original response's process-local provenance and refusal headers. */
  constructor(readonly response: Response) {
    super("Native continuation refused before dispatch");
    this.name = "NativeContinuationRefusalError";
  }
}
