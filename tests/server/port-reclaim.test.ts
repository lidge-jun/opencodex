import { describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:net";
import * as childProcess from "node:child_process";
import {
  listenAddressServes,
  normalizeListenAddress,
  parseListenEntriesFromLsof,
  parseListenEntriesFromNetstat,
  parseListenEntriesFromSs,
  scanListenPidsForAddress,
  ownsIpv4LoopbackListener,
  parseIpv4LoopbackListenPidsFromNetstat,
  parseProcLoopbackListenInodes,
  reclaimListenPort,
  type ReclaimListenPortOptions,
} from "../../src/server/port-reclaim";
import {
  isBareIpv6Address,
  parseTcpQuadsForLocalPort,
  dropWindowsTcpRowsForLocalPort,
} from "../../src/server/windows-tcp-drop";
import { parseListenPidsFromNetstat } from "../../src/server/port-reclaim";

/** Exercise several scans and the deadline without depending on wall-clock scheduling. */
async function reclaimWithMockClock(options: ReclaimListenPortOptions): Promise<boolean> {
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    return await reclaimListenPort(10100, "127.0.0.1", {
      ...options, timeoutMs: 50, intervalMs: 10, scanIntervalMs: 10,
      sleepMs: async () => { now += 10; },
    });
  } finally {
    clock.mockRestore();
  }
}

describe("parseListenPidsFromNetstat", () => {
  test("extracts Windows LISTENING owners for the local port", () => {
    const output = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:10100        0.0.0.0:0              LISTENING       18268",
      "  TCP    127.0.0.1:10100        127.0.0.1:60001        CLOSE_WAIT      18268",
      "  TCP    0.0.0.0:54321          0.0.0.0:0              LISTENING       99",
    ].join("\n");
    expect(parseListenPidsFromNetstat(output, 10100)).toEqual([18268]);
  });

  test("extracts unix netstat -anlp listen PIDs", () => {
    const output = [
      "tcp        0      0 127.0.0.1:10100         0.0.0.0:*               LISTEN      4242/bun",
      "tcp        0      0 127.0.0.1:22            0.0.0.0:*               LISTEN      1/sshd",
    ].join("\n");
    expect(parseListenPidsFromNetstat(output, 10100)).toEqual([4242]);
  });
});

