export const START_USAGE = "Usage: ocx start [--port <port>] [--socks5 [host:port] | --socks5-off]";
export const START_USAGE_LINE = "ocx start [--port <port>] [--socks5 [host:port] | --socks5-off]";
export const DEFAULT_SOCKS5_PROXY = "socks5://127.0.0.1:10808";

export class StartArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartArgsError";
  }
}

export type StartOptions = {
  port?: number;
  /** SOCKS5 URL to persist. */
  socks5?: string;
  socks5Off?: boolean;
};

export function isSocksProxyUrl(proxy: string): boolean {
  return /^socks5h?:\/\//i.test(proxy.trim());
}

export function normalizeSocks5(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_SOCKS5_PROXY;
  if (isSocksProxyUrl(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const port = Number(parsed.port);
      if (!parsed.hostname || !parsed.port || !Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error("invalid host or port");
      }
      return trimmed;
    } catch {
      throw new StartArgsError(`Invalid SOCKS5 address: ${trimmed}`);
    }
  }
  if (/^socks4a?:\/\//i.test(trimmed)) {
    throw new StartArgsError("Only SOCKS5 proxy URLs are supported");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    throw new StartArgsError("SOCKS5 proxy must be socks5://host:port, not an HTTP URL");
  }
  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new StartArgsError("Invalid SOCKS5 port number");
    }
    return `socks5://127.0.0.1:${port}`;
  }
  const hostPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(trimmed);
  if (hostPort) {
    const port = Number(hostPort[2]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new StartArgsError("Invalid SOCKS5 port number");
    }
    return `socks5://${trimmed}`;
  }
  throw new StartArgsError(`Invalid SOCKS5 address: ${trimmed}`);
}

export function parseStartOptions(argv: string[]): StartOptions {
  const options: StartOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--port") {
      const value = argv[++i];
      const port = value && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new StartArgsError("Invalid port number");
      }
      options.port = port;
      continue;
    }
    if (arg === "--socks5") {
      if (options.socks5Off) throw new StartArgsError("--socks5 and --socks5-off cannot be used together");
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        options.socks5 = normalizeSocks5(next);
        i += 1;
      } else {
        options.socks5 = DEFAULT_SOCKS5_PROXY;
      }
      continue;
    }
    if (arg === "--socks5-off") {
      if (options.socks5 !== undefined) throw new StartArgsError("--socks5 and --socks5-off cannot be used together");
      options.socks5Off = true;
      continue;
    }
    throw new StartArgsError(START_USAGE);
  }
  return options;
}
