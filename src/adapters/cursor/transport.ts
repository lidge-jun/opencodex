import type { OcxProviderConfig } from "../../types";
import type { CursorClientMessage, CursorRunRequest, CursorServerMessage } from "./types";

export interface CursorTransport {
  run(request: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorServerMessage>;
  writeClient(message: CursorClientMessage): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface CursorTransportFactoryInput {
  provider: OcxProviderConfig;
  headers?: Headers;
}

export type CursorTransportFactory = (input: CursorTransportFactoryInput) => CursorTransport;

export class CursorTransportDisabledError extends Error {
  readonly code = "cursor_transport_disabled";

  constructor(message = "live Cursor transport is disabled") {
    super(message);
    this.name = "CursorTransportDisabledError";
  }
}

export function createDisabledCursorTransport(): CursorTransport {
  return {
    async *run() {
      throw new CursorTransportDisabledError();
    },
    writeClient() {},
    close() {},
  };
}
