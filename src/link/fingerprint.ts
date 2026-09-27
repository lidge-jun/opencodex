export interface ParsedFingerprint {
  bits: number;
  fingerprint: string;
  alias: string;
  keyType: string;
}

/** Parse exactly one `ssh-keygen -l` fingerprint line. */
export function parseFingerprintLine(stdout: string): ParsedFingerprint {
  if (!stdout || /[\r\n]/.test(stdout)) throw new Error("fingerprint output must contain exactly one line");
  const match = /^(\d+)\s+(SHA256:[A-Za-z0-9+/=]+)\s+(\S+)\s+\(([^()\s]+)\)$/.exec(stdout);
  if (!match) throw new Error("fingerprint output has an invalid format");
  const bits = Number(match[1]);
  if (!Number.isSafeInteger(bits) || bits < 1) throw new Error("fingerprint bit count is invalid");
  return {
    bits,
    fingerprint: match[2]!,
    alias: match[3]!,
    keyType: match[4]!,
  };
}
