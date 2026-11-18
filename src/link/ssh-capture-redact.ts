/**
 * Allowlist sanitizer for the ssh stderr that opt-in SSH capture stores (src/link/ssh-capture.ts).
 *
 * Nothing ssh prints reaches disk as raw text. A line is stored only when it matches one of the
 * known OpenSSH line shapes below, and then only as a fixed rendering: host names, addresses, user
 * names, ports, paths, key descriptions, fingerprints, commands, environment values and messages
 * relayed from the server are replaced by fixed placeholders. The only values carried over are
 * digits (channel numbers, byte counts, exit statuses, config line numbers) and names that are
 * members of a closed set (key-exchange, cipher, MAC and authentication method names, OS error
 * phrases). A value outside its set becomes "<other>"; a line no shape matches is stored as the
 * fixed category "unrecognized" with no text.
 *
 * The same pass decides whether a line counts toward classifySshStderr (src/link/tunnel-state.ts).
 * Capture raises ssh's LogLevel to DEBUG1, and the extra debug and informational lines must not
 * change the fixed cause a tunnel exit is classified with. Lines carrying ssh's "debugN:" prefix,
 * and the unprefixed informational shapes ssh prints only above LogLevel=ERROR, are excluded; any
 * other line counts, as it would at LogLevel=ERROR.
 */

export type SshLineLevel = "debug" | "verbose" | "error";

export interface SanitizedSshLine {
  /** Fixed rule id, or "unrecognized". */
  readonly event: string;
  readonly level: SshLineLevel;
  /** Fixed rendering; absent for an unrecognized line. */
  readonly text?: string;
  /** Whether ssh prints this line at LogLevel=ERROR too, so the exit classifier reads it. */
  readonly classify: boolean;
}

// Written as escapes on purpose: invisible and bidi controls must never sit literally in source.
const ANSI_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const MAX_LINE_CHARS = 1024;
const DEBUG_PREFIX = /^debug([1-3]): /;

/** Vendor-suffixed algorithm names, assembled so the source carries no address-shaped literal. */
const vendor = (name: string, domain: string): string => [name, domain].join("@");
const oss = (name: string): string => vendor(name, "openssh.com");
const SK = ["sk", ""].join("-");

const set = (...values: string[]): ReadonlySet<string> => new Set(values);
const KEX = set(
  "curve25519-sha256", vendor("curve25519-sha256", "libssh.org"), "sntrup761x25519-sha512", oss("sntrup761x25519-sha512"),
  "mlkem768x25519-sha256", "ecdh-sha2-nistp256", "ecdh-sha2-nistp384", "ecdh-sha2-nistp521",
  "diffie-hellman-group-exchange-sha256", "diffie-hellman-group16-sha512", "diffie-hellman-group18-sha512",
  "diffie-hellman-group14-sha256", "diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1",
);
const HOST_KEY_ALGORITHMS = set(
  "ssh-ed25519", oss("ssh-ed25519-cert-v01"), oss(SK + "ssh-ed25519"), oss(SK + "ssh-ed25519-cert-v01"),
  "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", oss("ecdsa-sha2-nistp256-cert-v01"),
  oss("ecdsa-sha2-nistp384-cert-v01"), oss("ecdsa-sha2-nistp521-cert-v01"), oss(SK + "ecdsa-sha2-nistp256"),
  "rsa-sha2-512", "rsa-sha2-256", oss("rsa-sha2-512-cert-v01"), oss("rsa-sha2-256-cert-v01"), "ssh-rsa",
  oss("ssh-rsa-cert-v01"), "ssh-dss",
);
const CIPHERS = set(
  oss("chacha20-poly1305"), "aes128-ctr", "aes192-ctr", "aes256-ctr", oss("aes128-gcm"),
  oss("aes256-gcm"), "aes128-cbc", "aes192-cbc", "aes256-cbc", "3des-cbc",
);
const MACS = set(
  "<implicit>", oss("umac-64-etm"), oss("umac-128-etm"), oss("hmac-sha2-256-etm"),
  oss("hmac-sha2-512-etm"), oss("hmac-sha1-etm"), oss("umac-64"), oss("umac-128"),
  "hmac-sha2-256", "hmac-sha2-512", "hmac-sha1",
);
const COMPRESSION = set("none", oss("zlib"), "zlib");
const AUTH_METHODS = set("publickey", "password", "keyboard-interactive", "hostbased", "gssapi-with-mic", "gssapi-keyex", "none");
const KEY_TYPES = set("ED25519", "ED25519-CERT", "ED25519-SK", "ECDSA", "ECDSA-CERT", "ECDSA-SK", "RSA", "RSA-CERT", "DSA");
const CHANNEL_TYPES = set("client-session", "port listener", "port-listener", "direct-tcpip", "forwarded-tcpip", "session",
  "dynamic-tcpip", "x11", "auth-listener", "stdio-forward", "mux-control");
