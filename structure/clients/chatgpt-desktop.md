# ChatGPT Desktop app-server shim

The experimental macOS integration is owned by `src/chatgpt/` and exposed through
`src/cli/chatgpt-command.ts`. It is default off and requires
`chatgptDesktop.appServerShim === true` for an explicit launch. Its config leaf
accepts only an optional boolean; malformed reads disable the leaf, while live
writes reject malformed values and unknown fields.

The launcher under the config directory re-enters the current CLI using
`process.execPath` and `selfLaunchArgv()`. Its hidden internal filter command stays
out of the public command registry and generated skill surface. Source installs
include the CLI entry argument; compiled builds use only the executable and
internal command arguments.

The launcher checks macOS, executable presence and a successful filter self-test,
then replaces itself with the bundled app-server using shell exec. Only stdout
passes through the filter. Stdin, stderr, process identity and the real server's
exit status retain the direct app/server relationship.

When the platform is not macOS, the runtime is missing, or the filter self-test fails,
the launcher runs the original binary with untouched stdout. A missing bundled binary
exits 127 instead (see below). A filter that passes the self-test and then exits
mid-session closes the server's stdout pipe; the filter's passthrough mode limits this
to an exit/crash case.

The pure gate rewrite changes known plain-quota fields only in eligible JSON-RPC
rate-limit notifications and top-level rate-limit results. Workspace, credit,
unknown reached-type and spend-control restrictions preserve closed gate flags.
Both the rate-limit flags and `ordinaryUsageAllowed` open only where the subtree shows
plain-quota evidence: a cleared plain reached type or a usage window at 100%.
Usage percentages, resets and window durations remain accurate. Unrelated messages
and malformed lines remain byte-identical; changed lines are reserialized.
A per-line rewrite exception preserves that line. A failure in the framing/rewrite
machinery preserves buffered bytes and switches the rest of the stream to raw
passthrough. Output-write failures propagate; they are not rewrite failures.
A partial line is held as a list of chunks and joined once at its newline, so a long
line split across many pipe reads costs linear copying.
A line longer than `MAX_FILTERED_LINE_BYTES` (8 MiB) is never joined or parsed, whether
it arrives across many chunks or whole in one: its bytes stream through raw, and
filtering resumes after its newline.

The app is discovered and confirmed by bundle identifier through
`darwinDesktopAppAdapter.discover` (`src/codex/desktop-app/darwin.ts`). Launch derives
the bundled app-server binary from that root (`resolveChatgptCodexBinary`) and refuses
when none exists or when `untrustedChatgptBundleReason`
(`src/chatgpt/app-server-shim/bundle-trust.ts`) reports the bundle or binary as owned
by another user, group/other-writable, unsigned, or signed by a team other than
OpenAI's. It writes the mode-0755 executable through an exclusive temp file and a
rename (never through a symbolic link), quits the bundle by id, waits for this user's
instance to exit, then opens the same bundle path with the launcher in CODEX_CLI_PATH.
The launcher itself exits 127 with a stderr hint when the recorded binary is gone.
Restore uses the same trust policy for the bundle and its main app executable before
quit or open. Both relaunch paths check ancestor ownership and POSIX replacement permissions
through the filesystem root. Ancestors must be owned by this user or root; group/other write
is accepted only for trusted sticky ancestors or root-owned, non-world-writable containers
whose group matches the local directory service's admin group. An unreadable admin-group lookup
does not grant that exception. These checks do not attest ACL or mount-policy restrictions.
Restore does not require the experimental flag or a bundled
app-server binary. It relaunches without that override and removes the launcher only after open succeeds; when no
`com.openai.codex` bundle is found it removes the launcher, relaunches nothing and
exits 1. Status reports
the experimental flag, launcher presence, and the verified bundle process's override
without printing its environment. Other platforms reject all three operations.

The launcher and its executable paths are local code-execution inputs. This
integration installs no network listener, CA, PAC or background watcher, and
starts no proxy timer. Explicit launches are its only activation point.

Tests cover rewriting, byte framing, passthrough degradation, source/compiled
launcher text, stub launcher execution, hidden preflight, and strict config writes
in tests/clients/desktop-*.test.ts. Pipe-crash behavior is mock evidence only;
no bundled-app respawn guarantee is asserted.
