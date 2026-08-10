export class LabValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LabValidationError";
    this.code = code;
  }
}
