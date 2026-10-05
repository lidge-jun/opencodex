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
