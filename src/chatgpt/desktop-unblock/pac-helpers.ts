/** Small, strict classic-PAC helpers. This module never evaluates PAC source. */
export const PAC_LIMITS = Object.freeze({
  sourceBytes: 4 * 1024 * 1024, resultBytes: 8 * 1024, routes: 32,
  heapBytes: 32 * 1024 * 1024, cpuMs: 100, wallMs: 2_000,
  startupMs: 5_000, dnsMs: 750, queue: 32, dnsCalls: 16,
  helperCalls: 512, inputBytes: 16 * 1024, parserTokens: 100_000,
});

export function ipv4Number(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  if (parts.some(part => part > 255)) return null;
  return parts.reduce((total, part) => (total * 256 + part) >>> 0, 0);
}

/** No URL interpretation, IDNA conversion, ambiguous numeric hosts, or credentials. */
export function validDnsName(host: string): boolean {
  if (ipv4Number(host) !== null) return true;
  if (/^[\d.]+$/.test(host) || /^0x[\da-f]+$/i.test(host)) return false;
  return host.length <= 253 && host.replace(/\.$/, "").split(".")
    .every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
}

/** PAC specifies only '*' and '?'. Reject extensions rather than treating them as literals. */
export function shellMatch(text: string, pattern: string): boolean {
  if (pattern.length > 2_048 || /[\[\]{}\\()|]/.test(pattern)) throw new Error("Unsupported PAC shell pattern");
  let input = 0, token = 0, star = -1, retry = 0;
  while (input < text.length) {
    if (pattern[token] === "?" || pattern[token] === text[input]) { input++; token++; }
    else if (pattern[token] === "*") { star = token++; retry = input; }
    else if (star >= 0) { token = star + 1; input = ++retry; }
    else return false;
  }
  while (pattern[token] === "*") token++;
  return token === pattern.length;
}

export function classicPacHelper(
  name: string, args: readonly string[], dns: (host: string) => string | null,
): string | number | boolean | null {
  const arity = (count: number) => { if (args.length !== count) throw new Error("Invalid PAC helper arguments"); };
  switch (name) {
    case "isPlainHostName": arity(1); return !args[0]!.includes(".");
    case "dnsDomainIs": arity(2); return args[0]!.endsWith(args[1]!);
    case "localHostOrDomainIs":
      arity(2); return args[0] === args[1] || (!args[0]!.includes(".") && args[1]!.startsWith(`${args[0]}.`));
    case "dnsDomainLevels": arity(1); return args[0]!.split(".").length - 1;
    case "shExpMatch": arity(2); return shellMatch(args[0]!, args[1]!);
    case "dnsResolve": arity(1); return dns(args[0]!);
    case "isResolvable": arity(1); return dns(args[0]!) !== null;
    case "isInNet": {
      arity(3);
      const network = ipv4Number(args[1]!), mask = ipv4Number(args[2]!);
      if (network === null || mask === null) throw new Error("Unsupported PAC network address");
      const address = dns(args[0]!);
      if (address === null) return false;
      const ip = ipv4Number(address);
      if (ip === null) throw new Error("Unsupported PAC DNS answer");
      return (ip & mask) === (network & mask);
    }
    case "weekdayRange": {
      const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      const values = [...args];
      const utc = values[values.length - 1] === "GMT";
      if (utc) values.pop();
      if (values.length < 1 || values.length > 2 || values.some(value => !weekdays.includes(value))) {
        throw new Error("Unsupported PAC weekday arguments");
      }
      const now = new Date(), day = utc ? now.getUTCDay() : now.getDay();
      const start = weekdays.indexOf(values[0]!), end = weekdays.indexOf(values[1] ?? values[0]!);
      return start <= end ? day >= start && day <= end : day >= start || day <= end;
    }
    default: throw new Error("Unsupported PAC helper");
  }
}
