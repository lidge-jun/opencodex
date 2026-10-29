/** Match fixed SSH bind-failure tokens without retaining any diagnostic bytes. */
export function remoteForwardFailure(argv: readonly string[], onReady: () => void) {
  const direction = argv.includes("-L") ? "L" : "R";
  const index = argv.indexOf(`-${direction}`), port = argv[index + 1]?.split(":")[1];
  const enabled = index >= 0 && argv.includes("ExitOnForwardFailure=yes") && /^\d+$/.test(port ?? "");
  const failures = !enabled ? []
    : direction === "L" ? ["Could not request local forwarding."]
    : [`remote port forwarding failed for listen port ${port}\r`, `remote port forwarding failed for listen port ${port}\n`];
  const target = argv[index + 1]?.split(":").slice(2).join(":");
  // OpenSSH emits the local-listening announcement BEFORE bind(), so it is not a success receipt.
  const success = direction === "L" ? "debug1: Entering interactive session."
    : `debug1: remote forward success for: listen 127.0.0.1:${port}, connect ${target}`;
  const successes = !enabled ? [] : [`${success}\r`, `${success}\n`];
  const matches = [...failures, ...successes].map((token, index) => {
    const bytes = new TextEncoder().encode(token), prefixes = new Uint32Array(bytes.length);
    for (let i = 1, length = 0; i < bytes.length; i++) {
      while (length && bytes[i] !== bytes[length]) length = prefixes[length - 1]!;
      if (bytes[i] === bytes[length]) length++;
      prefixes[i] = length;
    }
    return { bytes, prefixes, length: 0, success: index >= failures.length };
  });
  let failed = false, ready = false;
  return { enabled, get failed() { return failed; }, get ready() { return ready; }, write(chunk: Uint8Array) {
    if (!enabled || failed || ready) return;
    for (const byte of chunk) for (const match of matches) {
      while (match.length && byte !== match.bytes[match.length]) match.length = match.prefixes[match.length - 1]!;
      if (byte === match.bytes[match.length]) match.length++;
      if (match.length === match.bytes.length) {
        if (match.success) { ready = true; onReady(); } else failed = true;
        return;
      }
    }
  } };
}
