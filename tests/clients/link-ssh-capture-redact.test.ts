import { describe, expect, test } from "bun:test";
import { sanitizeSshLine, sshLineClassifies } from "../../src/link/ssh-capture-redact";
import { classifySshStderr } from "../../src/link/tunnel-state";

/**
 * Identifiers and secrets planted in otherwise genuine OpenSSH line shapes. Nothing in this list may
 * survive into a stored rendering, whatever rule the line hits.
 */
const SECRETS = [
  "build-03.corp.example.test", "home.example.test", "203.0.113.77", "2001:db8::42", "fe80::1%en0", "198.51.100.9",
  "alice", "svc-deploy", "2222", "19002", "19001", "51234",
  "SHA256:Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg", "MD5:12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0",
  "/Users/example/.ssh/id_ed25519", "/home/test/.ssh/config", "C:\\Users\\example\\.ssh\\known_hosts",
  "ocx_admin_0123456789abcdef", "ocx_data_" + "a".repeat(40), "hunter2", "AKIAIOSFODNN7EXAMPLE",
  "access-token-value-0123456789abcdef", "gh-secret-0123456789abcdefABCDEF",
  "-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
  "alice@laptop", "TOKEN=s3cr3t", "Ubuntu-3ubuntu13.5", "corp-bastion",
];

/** An OpenSSH vendor-suffixed cipher name, assembled so the source carries no address-shaped literal. */
const CHACHA = ["chacha20-poly1305", "openssh.com"].join("@");

const SAMPLES: readonly string[] = [
  "OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024",
  "debug1: Reading configuration data /home/test/.ssh/config",
  "debug1: /home/test/.ssh/config line 12: Applying options for build-03.corp.example.test",
  "debug1: Executing proxy command: exec cloudflared access ssh --hostname build-03.corp.example.test --token ocx_admin_0123456789abcdef",
  "debug1: Connecting to build-03.corp.example.test [203.0.113.77] port 2222.",
  "debug1: Connecting to home.example.test [2001:db8::42] port 2222.",
  "debug1: identity file /Users/example/.ssh/id_ed25519 type 3",
  "debug1: Local version string SSH-2.0-OpenSSH_9.6 alice@laptop",
  "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1 Ubuntu-3ubuntu13.5",
  "debug1: Remote protocol version 2.0, remote software version corp-bastion hunter2",
  "debug1: compat_banner: match: OpenSSH_9.6p1 Ubuntu-3ubuntu13.5 pat OpenSSH* compat 0x04000000",
  "debug1: Authenticating to build-03.corp.example.test:2222 as 'svc-deploy'",
  "debug1: load_hostkeys: fopen /home/test/.ssh/known_hosts2: No such file or directory",
  "debug1: kex: algorithm: hunter2-sha256",
  "debug1: kex: server->client cipher: TOKEN=s3cr3t MAC: <implicit> compression: none",
  "debug1: kex_ext_info_client_parse: server-sig-algs=<ssh-ed25519,hunter2>",
  "debug1: Server host key: ssh-ed25519 SHA256:Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
  "debug1: Host 'build-03.corp.example.test' is known and matches the ED25519 host key.",
  "debug1: Found key in /home/test/.ssh/known_hosts:7",
  "debug1: Authentications that can continue: publickey,hunter2,password",
  "debug1: Will attempt key: /Users/example/.ssh/id_ed25519 ED25519 SHA256:Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg explicit agent",
  "debug1: Offering public key: alice@laptop ED25519 SHA256:Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg agent",
  "debug1: Server accepts key: /Users/example/.ssh/id_ed25519 ED25519 MD5:12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0",
  "Authenticated to build-03.corp.example.test ([203.0.113.77]:2222) using \"publickey\".",
  "debug1: Sending env TOKEN=s3cr3t",
  "debug1: Sending env LANG = AKIAIOSFODNN7EXAMPLE",
  "debug1: Remote: /home/test/.ssh/authorized_keys:3: key options: agent-forwarding port-forwarding pty",
  "debug1: Remote: Bearer access-token-value-0123456789abcdef",
  "debug1: remote forward success for: listen 19002, connect 127.0.0.1:19001",
  "debug1: Remote connections from 127.0.0.1:19002 forwarded to local address 198.51.100.9:19001",
  "debug1: Local forwarding listening on 127.0.0.1 port 19002.",
  "debug1: Connection to port 19002 forwarding to 198.51.100.9 port 19001 requested.",
  "debug1: client_input_channel_open: ctype gh-secret-0123456789abcdefABCDEF rchan 3 win 2097152 max 32768",
  "debug1: client_request_forwarded_tcpip: listen 127.0.0.1 port 19002, originator 198.51.100.9 port 51234",
  "debug1: connect_next: host 198.51.100.9 ([198.51.100.9]:19001) in progress, fd=7",
  "debug1: channel 3: connected to 198.51.100.9 port 19001",
  "debug1: channel 3: free: 198.51.100.9, nchannels 4",
  "channel 3: open failed: connect failed: hunter2.corp-bastion",
  "connect_to 198.51.100.9 port 19001: failed.",
  "svc-deploy@build-03.corp.example.test: Permission denied (publickey,hunter2).",
  "ssh: connect to host build-03.corp.example.test port 2222: Connection refused",
  "ssh: Could not resolve hostname build-03.corp.example.test: nodename nor servname provided, or not known",
  "Connection closed by 203.0.113.77 port 2222",
  "Connection to build-03.corp.example.test closed by remote host.",
  "Timeout, server build-03.corp.example.test not responding.",
  "Received disconnect from 203.0.113.77 port 2222:2: TOKEN=s3cr3t",
  "No ED25519 host key is known for build-03.corp.example.test and you have requested strict checking.",
  "Load key \"/Users/example/.ssh/id_ed25519\": hunter2",
  "Bad owner or permissions on /home/test/.ssh/config",
  "Warning: remote port forwarding failed for listen port 19002",
  "bind [127.0.0.1]:19002: Address already in use",
  "kex_exchange_identification: hunter2 corp-bastion",
  // Shapes no rule knows: stored only as the category.
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
  "Enter passphrase for key '/Users/example/.ssh/id_ed25519': hunter2",
  "debug2: channel 0: request keepalive confirm 1 TOKEN=s3cr3t",
  "debug3: send packet: type 80 alice@laptop",
  "password=hunter2",
  // A crafted shape: an injected newline and terminal escapes must not split or smuggle text.
  "debug1: Connecting to home.example.test\u001b[31m [203.0.113.77] port 2222.",
  "debug1: Offering public key: x\u202e" + "hunter2",
  "debug1: kex: algorithm: " + "a".repeat(2000) + "hunter2",
];

