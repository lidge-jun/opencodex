import { isIP } from "node:net";
import type { GuardrailsValidationOptions, GuardrailsValidator } from "./types";

function digitsOnly(value: string): string {
  let result = "";
  for (const character of value) {
    if (character >= "0" && character <= "9") result += character;
  }
  return result;
}

function allDigits(value: string): boolean {
  return value.length > 0 && [...value].every(character => character >= "0" && character <= "9");
}

function luhnValid(value: string): boolean {
  if (!allDigits(value)) return false;
  let sum = 0;
  const parity = value.length % 2;
  for (let index = 0; index < value.length; index += 1) {
    let digit = value.charCodeAt(index) - 48;
    if (index % 2 === parity) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function snilsValid(value: string): boolean {
  if (!allDigits(value) || value.length !== 11) return false;
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += (value.charCodeAt(index) - 48) * (9 - index);
  const checksum = (sum % 101) > 99 ? 0 : sum % 101;
  return Number(value.slice(9)) === checksum;
}

function weightedChecksum(value: string, weights: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < weights.length; index += 1) {
    sum += (value.charCodeAt(index) - 48) * weights[index]!;
  }
  return (sum % 11) % 10;
}

function innPersonValid(value: string): boolean {
  if (!allDigits(value) || value.length !== 12) return false;
  const first = weightedChecksum(value.slice(0, 10), [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  const second = weightedChecksum(`${value.slice(0, 10)}${first}`, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return Number(value[10]) === first && Number(value[11]) === second;
}

function innOrgValid(value: string): boolean {
  return allDigits(value) && value.length === 10
    && Number(value[9]) === weightedChecksum(value.slice(0, 9), [2, 4, 10, 3, 5, 9, 4, 6, 8]);
}

function decimalRemainder(value: string, divisor: number): number {
  let remainder = 0;
  for (const character of value) remainder = (remainder * 10 + character.charCodeAt(0) - 48) % divisor;
  return remainder;
}

function ogrnValid(value: string): boolean {
  return allDigits(value) && value.length === 13
    && Number(value[12]) === decimalRemainder(value.slice(0, 12), 11) % 10;
}

function ogrnipValid(value: string): boolean {
  return allDigits(value) && value.length === 15
    && Number(value[14]) === decimalRemainder(value.slice(0, 14), 13) % 10;
}

function ibanMod97Valid(value: string): boolean {
  const compact = value.replaceAll(" ", "").toUpperCase();
  if (compact.length < 4) return false;
  let remainder = 0;
  for (const character of `${compact.slice(4)}${compact.slice(0, 4)}`) {
    if (character >= "A" && character <= "Z") {
      const numeric = String(character.charCodeAt(0) - 55);
      for (const digit of numeric) remainder = (remainder * 10 + digit.charCodeAt(0) - 48) % 97;
    } else if (character >= "0" && character <= "9") {
      remainder = (remainder * 10 + character.charCodeAt(0) - 48) % 97;
    } else {
      return false;
    }
  }
  return remainder === 1;
}

function asciiLocalCharacter(character: string): boolean {
  if ((character >= "a" && character <= "z") || (character >= "A" && character <= "Z")) return true;
  if (character >= "0" && character <= "9") return true;
  return "!#$%&'*+-/=?^_`{|}~".includes(character);
}

function emailAsciiValid(candidate: string): boolean {
  const value = candidate.trim();
  if (value.length === 0 || value.length > 254) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || domain.length === 0 || domain.length > 253 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  for (const part of local.split(".")) {
    if (part.length === 0 || ![...part].every(asciiLocalCharacter)) return false;
  }
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const [index, label] of labels.entries()) {
    if (label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-")) return false;
    if (![...label].every(character => (character >= "a" && character <= "z") || (character >= "A" && character <= "Z") || (character >= "0" && character <= "9") || character === "-")) return false;
    if (index === labels.length - 1) {
      const asciiTld = [...label].every(character =>
        (character >= "a" && character <= "z") || (character >= "A" && character <= "Z")
      );
      const punycodeTld = /^xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$/i.test(label);
      if (!asciiTld && !punycodeTld) return false;
    }
  }
  return true;
}

function prefixInRange(value: string, length: number, lower: number, upper: number): boolean {
  if (value.length < length) return false;
  const prefix = value.slice(0, length);
  return allDigits(prefix) && Number(prefix) >= lower && Number(prefix) <= upper;
}

function paymentCardShape(value: string): boolean {
  if (!allDigits(value) || value.length < 13 || value.length > 19) return false;
  if (value.startsWith("4")) return value.length === 13 || value.length === 16 || value.length === 19;
  if (value.startsWith("34") || value.startsWith("37")) return value.length === 15;
  if (prefixInRange(value, 2, 51, 55) || prefixInRange(value, 4, 2221, 2720)) return value.length === 16;
  if (value.startsWith("6011") || prefixInRange(value, 3, 644, 649) || value.startsWith("65") || value.startsWith("62") || prefixInRange(value, 4, 2200, 2204)) return value.length >= 16 && value.length <= 19;
  return false;
}

function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const frequency = new Map<string, number>();
  for (const character of value) frequency.set(character, (frequency.get(character) ?? 0) + 1);
  let entropy = 0;
  const total = [...value].length;
  for (const count of frequency.values()) {
    const probability = count / total;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function ipPart(value: string): number | null {
  if (!allDigits(value) || value.length > 3) return null;
  const parsed = Number(value);
  return parsed <= 255 ? parsed : null;
}

function ipv4Parts(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const parsed = parts.map(ipPart);
  return parsed.every((part): part is number => part !== null) ? parsed : null;
}

function normalizeIpCandidate(candidate: string): string | null {
  const value = candidate.trim();
  const slash = value.indexOf("/");
  const address = (slash === -1 ? value : value.slice(0, slash)).replaceAll("[", "").replaceAll("]", "");
  if (address.length === 0 || isIP(address) === 0) return null;
  if (slash !== -1) {
    const prefix = value.slice(slash + 1);
    if (!allDigits(prefix)) return null;
    const maximum = isIP(address) === 4 ? 32 : 128;
    if (Number(prefix) > maximum) return null;
  }
  return address;
}

function ipv6Words(address: string): readonly number[] | null {
  const lower = address.toLowerCase();
  if (lower.includes(".")) {
    const separator = lower.lastIndexOf(":");
    if (separator < 0) return null;
    const dotted = ipv4Parts(lower.slice(separator + 1));
    if (!dotted) return null;
    const high = (dotted[0]! << 8) | dotted[1]!;
    const low = (dotted[2]! << 8) | dotted[3]!;
    return ipv6Words(`${lower.slice(0, separator)}:${high.toString(16)}:${low.toString(16)}`);
  }

  const halves = lower.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const raw = halves.length === 2
    ? [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    : left;
  const words = raw.map(word => /^[0-9a-f]{1,4}$/.test(word) ? Number.parseInt(word, 16) : Number.NaN);
  return words.length === 8 && words.every(Number.isFinite) ? words : null;
}

function mappedIpv4Parts(address: string): readonly number[] | null {
  if (isIP(address) !== 6) return null;
  const words = ipv6Words(address);
  if (!words || words.slice(0, 5).some(word => word !== 0) || words[5] !== 0xFFFF) return null;
  return [
    words[6]! >>> 8,
    words[6]! & 0xFF,
    words[7]! >>> 8,
    words[7]! & 0xFF,
  ];
}

function isPrivateOrLocalIpv4(parts: readonly number[]): boolean {
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254)
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first !== undefined && first >= 224);
}

function isPrivateOrLocal(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = ipv4Parts(address);
    return parts ? isPrivateOrLocalIpv4(parts) : false;
  }
  const mapped = mappedIpv4Parts(address);
  if (mapped) return isPrivateOrLocalIpv4(mapped);
  const compact = address.toLowerCase();
  return compact === "::" || compact === "::1" || compact.startsWith("fc") || compact.startsWith("fd")
    || compact.startsWith("fe8") || compact.startsWith("fe9") || compact.startsWith("fea")
    || compact.startsWith("feb") || compact.startsWith("ff");
}

export function validateGuardrailsCandidate(
  candidate: string,
  validators: readonly GuardrailsValidator[],
  options: GuardrailsValidationOptions = {},
): boolean {
  const digits = digitsOnly(candidate);
  for (const validator of validators) {
    if (validator === "luhn" && !luhnValid(digits)) return false;
    if (validator === "snils" && !snilsValid(digits)) return false;
    if (validator === "inn_person" && !innPersonValid(digits)) return false;
    if (validator === "inn_org" && !innOrgValid(digits)) return false;
    if (validator === "ogrn" && !ogrnValid(digits)) return false;
    if (validator === "ogrnip" && !ogrnipValid(digits)) return false;
    if (validator === "iban_mod97" && !ibanMod97Valid(candidate)) return false;
    if (validator === "email_ascii" && !emailAsciiValid(candidate)) return false;
    if (validator === "payment_card" && !(paymentCardShape(digits) && luhnValid(digits))) return false;
    if (validator === "payment_card_no_luhn" && !paymentCardShape(digits)) return false;
    if (validator === "entropy" && options.entropy !== undefined && shannonEntropy(candidate) < options.entropy) return false;
    if (validator === "banlist" && options.banlist?.some(entry => entry.toLowerCase() === candidate.toLowerCase())) return false;
    if (validator === "ip_v4" && normalizeIpCandidate(candidate) !== null && isIP(normalizeIpCandidate(candidate)!) !== 4) return false;
    if (validator === "ip_v4" && normalizeIpCandidate(candidate) === null) return false;
    if (validator === "ip_v6" && normalizeIpCandidate(candidate) !== null && isIP(normalizeIpCandidate(candidate)!) !== 6) return false;
    if (validator === "ip_v6" && normalizeIpCandidate(candidate) === null) return false;
    if (validator === "ip_public") {
      const address = normalizeIpCandidate(candidate);
      if (!address || isPrivateOrLocal(address)) return false;
    }
    if (validator === "ip_private") {
      const address = normalizeIpCandidate(candidate);
      if (!address || !isPrivateOrLocal(address)) return false;
    }
  }
  return true;
}
