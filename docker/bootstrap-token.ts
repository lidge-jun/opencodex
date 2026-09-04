import { writeServiceApiTokenFile } from "../src/lib/service-secrets";

const MAX_TOKEN_BYTES = 4096;
const MAX_INPUT_BYTES = MAX_TOKEN_BYTES + 2;

export async function readBoundedToken(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_INPUT_BYTES) throw new Error("token input exceeds 4096 bytes");
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  const line = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (/[\r\n\0]/.test(line)) throw new Error("token input must contain exactly one line");

  const token = line.trim();
  if (!token) throw new Error("token input is empty");
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new Error("token input exceeds 4096 bytes");
  return token;
}

export async function bootstrapToken(stream: ReadableStream<Uint8Array>): Promise<void> {
  const token = await readBoundedToken(stream);
  writeServiceApiTokenFile(token);
}

if (import.meta.main) {
  try {
    await bootstrapToken(Bun.stdin.stream());
    console.log("Initialized the owner-only data-plane token in the container state volume.");
  } catch (error) {
    console.error(`Token initialization failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