const GLOBAL_REQUESTS = set(oss("hostkeys-00"), oss("keepalive"), oss("no-more-sessions"));
const CHANNEL_REQUESTS = set("exit-status", "exit-signal", oss("eow"), oss("keepalive"));
const PLEDGES = set("network", "filesystem", "proc", "fork", "stdio");
const REASONS = set(
  "Connection refused", "Operation timed out", "Connection timed out", "No route to host", "Network is unreachable",
  "Connection reset by peer", "Broken pipe", "Host is down", "Host is unreachable", "Permission denied",
  "No such file or directory", "Address already in use", "Can't assign requested address", "Cannot assign requested address",
  "nodename nor servname provided, or not known", "Name or service not known", "Temporary failure in name resolution",
  "No address associated with hostname", "Unknown error", "Software caused connection abort", "Resource temporarily unavailable",
);
const OPEN_FAILURES = set("connect failed", "administratively prohibited", "open failed", "resource shortage", "unknown channel type");
const KEX_IDENTIFICATION = set("read: Connection reset by peer", "Connection closed by remote host", "read: Connection timed out",
  "read: Operation timed out", "banner line contains invalid characters", "write: Broken pipe");
const KEY_LOAD_REASONS = set("invalid format", "bad permissions", "error in libcrypto", "incorrect passphrase supplied to decrypt private key",
  "No such file or directory", "Permission denied");

const pick = (value: string | undefined, allowed: ReadonlySet<string>): string => value !== undefined && allowed.has(value) ? value : "<other>";
const reason = (value: string | undefined): string => value !== undefined && REASONS.has(value) ? value : "<reason>";
const methods = (value: string | undefined): string => (value ?? "").split(",").filter(method => AUTH_METHODS.has(method)).join(",");
const openFailure = (value: string | undefined): string => (value ?? "").split(": ")
  .map(part => OPEN_FAILURES.has(part) || REASONS.has(part) ? part : "<reason>").join(": ");
/** Only the OpenSSH release token survives; distribution suffixes and other software become "<software>". */
const software = (value: string | undefined): string => /^(OpenSSH_(?:for_Windows_)?\d{1,2}\.\d{1,2}(?:p\d{1,2})?)(?: |$)/.exec(value ?? "")?.[1] ?? "<software>";

type Render = (match: RegExpExecArray) => string;
interface Rule {
  readonly id: string;
  /** The level of this shape when ssh prints it without a debug prefix. */
  readonly bare: "verbose" | "error";
  readonly pattern: RegExp;
  readonly render: Render;
}

const fixed = (text: string): Render => () => text;
const rule = (id: string, bare: Rule["bare"], pattern: RegExp, render: Render): Rule => ({ id, bare, pattern, render });