describe("ssh capture redaction", () => {
  test("every sample is reduced to a fixed rendering with no identifier or secret left", () => {
    for (const sample of SAMPLES) {
      const result = sanitizeSshLine(sample);
      const stored = JSON.stringify(result);
      for (const secret of SECRETS) {
        if (stored.includes(secret)) throw new Error("leaked " + JSON.stringify(secret) + " from " + JSON.stringify(sample) + ": " + stored);
      }
      // Only the fixed category is stored for an unrecognized line, never any of its text.
      if (result.event === "unrecognized") expect(result.text).toBeUndefined();
    }
  });

  test("renders known shapes with placeholders and keeps only closed-set values", () => {
    const cases: Array<[string, string]> = [
      ["debug1: Connecting to build-03.corp.example.test [203.0.113.77] port 2222.", "debug1: Connecting to <host> [<address>] port <port>."],
      ["debug1: kex: algorithm: curve25519-sha256", "debug1: kex: algorithm: curve25519-sha256"],
      ["debug1: kex: algorithm: hunter2-sha256", "debug1: kex: algorithm: <other>"],
      ["debug1: kex: server->client cipher: " + CHACHA + " MAC: <implicit> compression: none",
        "debug1: kex: server->client cipher: " + CHACHA + " MAC: <implicit> compression: none"],
      ["debug1: Authentications that can continue: publickey,hunter2,password", "debug1: Authentications that can continue: publickey,password"],
      ["debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1 Ubuntu-3ubuntu13.5",
        "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1"],
      ["debug1: Remote protocol version 2.0, remote software version corp-bastion hunter2",
        "debug1: Remote protocol version 2.0, remote software version <software>"],
      ["OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024", "OpenSSH_9.6p1, OpenSSL 3.0.13"],
      ["svc-deploy@build-03.corp.example.test: Permission denied (publickey,hunter2).", "<user>@<host>: Permission denied (publickey)."],
      ["channel 3: open failed: connect failed: Connection refused", "channel 3: open failed: connect failed: Connection refused"],
      ["channel 3: open failed: connect failed: hunter2.corp-bastion", "channel 3: open failed: connect failed: <reason>"],
      ["Warning: remote port forwarding failed for listen port 19002", "Warning: remote port forwarding failed for listen port <port>"],
      ["Transferred: sent 2345, received 3456 bytes, in 12.3 seconds", "Transferred: sent 2345, received 3456 bytes, in 12.3 seconds"],
      ["debug1: Executing proxy command: exec nc --token hunter2 %h %p", "debug1: Executing proxy command: <command>"],
    ];
    for (const [raw, rendered] of cases) expect(sanitizeSshLine(raw).text).toBe(rendered);
    expect(sanitizeSshLine("totally new ssh message hunter2")).toEqual({ event: "unrecognized", level: "error", classify: true });
    expect(sanitizeSshLine("debug2: anything at all")).toEqual({ event: "unrecognized", level: "debug", classify: false });
  });

  test("only lines ssh prints at LogLevel=ERROR count toward the exit classification", () => {
    // Debug and informational lines that mention words the classifier reacts to.
    for (const line of [
      "debug1: connect_next: connect to 127.0.0.1 port 19001: Connection refused",
      "channel 2: open failed: connect failed: Connection refused",
      "debug1: Remote: Permission denied for a forwarded channel",
      "debug1: channel 2: free: port listener, nchannels 3 connection reset",
      "Transferred: sent 1, received 2 bytes, in 0.5 seconds",
      "Authenticated to home.example.test ([203.0.113.77]:22) using \"publickey\".",
    ]) expect(sshLineClassifies(line)).toBe(false);
    for (const line of [
      "Host key verification failed.",
      "alice@home.example.test: Permission denied (publickey).",
      "Warning: remote port forwarding failed for listen port 19002",
      "ssh: connect to host home.example.test port 22: Connection refused",
      "Connection to home.example.test closed by remote host.",
      "an ssh error no rule knows",
    ]) expect(sshLineClassifies(line)).toBe(true);
  });

  test("filtering a DEBUG1 transcript yields the class the ERROR-level transcript yields", () => {
    const transcripts: Array<{ debug: string[]; error: string[] }> = [
      { // A healthy tunnel that served refused channels, then dropped with an unclassified exit.
        debug: ["OpenSSH_9.6p1, LibreSSL 3.3.6", "debug1: Connecting to h [203.0.113.77] port 22.",
          "Authenticated to h ([203.0.113.77]:22) using \"publickey\".", "channel 2: open failed: connect failed: Connection refused",
          "debug1: connect_next: connect to 127.0.0.1 port 19001: Connection refused", "Transferred: sent 1, received 2 bytes, in 3.0 seconds"],
        error: [],
      },
      { debug: ["debug1: Connecting to h [203.0.113.77] port 22.", "debug1: Authentications that can continue: publickey",
        "debug1: No more authentication methods to try.", "alice@h: Permission denied (publickey)."],
      error: ["alice@h: Permission denied (publickey)."] },
      { debug: ["debug1: remote forward failure for: listen 19002, connect 127.0.0.1:19001",
        "Error: remote port forwarding failed for listen port 19002"],
      error: ["Error: remote port forwarding failed for listen port 19002"] },
      { debug: ["debug1: Server host key: ssh-ed25519 SHA256:abc", "No ED25519 host key is known for h and you have requested strict checking.",
        "Host key verification failed."],
      error: ["No ED25519 host key is known for h and you have requested strict checking.", "Host key verification failed."] },
      // Recorded from OpenSSH 10.3p1 against a server that sent its banner and closed: at
      // LogLevel=ERROR ssh printed nothing; the close and reset lines are logged at INFO.
      { debug: ["OpenSSH_10.3p1, LibreSSL 3.3.6", "debug1: Connecting to 127.0.0.1 [127.0.0.1] port 2222.",
        "debug1: Connection established.", "debug1: Local version string SSH-2.0-OpenSSH_10.3", "Connection closed by 127.0.0.1 port 2222"],
      error: [] },
      { debug: ["debug1: Connection established.", "Connection reset by 127.0.0.1 port 2222"], error: [] },
      { debug: ["debug1: Entering interactive session.", "Timeout, server 127.0.0.1 not responding."],
        error: [] },
      { debug: ["debug1: Connection established.", "Disconnected from 127.0.0.1 port 2222"], error: [] },
      // kex.c logs these two identification reasons with verbose_f; the read:/write: ones use error_f.
      { debug: ["debug1: Connection established.", "kex_exchange_identification: Connection closed by remote host"], error: [] },
      { debug: ["debug1: Connection established.", "kex_exchange_identification: banner line contains invalid characters"], error: [] },
      { debug: ["debug1: Connection established.", "kex_exchange_identification: read: Connection reset by peer"],
        error: ["kex_exchange_identification: read: Connection reset by peer"] },
      // logdie paths in packet.c and sshconnect.c log at INFO whatever level the macro names.
      { debug: ["debug1: Entering interactive session.", "ssh_dispatch_run_fatal: Connection to 127.0.0.1 port 2222: Broken pipe"], error: [] },
      { debug: ["debug1: Entering interactive session.", "ssh_dispatch_run_fatal: Connection to 127.0.0.1 port 2222: Operation timed out"], error: [] },
      { debug: ["debug1: Connecting to 127.0.0.1 [127.0.0.1] port 2222.", "Connection to 127.0.0.1 port 2222 timed out"], error: [] },
    ];
    for (const { debug, error } of transcripts) {
      const filtered = debug.filter(sshLineClassifies).join("\n");
      expect(classifySshStderr(filtered)).toBe(classifySshStderr(error.join("\n")));
    }
    // The unfiltered DEBUG1 text would have been misread as a network failure.
    expect(classifySshStderr(transcripts[0]!.debug.join("\n"))).toBe("network");
  });
});

