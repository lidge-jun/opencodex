/** Credential-option redaction for CLI argument errors. Kept dependency-free so the CLI head can use it. */
/**
 * Options whose VALUE is a credential (or can carry one), listed here so a parse
 * error never prints one. `--headers` belongs on the list defensively: custom
 * headers are documented as non-secret metadata and the validator rejects the
 * standard credential names, but it cannot recognize an arbitrary one such as
 * `X-My-Token`, so a parse error must not echo the value back either way.
 *
 * `takeOption` only understands `--flag value`. `--flag=value` therefore falls
 * through to `rejectArgs`, which reports the offending argument verbatim — for
 * `--code=https://…?code=SECRET` that writes the authorization code to stderr,
 * which is the exact exposure the stdin path exists to avoid.
 */
const SECRET_OPTIONS = [
  "--code",
  "--headers",
  "--api-key",
  "--key",
  "--secret",
  "--password",
  "--token",
  "--admin-token",
  "--pairing-code",
  "--credential-env",
  "--admin-token-env",
  "--pairing-code-env",
];

function isSecretOptionToken(token: string): boolean {
  return SECRET_OPTIONS.includes(token) || SECRET_OPTIONS.some(option => token.startsWith(`${option}=`));
}

let credentialArgvSeen = false;
let credentialValues: string[] = [];
let consoleScrubInstalled = false;

/** Operands of credential options in argv, longest first; very short values are not scrubbed. */
function credentialOperands(argv: readonly string[]): string[] {
  const values = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    const inline = SECRET_OPTIONS.find(option => token.startsWith(`${option}=`));
    let value: string | undefined;
    if (inline) value = token.slice(inline.length + 1);
    else if (SECRET_OPTIONS.includes(token)) {
      value = argv[argv[index + 1] === "--" ? index + 2 : index + 1];
      // A following bare credential option is not this option's operand; its own operand is
      // collected on its turn. An inline value is always an operand, whatever it looks like.
      if (value !== undefined && SECRET_OPTIONS.includes(value)) value = undefined;
    }
    if (value !== undefined && value.length >= 4) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Replace every argv credential operand in text printed by this process. */
export function scrubCredentialOperands(text: string): string {
  let out = text;
  // Case-insensitive: some parsers lowercase an action before echoing it.
  for (const value of credentialValues) out = out.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<redacted>");
  return out;
}

/**
 * Last-line guard for console diagnostics (stderr): parsers that echo a selector, an unknown
 * subcommand or a leftover before any redaction would otherwise print an operand typed after
 * a credential option. Installed once; it reads the operands recorded for the current argv.
 */
function installConsoleScrub(): void {
  if (consoleScrubInstalled) return;
  consoleScrubInstalled = true;
  // Diagnostics only: stdout carries JSON documents whose primitives must not be rewritten.
  for (const method of ["warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (credentialValues.length === 0) return original(...args);
      return original(...args.map(arg => typeof arg === "string" ? scrubCredentialOperands(arg)
        : arg instanceof Error ? scrubCredentialOperands(arg.stack ?? arg.message) : arg));
    };
  }
}

/**
 * Record whether the process argv carried any credential option. Parsers that take
 * positionals can consume the option token itself (`ocx account use openai --token X`
 * makes `--token` the id), leaving only its operand as a "leftover"; once a credential
 * option was present anywhere, every bare leftover is reported as `<redacted>`.
 */
export function noteCredentialArgv(argv: readonly string[]): void {
  credentialArgvSeen = argv.some(isSecretOptionToken);
  credentialValues = credentialOperands(argv);
  if (credentialValues.length > 0) installConsoleScrub();
}

/**
 * Replace credential values before they are reported back.
 *
 * Both spellings have to be covered, and the space-separated one spans two
 * tokens: mistyping `ocx account cancel <p> --code <secret>` on a command that
 * does not parse `--code` leaves the flag AND its value in the leftovers, and
 * reporting them verbatim writes the credential to stderr. Repeating the
 * option does the same with the second value, since the parser takes only the
 * first occurrence.
 *
 * The token after the option is redacted whatever it looks like. Skipping
 * `--`-prefixed tokens read as "that is a flag, not a value", but the shell
 * hands over whatever was typed: `--code --SUPERSECRET` and
 * `--code -- SUPERSECRET` both put the credential straight in the message. A
 * mistaken `--code --json` now reads `--code <redacted>`, which is worse
 * diagnostics for a case that already prints the usage text, and better than
 * printing a credential.
 *
 * `redactValues` extends that to bare leftovers, for commands whose positional
 * argument is itself a credential.
 */
export function redactSecretArgs(args: string[], redactValues = false): string[] {
  redactValues ||= credentialArgvSeen;
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    const inline = SECRET_OPTIONS.find(option => arg.startsWith(`${option}=`));
    if (inline) {
      out.push(`${inline}=<redacted>`);
      continue;
    }
    if (SECRET_OPTIONS.includes(arg)) {
      out.push(arg);
      // Swallow the value that belongs to it. `--` is an end-of-options
      // separator, so the value is the token after it.
      let valueIndex = index + 1;
      if (args[valueIndex] === "--") {
        out.push("--");
        valueIndex++;
      }
      const next = args[valueIndex];
      // A following credential option is not this option's value: leave it for the
      // next iteration so its own operand is redacted too (`--code --token SECRET`).
      if (next !== undefined && !isSecretOptionToken(next)) {
        out.push("<redacted>");
        index = valueIndex;
      } else if (next !== undefined) {
        index = valueIndex - 1;
      }
      continue;
    }
    out.push(redactValues && !arg.startsWith("-") ? "<redacted>" : arg);
  }
  return out;
}