/** Ordered: the first match wins. Every pattern is anchored at both ends. */
const RULES: readonly Rule[] = [
  rule("client.version", "verbose",
    /^(OpenSSH_(?:for_Windows_)?\d{1,2}\.\d{1,2}(?:p\d{1,2})?)(?: [^,]{0,60})?(?:, (OpenSSL|LibreSSL|BoringSSL) (\d{1,2}\.\d{1,2}(?:\.\d{1,2})?[a-z]?)\b.{0,40})?$/,
    m => m[2] ? m[1] + ", " + m[2] + " " + m[3] : m[1]!),
  rule("config.read", "verbose", /^Reading configuration data .+$/, fixed("Reading configuration data <path>")),
  rule("config.apply", "verbose", /^.+ line (\d{1,6}): Applying options for .+$/, m => "<path> line " + m[1] + ": Applying options for <host>"),
  rule("config.include", "verbose", /^.+ line (\d{1,6}): include .+ matched no files$/, m => "<path> line " + m[1] + ": include <path> matched no files"),
  rule("proxy.command", "verbose", /^Executing proxy command: .*$/, fixed("Executing proxy command: <command>")),
  rule("connect.start", "verbose", /^Connecting to .+ port \d{1,5}\.$/, fixed("Connecting to <host> [<address>] port <port>.")),
  rule("connect.established", "verbose", /^Connection established\.$/, fixed("Connection established.")),
  rule("identity.file", "verbose", /^identity file .+ type (-?\d{1,2})$/, m => "identity file <path> type " + m[1]),
  rule("version.local", "verbose", /^Local version string SSH-2\.0-(.+)$/, m => "Local version string SSH-2.0-" + software(m[1])),
  rule("version.remote", "verbose", /^Remote protocol version (\d\.\d{1,2}), remote software version (.+)$/,
    m => "Remote protocol version " + m[1] + ", remote software version " + software(m[2])),
  rule("version.compat", "verbose", /^compat_banner: .*$/, fixed("compat_banner: <software>")),
  rule("auth.target", "verbose", /^Authenticating to .+ as '.*'$/, fixed("Authenticating to <host>:<port> as <user>")),
  rule("hostkeys.load", "verbose", /^load_hostkeys: fopen .+: ([^:]+)$/, m => "load_hostkeys: fopen <path>: " + reason(m[1])),
  rule("kex.message", "verbose", /^(SSH2_MSG_(?:KEXINIT|NEWKEYS|SERVICE_ACCEPT|SERVICE_REQUEST|EXT_INFO|KEX_ECDH_REPLY|KEX_ECDH_INIT)) (sent|received)$/,
    m => m[1] + " " + m[2]),
  rule("kex.expect", "verbose", /^expecting (SSH2_MSG_(?:KEX_ECDH_REPLY|KEX_DH_GEX_GROUP|KEX_DH_GEX_REPLY|NEWKEYS))$/, m => "expecting " + m[1]),
  rule("kex.ext_info", "verbose", /^Sending SSH2_MSG_EXT_INFO$/, fixed("Sending SSH2_MSG_EXT_INFO")),
  rule("kex.algorithm", "verbose", /^kex: algorithm: (\S+)$/, m => "kex: algorithm: " + pick(m[1], KEX)),
  rule("kex.host_key_algorithm", "verbose", /^kex: host key algorithm: (\S+)$/, m => "kex: host key algorithm: " + pick(m[1], HOST_KEY_ALGORITHMS)),
  rule("kex.cipher", "verbose", /^kex: (server->client|client->server) cipher: (\S+) MAC: (\S+) compression: (\S+)$/,
    m => "kex: " + m[1] + " cipher: " + pick(m[2], CIPHERS) + " MAC: " + pick(m[3], MACS) + " compression: " + pick(m[4], COMPRESSION)),
  rule("kex.server_sig_algs", "verbose", /^kex_ext_info_client_parse: server-sig-algs=<.*>$/, fixed("kex_ext_info_client_parse: server-sig-algs=<list>")),
  rule("kex.ext_version", "verbose", /^kex_ext_info_check_ver: .*$/, fixed("kex_ext_info_check_ver: <extension>")),
  rule("hostkey.server", "verbose", /^Server host key: (\S+) \S+$/, m => "Server host key: " + pick(m[1], HOST_KEY_ALGORITHMS) + " <fingerprint>"),
  rule("hostkey.known", "verbose", /^Host .+ is known and matches the (\S+) host key\.$/, m => "Host <host> is known and matches the " + pick(m[1], KEY_TYPES) + " host key."),
  rule("hostkey.found", "verbose", /^Found key in .+:(\d{1,7})$/, m => "Found key in <path>:" + m[1]),
  rule("kex.rekey", "verbose", /^rekey (in|out) after (\d{1,20}) blocks$/, m => "rekey " + m[1] + " after " + m[2] + " blocks"),
  rule("auth.continue", "verbose", /^Authentications that can continue: (\S*)$/, m => "Authentications that can continue: " + methods(m[1])),
  rule("auth.next", "verbose", /^Next authentication method: (\S+)$/, m => "Next authentication method: " + pick(m[1], AUTH_METHODS)),
  rule("auth.will_attempt", "verbose", /^Will attempt key: .*$/, fixed("Will attempt key: <key>")),
  rule("auth.offer", "verbose", /^Offering public key: .*$/, fixed("Offering public key: <key>")),
  rule("auth.accepted_key", "verbose", /^Server accepts key: .*$/, fixed("Server accepts key: <key>")),
  rule("auth.try_private", "verbose", /^Trying private key: .*$/, fixed("Trying private key: <path>")),
  rule("auth.no_signature", "verbose", /^send_pubkey_test: no mutual signature algorithm$/, fixed("send_pubkey_test: no mutual signature algorithm")),
  rule("auth.exhausted", "verbose", /^No more authentication methods to try\.$/, fixed("No more authentication methods to try.")),
  rule("auth.succeeded", "verbose", /^Authentication succeeded \((\S+)\)\.$/, m => "Authentication succeeded (" + pick(m[1], AUTH_METHODS) + ")."),
  rule("auth.authenticated", "verbose", /^Authenticated to .+ \((?:\[[^\]]*\]:\d{1,5}|via proxy)\) using "(\S+)"\.$/,
    m => "Authenticated to <host> ([<address>]:<port>) using \"" + pick(m[1], AUTH_METHODS) + "\"."),
  rule("agent.identities", "verbose", /^get_agent_identities: .*$/, fixed("get_agent_identities: <message>")),
  rule("channel.new", "verbose", /^channel (\d{1,6}): new (?:\S+ )?\[([a-z -]{1,30})\](?: \(inactive timeout: \d{1,10}\))?$/,
    m => "channel " + m[1] + ": new [" + pick(m[2], CHANNEL_TYPES) + "]"),
  rule("session.no_more", "verbose", /^Requesting no-more-sessions\u0040openssh\.com$/, fixed("Requesting " + oss("no-more-sessions"))),
  rule("session.interactive", "verbose", /^Entering interactive session\.$/, fixed("Entering interactive session.")),
  rule("session.pledge", "verbose", /^pledge: (\S+)$/, m => "pledge: " + pick(m[1], PLEDGES)),
  rule("session.environment", "verbose", /^Sending environment\.$/, fixed("Sending environment.")),
  rule("session.env", "verbose", /^Sending env .*$/, fixed("Sending env <redacted>")),
  rule("global.request", "verbose", /^client_input_global_request: rtype (\S+) want_reply (\d)$/,
    m => "client_input_global_request: rtype " + pick(m[1], GLOBAL_REQUESTS) + " want_reply " + m[2]),
  rule("hostkeys.update", "verbose", /^client_input_hostkeys: .*$/, fixed("client_input_hostkeys: <message>")),
  rule("remote.message", "verbose", /^Remote: .*$/, fixed("Remote: <message>")),
  rule("forward.remote_result", "verbose", /^remote forward (success|failure) for: listen .+, connect .+$/,
    m => "remote forward " + m[1] + " for: listen <address>:<port>, connect <address>:<port>"),
  rule("forward.all_replies", "verbose", /^forwarding_success: all expected forwarding replies received$/, fixed("forwarding_success: all expected forwarding replies received")),
  rule("forward.setup", "verbose", /^(Local|Remote) connections (to|from) .+ forwarded to (remote|local) address .+$/,
    m => m[1] + " connections " + m[2] + " <address>:<port> forwarded to " + m[3] + " address <address>:<port>"),
  rule("forward.listening", "verbose", /^Local forwarding listening on .+ port \d{1,5}\.$/, fixed("Local forwarding listening on <address> port <port>.")),
  rule("forward.requested", "verbose", /^Connection to port \d{1,5} forwarding to .+ port \d{1,5} requested\.$/,
    fixed("Connection to port <port> forwarding to <address> port <port> requested.")),
  rule("channel.open_request", "verbose", /^client_input_channel_open: ctype (\S+) rchan (\d{1,10}) win (\d{1,10}) max (\d{1,10})$/,
    m => "client_input_channel_open: ctype " + pick(m[1], CHANNEL_TYPES) + " rchan " + m[2] + " win " + m[3] + " max " + m[4]),
  rule("channel.forwarded", "verbose", /^client_request_forwarded_tcpip: listen .+ port \d{1,5}, originator .+ port \d{1,5}$/,
    fixed("client_request_forwarded_tcpip: listen <address> port <port>, originator <address> port <port>")),
  rule("channel.connecting", "verbose", /^connect_next: host .+ \(\[[^\]]*\]:\d{1,5}\) in progress, fd=(\d{1,6})$/,
    m => "connect_next: host <host> ([<address>]:<port>) in progress, fd=" + m[1]),
  rule("channel.connected", "verbose", /^channel (\d{1,6}): connected to .+ port \d{1,5}$/, m => "channel " + m[1] + ": connected to <address> port <port>"),
  rule("channel.free", "verbose", /^channel (\d{1,6}): free: .*, nchannels (\d{1,6})$/, m => "channel " + m[1] + ": free, nchannels " + m[2]),
  rule("channel.request", "verbose", /^client_input_channel_req: channel (\d{1,6}) rtype (\S+) reply (\d)$/,
    m => "client_input_channel_req: channel " + m[1] + " rtype " + pick(m[2], CHANNEL_REQUESTS) + " reply " + m[3]),
  rule("channel.fd_mode", "verbose", /^fd (\d{1,6}) (clearing|setting) O_NONBLOCK$/, m => "fd " + m[1] + " " + m[2] + " O_NONBLOCK"),
  // ssh prints this at INFO, so LogLevel=ERROR never shows it: it must not change the exit class.
  rule("channel.open_failed", "verbose", /^channel (\d{1,6}): open failed: (.+)$/, m => "channel " + m[1] + ": open failed: " + openFailure(m[2])),
  rule("forward.connect_failed", "error", /^connect_to .+ port \d{1,5}: failed\.$/, fixed("connect_to <host> port <port>: failed.")),
  rule("session.transferred", "verbose", /^Transferred: sent (\d{1,20}), received (\d{1,20}) bytes, in (\d{1,10}(?:\.\d{1,3})?) seconds$/,
    m => "Transferred: sent " + m[1] + ", received " + m[2] + " bytes, in " + m[3] + " seconds"),
  rule("session.rate", "verbose", /^Bytes per second: sent (\d{1,20}(?:\.\d{1,3})?), received (\d{1,20}(?:\.\d{1,3})?)$/,
    m => "Bytes per second: sent " + m[1] + ", received " + m[2]),
  rule("session.exit_status", "verbose", /^Exit status (-?\d{1,3})$/, m => "Exit status " + m[1]),
  rule("session.disconnect_send", "error", /^client_loop: send disconnect: (.+)$/, m => "client_loop: send disconnect: " + reason(m[1])),
  rule("session.killed", "verbose", /^Killed by signal (\d{1,2})\.$/, m => "Killed by signal " + m[1] + "."),
  rule("hostkey.verification_failed", "error", /^Host key verification failed\.$/, fixed("Host key verification failed.")),
  rule("hostkey.changed_banner", "error", /^@+ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @+$/, fixed("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")),
  rule("hostkey.unknown", "error", /^No (\S+) host key is known for .+ and you have requested strict checking\.$/,
    m => "No " + pick(m[1], KEY_TYPES) + " host key is known for <host> and you have requested strict checking."),
  rule("auth.denied", "error", /^.+: Permission denied \((\S*)\)\.$/, m => "<user>@<host>: Permission denied (" + methods(m[1]) + ")."),
  rule("auth.too_many", "error", /^(?:Received disconnect from .+: )?Too many authentication failures(?: \[preauth\])?$/, fixed("Too many authentication failures")),
  rule("connect.failed", "error", /^ssh: connect to host .+ port \d{1,5}: (.+)$/, m => "ssh: connect to host <host> port <port>: " + reason(m[1])),
  rule("connect.resolve_failed", "error", /^ssh: Could not resolve hostname .+?: (.+)$/, m => "ssh: Could not resolve hostname <host>: " + reason(m[1])),
  // Rules marked "verbose" here are lines ssh logs at INFO or VERBOSE (logdie, logit, verbose_f), so
  // LogLevel=ERROR never shows them and they must not change the exit class while capture runs at
  // DEBUG1. "Connection ... closed by remote host." is written by quit_message at every level.
  rule("connect.closed_by", "verbose", /^Connection closed by .+ port \d{1,5}$/, fixed("Connection closed by <address> port <port>")),
  rule("connect.closed_remote", "error", /^Connection (?:to .+ )?closed by remote host\.?$/, fixed("Connection closed by remote host.")),
  rule("connect.reset_by", "verbose", /^Connection reset by .+ port \d{1,5}$/, fixed("Connection reset by <address> port <port>")),
  // kex.c logs these two reasons with verbose_f; only the read:/write: reasons use error_f.
  rule("connect.identification", "verbose", /^kex_exchange_identification: (Connection closed by remote host|banner line contains invalid characters)$/,
    m => "kex_exchange_identification: " + m[1]),
  rule("connect.identification", "error", /^kex_exchange_identification: (.+)$/,
    m => "kex_exchange_identification: " + (KEX_IDENTIFICATION.has(m[1]!) ? m[1] : "<reason>")),
  rule("connect.banner_timeout", "error", /^Connection timed out during banner exchange$/, fixed("Connection timed out during banner exchange")),
  rule("connect.server_timeout", "verbose", /^Timeout, server .+ not responding\.$/, fixed("Timeout, server <host> not responding.")),
  // Logged through logdie, which OpenSSH always emits at INFO.
  rule("connect.dispatch_fatal", "verbose", /^ssh_dispatch_run_fatal: Connection to .+ port \d{1,5}: (.+)$/,
    m => "ssh_dispatch_run_fatal: Connection to <address> port <port>: " + reason(m[1])),
  rule("connect.timed_out", "verbose", /^Connection to .+ port \d{1,5} timed out$/, fixed("Connection to <address> port <port> timed out")),
  rule("connect.disconnect_received", "error", /^Received disconnect from .+ port \d{1,5}:(\d{1,3}): .*$/,
    m => "Received disconnect from <address> port <port>:" + m[1] + ": <message>"),
  rule("connect.disconnected", "verbose", /^Disconnected from .+ port \d{1,5}$/, fixed("Disconnected from <address> port <port>")),
  rule("key.bad_permissions", "error", /^Bad owner or permissions on .+$/, fixed("Bad owner or permissions on <path>")),
  rule("key.load_failed", "error", /^Load key ".+": (.+)$/, m => "Load key <path>: " + (KEY_LOAD_REASONS.has(m[1]!) ? m[1] : "<reason>")),
  rule("forward.remote_failed", "error", /^(Warning|Error): remote port forwarding failed for listen port \d{1,5}$/,
    m => m[1] + ": remote port forwarding failed for listen port <port>"),
  rule("forward.bind_failed", "error", /^bind (?:\[.+\]:\d{1,5}|.+ port \d{1,5}): (.+)$/, m => "bind <address>:<port>: " + reason(m[1])),
  rule("forward.cannot_listen", "error", /^channel_setup_fwd_listener_tcpip: cannot listen to port: \d{1,5}$/,
    fixed("channel_setup_fwd_listener_tcpip: cannot listen to port: <port>")),
  rule("forward.local_failed", "error", /^Could not request local forwarding\.$/, fixed("Could not request local forwarding.")),
  rule("hostkey.added", "verbose", /^Warning: Permanently added .+ to the list of known hosts\.$/, fixed("Warning: Permanently added <host> to the list of known hosts.")),
];

