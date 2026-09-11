/*
 * Derived from rsvedant/opencode-windsurf-auth (src/cloud-direct/), MIT licensed,
 * Copyright (c) 2026 Vedant. The full notice is in ./index.ts.
 */
/**
 * `exa.codeium_common_pb.Metadata` proto builder.
 *
 * Field numbers come from src/plugin/discovery.ts (which reads the bundled
 * extension.js for live numbers). For cloud-direct we hard-code the canonical
 * set of fields the LS always populates — the IDE-extracted dynamic numbers
 * would help if Windsurf renumbers, but we don't have a way to refresh those
 * without the bundled extension.js path being present.
 *
 * Captured from real LS upstream traffic via mitm reverse-proxy. See
 * docs/CLOUD_DIRECT.md → "The exact captured request body (annotated)".
 */

import {
  encodeMessage,
  encodeString,
  encodeTimestampBody,
  encodeVarintField,
} from './wire.js';

/**
 * extension_version + ide_version sent to the cloud. It MUST be a string the
 * cloud recognizes as a real client release: an unknown version comes back as
 * an opaque "an internal error occurred", with no hint that the version is what
 * it objected to.
 *
 * Pinned to the version the shipped desktop client reports
 * (`product.json` -> `windsurfVersion`) rather than to anything of ours. The
 * previous pin of "2.0.0" predates the Devin rebrand and no longer chats.
 * `OPENCODEX_DEVIN_CLIENT_VERSION` overrides it, which is the escape hatch when
 * Cognition retires a version before this constant is updated.
 */
const WINDSURF_VERSION_STRING = process.env.OPENCODEX_DEVIN_CLIENT_VERSION?.trim() || '3.9.19';

export interface MetadataInput {
  /** Persistent api_key from OAuth (`devin-session-token$<JWT>`). */
  apiKey: string;
  /** Fresh user_jwt from GetUserJwt — required for chat methods. */
  userJwt?: string;
  /** UUID — one per opencode session is fine. */
  sessionId: string;
  /** Monotonic, milliseconds since epoch. */
  requestId: bigint;
  /** UUID — one per RPC call. */
  triggerId: string;
  /** Optional override for the version string. Cosmetic. */
  windsurfVersion?: string;
  /** Optional override for the host OS string. */
  osName?: string;
}

function osString(): string {
  switch (process.platform) {
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    case 'win32': return 'windows';
    default: return String(process.platform);
  }
}

export function buildMetadata(input: MetadataInput): Buffer {
  const version = input.windsurfVersion ?? WINDSURF_VERSION_STRING;
  const os = input.osName ?? osString();
  const parts: Buffer[] = [
    encodeString(1, 'windsurf'),                     // ide_name
    encodeString(2, version),                         // extension_version
    encodeString(3, input.apiKey),                    // api_key
    encodeString(4, 'en'),                            // locale
    encodeString(5, os),                              // os
    encodeString(7, version),                         // ide_version
    encodeVarintField(9, input.requestId),            // request_id (uint64 monotonic)
    encodeString(10, input.sessionId),                // session_id
    encodeString(12, 'windsurf'),                     // extension_name
    encodeMessage(16, encodeTimestampBody()),         // ls_timestamp (google.protobuf.Timestamp)
    encodeString(25, input.triggerId),                // trigger_id
    encodeString(26, 'Unset'),                        // plan_name
    encodeString(28, 'windsurf'),                     // ide_type
  ];
  if (input.userJwt) parts.push(encodeString(21, input.userJwt));   // user_jwt
  return Buffer.concat(parts);
}