describe("exact IPv4 loopback listener ownership", () => {
  test("recorded proc TCP rows keep IPv4 and mapped IPv4 LISTEN inodes, excluding ::1", () => {
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:61A8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  501        0 44001 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:61A8 00000000:0000 01 00000000:00000000 00:00000000 00000000  501        0 44002 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    const tcp6 = [
      "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000000000000000000001000000:61A8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 501 0 44003 1 0000000000000000 100 0 0 10 0",
      "   1: 0000000000000000FFFF00000100007F:61A8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 501 0 44004 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    expect(parseProcLoopbackListenInodes(tcp, tcp6, 25000)).toEqual(["44001", "44004"]);
  });

  test("Linux maps the exact loopback inode through the expected PID's fd without a tool", async () => {
    const tcp = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
      + "0: 0100007F:61A8 00000000:0000 0A 00000000:00000000 00:00000000 00000000 501 0 44001 1\n";
    const tcp6 = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
      + "0: 00000000000000000000000001000000:61A8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 501 0 44002 1\n";
    const paths: string[] = [];
    const io = {
      platform: "linux" as const,
      readProc: async (path: string) => path.endsWith("tcp6") ? tcp6 : tcp,
      listFds: async (path: string) => { paths.push(path); return ["3", "4"]; },
      readFdLink: async (path: string) => path.endsWith("/4") ? "socket:[44001]" : "anon_inode:[eventpoll]",
      run: async () => { throw new Error("external process lookup must not run on Linux"); },
    };
    expect(await ownsIpv4LoopbackListener(25000, 42, io)).toBe(true);
    expect(paths).toEqual(["/proc/42/fd"]);
    expect(await ownsIpv4LoopbackListener(25000, 43, { ...io,
      readFdLink: async () => "socket:[44002]" })).toBe(false);
  });

  test("Windows netstat ignores a foreign IPv6 listener on the same numeric port", () => {
    const rows = [
      "  TCP    127.0.0.1:25000        0.0.0.0:0              LISTENING       42",
      "  TCP    [::1]:25000            [::]:0                 LISTENING       99",
    ].join("\n");
    expect(parseIpv4LoopbackListenPidsFromNetstat(rows, 25000)).toEqual([42]);
  });

  test.skipIf(process.platform !== "darwin")("a foreign ::1 listener does not veto the owned IPv4 socket", async () => {
    const ipv4 = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("v4") });
    const port = ipv4.port!;
    const child = Bun.spawn([process.execPath, "--eval",
      'Bun.serve({ hostname: "::1", port: Number(process.env.OCX_TEST_PORT), fetch: () => new Response("v6") }); await new Promise(() => {});',
    ], { env: { ...process.env, OCX_TEST_PORT: String(port) }, stdout: "ignore", stderr: "pipe" });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
        if (child.exitCode !== null) throw new Error("IPv6 listener exited before binding");
        ready = await fetch(`http://[::1]:${port}/`).then(response => response.status === 200).catch(() => false);
        if (!ready) await Bun.sleep(30);
      }
      expect(ready).toBe(true);
      expect(await ownsIpv4LoopbackListener(port, process.pid)).toBe(true);
      expect(await ownsIpv4LoopbackListener(port, child.pid)).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      ipv4.stop(true);
    }
  });

  test.skipIf(process.platform !== "linux")("finds its own LISTEN inode with lsof and netstat absent from PATH", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = "/no-lsof-or-netstat";
      expect(await ownsIpv4LoopbackListener(server.port!, process.pid)).toBe(true);
    } finally {
      server.stop(true);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

describe("listen-entry parsers keep the bound address", () => {
  test("netstat entries report each listener's local address", () => {
    const output = [
      "tcp        0      0 127.0.0.1:10100         0.0.0.0:*               LISTEN      4242/bun",
      "tcp        0      0 127.0.0.2:10100         0.0.0.0:*               LISTEN      7777/foreign",
      "tcp        0      0 127.0.0.1:22            0.0.0.0:*               LISTEN      1/sshd",
    ].join("\n");
    expect(parseListenEntriesFromNetstat(output, 10100)).toEqual([
      { pid: 4242, address: "127.0.0.1" },
      { pid: 7777, address: "127.0.0.2" },
    ]);
  });

  test("ss -Hltnp rows report address and pid; unattributed rows are dropped", () => {
    const output = [
      "LISTEN 0      128        127.0.0.1:10100       0.0.0.0:*    users:((\"bun\",pid=4242,fd=20))",
      "LISTEN 0      128        127.0.0.2:10100       0.0.0.0:*    users:((\"foreign\",pid=7777,fd=6))",
      "LISTEN 0      128        127.0.0.3:10100       0.0.0.0:*    users:((\"pid=4242\",pid=9999,fd=4))",
      "LISTEN 0      128        127.0.0.1:10100       0.0.0.0:*",
      "LISTEN 0      511                *:22              *:*    users:((\"sshd\",pid=1,fd=3))",
    ].join("\n");
    expect(parseListenEntriesFromSs(output, 10100)).toEqual([
      { pid: 4242, address: "127.0.0.1" },
      { pid: 7777, address: "127.0.0.2" },
      { pid: 9999, address: "127.0.0.3" },
    ]);
  });

  test("ss rows with a forged owner inside an embedded-quote process name are dropped", () => {
    // ss prints comm inside quotes without escaping it, so these rows are what the
    // kernel actually prints for the crafted 15-byte task names on the right.
    const output = [
      // comm `x",pid=4141,"` — the forged pid leads after naive quote stripping.
      'LISTEN 0 128 127.0.0.1:10100 0.0.0.0:* users:(("x",pid=4141,"",pid=9999,fd=4))',
      // comm `",pid=4141,fd=1),("` — a complete forged tuple in front of the real one.
      'LISTEN 0 128 127.0.0.2:10100 0.0.0.0:* users:(("",pid=4141,fd=1),("",pid=9999,fd=4))',
      // comm `x",pid=4141,f=9` — a forged in-tuple field with a non-ss key.
      'LISTEN 0 128 127.0.0.3:10100 0.0.0.0:* users:(("x",pid=4141,f=9",pid=9999,fd=4))',
      // comm `x",pid=4141,fd=9` — even an ss key cannot rescue a forged field.
      'LISTEN 0 128 127.0.0.4:10100 0.0.0.0:* users:(("x",pid=4141,fd=9",pid=9999,fd=4))',
      // A genuinely shared socket still reports every owner tuple.
      'LISTEN 0 128 127.0.0.5:10100 0.0.0.0:* users:(("bun",pid=4242,fd=20),("worker",pid=4243,fd=3))',
      // Trailing garbage after the column is rejected too.
      'LISTEN 0 128 127.0.0.6:10100 0.0.0.0:* users:(("bun",pid=4244,fd=20))extra',
    ].join("\n");
    expect(parseListenEntriesFromSs(output, 10100)).toEqual([
      { pid: 4242, address: "127.0.0.5" },
      { pid: 4243, address: "127.0.0.5" },
    ]);
  });

  test("lsof NAME column supplies the bound address", () => {
    const output = [
      "COMMAND  PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
      "bun     4242 devin   20u  IPv4 0xdeadbeef      0t0  TCP 127.0.0.1:10100 (LISTEN)",
      "other   7777 devin   21u  IPv4 0xdeadbeef      0t0  TCP 127.0.0.2:10100 (LISTEN)",
    ].join("\n");
    expect(parseListenEntriesFromLsof(output, 10100)).toEqual([
      { pid: 4242, address: "127.0.0.1" },
      { pid: 7777, address: "127.0.0.2" },
    ]);
  });

  test("address matching treats wildcards as serving any bound address", () => {
    expect(listenAddressServes("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(listenAddressServes("127.0.0.2", "127.0.0.1")).toBe(false);
    expect(listenAddressServes("0.0.0.0", "127.0.0.1")).toBe(true);
    expect(listenAddressServes("*", "127.0.0.1")).toBe(true);
    expect(listenAddressServes("::", "127.0.0.1")).toBe(true);
    expect(listenAddressServes("[::1]:443", "::1")).toBe(true);
    expect(normalizeListenAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(listenAddressServes("::ffff:127.0.0.1", "127.0.0.1")).toBe(true);
  });

  const multiAddressCases = [
    {
      name: "Windows netstat", parse: parseListenEntriesFromNetstat,
      rows: [
        "TCP 127.0.0.1:10100 0.0.0.0:0 LISTENING 4242",
        "TCP 127.0.0.2:10100 0.0.0.0:0 LISTENING 4242",
        "TCP [::ffff:127.0.0.1]:10100 [::]:0 LISTENING 4242",
      ],
    },
    {
      name: "POSIX netstat", parse: parseListenEntriesFromNetstat,
      rows: [
        "tcp 0 0 127.0.0.1:10100 0.0.0.0:* LISTEN 4242/ssh",
        "tcp 0 0 127.0.0.2:10100 0.0.0.0:* LISTEN 4242/ssh",
        "tcp 0 0 127.0.0.1:10100 0.0.0.0:* LISTEN 4242/ssh",
      ],
    },
    {
      name: "ss", parse: parseListenEntriesFromSs,
      rows: [
        'LISTEN 0 128 127.0.0.1:10100 0.0.0.0:* users:(("ssh",pid=4242,fd=3))',
        'LISTEN 0 128 127.0.0.2:10100 0.0.0.0:* users:(("ssh",pid=4242,fd=4))',
        'LISTEN 0 128 [::ffff:127.0.0.1]:10100 [::]:* users:(("ssh",pid=4242,fd=5))',
      ],
    },
    {
      name: "lsof", parse: parseListenEntriesFromLsof,
      rows: [
        "ssh 4242 user 3u IPv4 0x1 0t0 TCP 127.0.0.1:10100 (LISTEN)",
        "ssh 4242 user 4u IPv4 0x2 0t0 TCP 127.0.0.2:10100 (LISTEN)",
        "ssh 4242 user 5u IPv6 0x3 0t0 TCP [::ffff:127.0.0.1]:10100 (LISTEN)",
      ],
    },
  ];
  for (const { name, parse, rows } of multiAddressCases) {
    for (const reverse of [false, true]) {
      test(`${name} retains all same-PID addresses with reverse=${reverse}`, () => {
        const ordered = reverse ? [...rows].reverse() : rows;
        const entries = parse([...ordered, ordered[0]].join("\n"), 10100);
        expect([...entries].sort((a, b) => a.address.localeCompare(b.address))).toEqual([
          { pid: 4242, address: "127.0.0.1" },
          { pid: 4242, address: "127.0.0.2" },
        ]);
        for (const address of ["127.0.0.1", "127.0.0.2"]) {
          expect(entries.filter(entry => listenAddressServes(entry.address, address)).map(entry => entry.pid)).toEqual([4242]);
        }
      });
    }
  }

  test("the PID-only netstat API still deduplicates multiple addresses", () => {
    expect(parseListenPidsFromNetstat(multiAddressCases[0]!.rows.join("\n"), 10100)).toEqual([4242]);
  });

  test("the address-scoped scanner filters before deduplicating same-PID listeners", () => {
    const fixture = process.platform === "win32" ? multiAddressCases[0]! : multiAddressCases[3]!;
    for (const reverse of [false, true]) {
      const rows = reverse ? [...fixture.rows].reverse() : fixture.rows;
      const scan = spyOn(childProcess, "execFileSync").mockImplementation(() => rows.join("\n"));
      try {
        expect(scanListenPidsForAddress(10100)).toEqual({ ok: true, pids: [4242] });
        expect(scanListenPidsForAddress(10100, "127.0.0.1")).toEqual({ ok: true, pids: [4242] });
        expect(scanListenPidsForAddress(10100, "127.0.0.2")).toEqual({ ok: true, pids: [4242] });
        expect(scanListenPidsForAddress(10100, "127.0.0.3")).toEqual({ ok: true, pids: [] });
        expect(scanListenPidsForAddress(10100, "0.0.0.0")).toEqual({ ok: true, pids: [4242] });
      } finally {
        scan.mockRestore();
      }
    }
  });
});

describe("scanListenPidsForAddress (real scanner)", () => {
  test("finds this process on its own bound port and filters other addresses", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (typeof address === "object" && address) {
        const scan = scanListenPidsForAddress(address.port, "127.0.0.1");
        // Missing platform tools must report a failed scan rather than an empty result.
        if (scan.ok) expect(scan.pids).toContain(process.pid);
      }
    } finally {
      server.close();
    }
  });

  test("a listener on another loopback address does not serve 127.0.0.1", async () => {
    const server = createServer();
    const bound = await new Promise<boolean>(resolve => {
      server.once("error", () => resolve(false));
      server.listen(0, "127.0.0.2", () => resolve(true));
    });
    if (!bound) return;
    try {
      const address = server.address();
      if (typeof address === "object" && address) {
        const scan = scanListenPidsForAddress(address.port, "127.0.0.1");
        if (scan.ok) expect(scan.pids).not.toContain(process.pid);
        const wide = scanListenPidsForAddress(address.port, "0.0.0.0");
        if (wide.ok) expect(wide.pids).toContain(process.pid);
      }
    } finally {
      server.close();
    }
  });
});

describe("parseTcpQuadsForLocalPort / IPv6", () => {
  test("collects every TCP row on the local port including non-LISTEN states", () => {
    const output = [
      "  TCP    127.0.0.1:10100        0.0.0.0:0              LISTENING       18268",
      "  TCP    127.0.0.1:10100        127.0.0.1:60001        CLOSE_WAIT      18268",
      "  TCP    127.0.0.1:10100        127.0.0.1:62066        ESTABLISHED     18268",
      "  TCP    127.0.0.1:62066        127.0.0.1:10100        ESTABLISHED     14492",
    ].join("\n");
    expect(parseTcpQuadsForLocalPort(output, 10100)).toEqual([
      { localAddr: "127.0.0.1", localPort: 10100, remoteAddr: "0.0.0.0", remotePort: 0, state: "LISTENING" },
      { localAddr: "127.0.0.1", localPort: 10100, remoteAddr: "127.0.0.1", remotePort: 60001, state: "CLOSE_WAIT" },
      { localAddr: "127.0.0.1", localPort: 10100, remoteAddr: "127.0.0.1", remotePort: 62066, state: "ESTABLISHED" },
    ]);
  });

  test("keeps IPv6 local rows parseable without coercing them into IPv4 wildcards", () => {
    const output = [
      "  TCP    [::1]:10100            [::]:0                 LISTENING       18268",
      "  TCP    [::]:10100             [::]:0                 LISTENING       18268",
      "  TCP    127.0.0.1:10100        0.0.0.0:0              LISTENING       18268",
    ].join("\n");
    const rows = parseTcpQuadsForLocalPort(output, 10100);
    expect(rows.some(r => r.localAddr === "::1")).toBe(true);
    expect(rows.some(r => r.localAddr === "::")).toBe(true);
    expect(rows.some(r => r.localAddr === "127.0.0.1")).toBe(true);
    expect(isBareIpv6Address("::1")).toBe(true);
    expect(isBareIpv6Address("::")).toBe(true);
    expect(isBareIpv6Address("127.0.0.1")).toBe(false);
    expect(isBareIpv6Address("::ffff:127.0.0.1")).toBe(false);
  });

  test("dropWindowsTcpRowsForLocalPort never claims IPv6 rows as dropped on non-Windows", () => {
    // On non-win32 the function is a no-op; on win32 without matching rows it still
    // reports skippedIpv6 for parsed IPv6 quads when netstat is readable. Assert the
    // return shape never coerces IPv6 into a positive dropped count from IPv4 APIs alone.
    if (process.platform !== "win32") {
      expect(dropWindowsTcpRowsForLocalPort(10100)).toEqual({ dropped: 0, skippedIpv6: 0, accessDenied: 0 });
    }
  });
});

describe("reclaimListenPort", () => {
  test("does not kill any ocx listener by default (healthy proxy / stale pid files)", async () => {
    const killed: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      isAvailableFn: async () => false,
      listListenPidsFn: () => [4242],
      isAliveFn: () => true,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
  });

  test("does not kill when killOcxHolders is true but allowlist is empty", async () => {
    const killed: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killOcxHolders: true,
      onlyKillPids: [],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [4242],
      isAliveFn: () => true,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
  });

  test("concurrent pinned-start shape: second start never kills the first ocx listener", async () => {
    const killed: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killOcxHolders: false,
      isAvailableFn: async () => false,
      listListenPidsFn: () => [1111],
      isAliveFn: () => true,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
  });

  test("kills only the allowlisted ocx pid after revalidation", async () => {
    const killed: number[] = [];
    const verified: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killOcxHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [100, 200],
      isAliveFn: () => true,
      verifyOcxFn: pid => {
        verified.push(pid);
        return pid;
      },
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([100]);
    expect(verified.filter(pid => pid === 100).length).toBeGreaterThanOrEqual(2);
  });

  test("unknown old PID: update-style reclaim kills no ocx listener", async () => {
    const killed: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killOcxHolders: false,
      onlyKillPids: [],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [777],
      isAliveFn: () => true,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
  });

  test("does not kill foreign (non-ocx) listeners and does not drop their TCP rows", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killOcxHolders: true,
      onlyKillPids: [999],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [555],
      isAliveFn: () => true,
      verifyOcxFn: () => null,
      killFn: pid => {
        killed.push(pid);
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("listener-scan failure does not kill or reset TCP rows", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killOcxHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => false,
      listListenPidsFn: () => ({ ok: false, error: "lsof/netstat unavailable" }),
      isAliveFn: () => true,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("ignores dead owner PIDs still listed by the OS", async () => {
    const killed: number[] = [];
    let ticks = 0;
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killOcxHolders: true,
      onlyKillPids: [18268],
      isAvailableFn: async () => {
        ticks += 1;
        return ticks > 2;
      },
      listListenPidsFn: () => [18268],
      isAliveFn: () => false,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(killed).toEqual([]);
  });

  test("resets TCP rows only when no live foreign/protected listener remains", async () => {
    let available = false;
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      isAvailableFn: async () => available,
      listListenPidsFn: () => [],
      dropTcpFn: port => {
        dropped.push(port);
        available = true;
        return { dropped: 3, skippedIpv6: 1, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(dropped).toEqual([10100]);
  });

  test("returns true once the port becomes available after allowlisted cleanup", async () => {
    let available = false;
    const killed: number[] = [];
    const pending = reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 500,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killOcxHolders: true,
      onlyKillPids: [4242],
      isAvailableFn: async () => available,
      listListenPidsFn: () => (available ? [] : [4242]),
      isAliveFn: () => true,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
        available = true;
      },
      sleepMs: async () => {},
    });
    await expect(pending).resolves.toBe(true);
    expect(killed).toEqual([4242]);
  });

  test("skips kill across later scans when allowlisted pid fails revalidation", async () => {
    const killed: number[] = [];
    let available = false;
    let checks = 0;
    await expect(reclaimWithMockClock({
      dropTcpRows: false,
      killOcxHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => available,
      listListenPidsFn: () => (available ? [] : [100]),
      isAliveFn: () => !available,
      verifyOcxFn: pid => {
        checks += 1;
        // Scan identity succeeds, then pre-kill revalidation and later scans reject it.
        return checks === 1 ? pid : null;
      },
      killFn: pid => {
        killed.push(pid);
        available = true;
      },
    })).resolves.toBe(false);
    expect(checks).toBeGreaterThanOrEqual(3);
    expect(killed).toEqual([]);
  });

  test("does not drop TCP rows across later scans after allowlisted revalidation fails", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    let alive = true;
    let available = false;
    let checks = 0;
    await expect(reclaimWithMockClock({
      dropTcpRows: true,
      killOcxHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => available,
      listListenPidsFn: () => (alive ? [100] : []),
      isAliveFn: () => alive,
      verifyOcxFn: pid => {
        checks += 1;
        return checks === 1 ? pid : null;
      },
      killFn: pid => {
        killed.push(pid);
        alive = false;
      },
      dropTcpFn: port => {
        dropped.push(port);
        available = true;
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
    })).resolves.toBe(false);
    expect(checks).toBeGreaterThanOrEqual(3);
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("does not kill or drop TCP rows for an allowlisted non-ocx listener", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimWithMockClock({
      dropTcpRows: true,
      killOcxHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [100],
      isAliveFn: () => true,
      verifyOcxFn: () => null,
      killFn: pid => {
        killed.push(pid);
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("does not drop TCP rows when allowlisted kill throws", async () => {
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killOcxHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [100],
      isAliveFn: () => true,
      verifyOcxFn: pid => pid,
      killFn: () => {
        throw new Error("kill failed");
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(dropped).toEqual([]);
  });

  test("does not drop TCP rows while allowlisted ocx survives kill", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killOcxHolders: true,
      onlyKillPids: [100],
      isAvailableFn: async () => false,
      listListenPidsFn: () => [100],
      isAliveFn: () => true,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([100]);
    expect(dropped).toEqual([]);
  });

  test("drops TCP rows only after allowlisted ocx is confirmed dead", async () => {
    let alive = true;
    let available = false;
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killOcxHolders: true,
      onlyKillPids: [4242],
      isAvailableFn: async () => available,
      listListenPidsFn: () => (alive ? [4242] : []),
      isAliveFn: () => alive,
      verifyOcxFn: pid => pid,
      killFn: () => {
        alive = false;
      },
      dropTcpFn: port => {
        dropped.push(port);
        available = true;
        return { dropped: 2, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(dropped).toEqual([10100]);
  });

  test("killAllOcxOnPort kills ocx listeners absent from the allowlist snapshot", async () => {
    const killed: number[] = [];
    let holder = 9001;
    let available = false;
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killOcxHolders: true,
      killAllOcxOnPort: true,
      onlyKillPids: [100], // pre-update PID — respawned child is 9001
      isAvailableFn: async () => available,
      listListenPidsFn: () => (holder > 0 ? [holder] : []),
      isAliveFn: pid => pid === holder,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
        if (pid === holder) holder = 0;
      },
      sleepMs: async () => {
        if (holder === 0) available = true;
      },
    })).resolves.toBe(true);
    expect(killed).toEqual([9001]);
  });

  test("foreign non-ocx claimant survives reclaim without allowlist or ocx identity", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      killOcxHolders: true,
      killAllOcxOnPort: true,
      onlyKillPids: [4242], // trusted old PID — different from the foreign holder
      isAvailableFn: async () => false,
      listListenPidsFn: () => [777],
      isAliveFn: () => true,
      verifyOcxFn: () => null,
      killFn: pid => {
        killed.push(pid);
      },
      dropTcpFn: port => {
        dropped.push(port);
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("allowlisted PID that fails ocx verify stays protected until the deadline", async () => {
    const killed: number[] = [];
    const dropped: number[] = [];
    let alive = true;
    let available = false;
    await expect(reclaimWithMockClock({
      dropTcpRows: true,
      killOcxHolders: true,
      onlyKillPids: [14772],
      isAvailableFn: async () => available,
      // This holder is still alive; a historical PID does not override verifier rejection.
      listListenPidsFn: () => (alive ? [14772] : []),
      isAliveFn: () => alive,
      verifyOcxFn: () => null,
      killFn: pid => {
        killed.push(pid);
        alive = false;
      },
      dropTcpFn: port => {
        dropped.push(port);
        available = true;
        return { dropped: 1, skippedIpv6: 0, accessDenied: 0 };
      },
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test.each([false, true])("a different verifier PID is rejected with killAllOcxOnPort=%s", async killAllOcxOnPort => {
    const killed: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimWithMockClock({
      dropTcpRows: true, killOcxHolders: true, killAllOcxOnPort, onlyKillPids: [100],
      isAvailableFn: async () => false, listListenPidsFn: () => [100], isAliveFn: () => true,
      verifyOcxFn: () => 200,
      killFn: pid => { killed.push(pid); },
      dropTcpFn: port => { dropped.push(port); return 1; },
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("a later successful verification can reclaim a previously rejected holder", async () => {
    let alive = true;
    let available = false;
    let checks = 0;
    const checksAtKill: number[] = [];
    const dropped: number[] = [];
    await expect(reclaimWithMockClock({
      dropTcpRows: true, killOcxHolders: true, onlyKillPids: [100],
      isAvailableFn: async () => available, listListenPidsFn: () => alive ? [100] : [],
      isAliveFn: () => alive,
      verifyOcxFn: pid => ++checks === 1 ? null : pid,
      killFn: () => { checksAtKill.push(checks); alive = false; },
      dropTcpFn: port => { dropped.push(port); available = true; return 1; },
    })).resolves.toBe(true);
    expect(checksAtKill).toEqual([3]); // rejected scan, accepted scan, accepted pre-kill check
    expect(dropped).toEqual([10100]);
  });

  test("dead ghost then same PID reused is killed again under killAllOcxOnPort", async () => {
    const killed: number[] = [];
    let phase: "first-live" | "ghost" | "reuse" = "first-live";
    let available = false;
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      killOcxHolders: true,
      killAllOcxOnPort: true,
      onlyKillPids: [],
      isAvailableFn: async () => available,
      listListenPidsFn: () => [4242],
      isAliveFn: () => phase !== "ghost",
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
        if (phase === "first-live") phase = "ghost";
        else if (phase === "reuse") available = true;
      },
      sleepMs: async () => {
        if (phase === "ghost") phase = "reuse";
      },
    })).resolves.toBe(true);
    expect(killed).toEqual([4242, 4242]);
  });
});