/** Sanitize one stderr line. Never returns raw text: only a fixed rendering or a fixed category. */
export function sanitizeSshLine(raw: string): SanitizedSshLine {
  const line = raw.replace(ANSI_SEQUENCE, "").replace(CONTROL, " ").trim();
  const prefix = DEBUG_PREFIX.exec(line);
  // DEBUG1 is the level capture requests; a debug2/debug3 line is never stored as text.
  const debug = prefix !== null;
  if (line.length > MAX_LINE_CHARS || (prefix && prefix[1] !== "1")) return { event: "unrecognized", level: debug ? "debug" : "error", classify: !debug };
  const body = prefix ? line.slice(prefix[0].length) : line;
  for (const candidate of RULES) {
    const match = candidate.pattern.exec(body);
    if (!match) continue;
    const level: SshLineLevel = debug ? "debug" : candidate.bare;
    const text = candidate.render(match);
    return { event: candidate.id, level, text: debug ? "debug1: " + text : text, classify: level === "error" };
  }
  // An unknown unprefixed line is treated as ssh printed it at LogLevel=ERROR: it still classifies.
  return { event: "unrecognized", level: debug ? "debug" : "error", classify: !debug };
}

/** Whether a line counts toward classifySshStderr, as it would at LogLevel=ERROR. */
export function sshLineClassifies(raw: string): boolean {
  return sanitizeSshLine(raw).classify;
}

