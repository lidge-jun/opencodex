/** Domain hub: maps Frontier boards to task domains (coding, security, …). */

import type { FrontierBenchmark } from "./frontier-types";

export type FrontierDomain =
  | "coding"
  | "frontend"
  | "terminal"
  | "security"
  | "intelligence";

export type FrontierDomainFilter = FrontierDomain | "all";

/** Board id → domains it belongs to. */
export const FRONTIER_BOARD_DOMAINS: Record<string, FrontierDomain[]> = {
  deepswe: ["coding"],
  "aa-coding-agent": ["coding"],
  "aa-intelligence-index": ["intelligence"],
  frontiercode: ["coding"],
  frontierswe: ["coding"],
  "terminal-bench-2.1": ["terminal"],
  "program-bench": ["coding"],
  "swe-marathon": ["coding"],
  "frontend-code-arena": ["frontend"],
  cybench: ["security"],
};

export const FRONTIER_DOMAIN_ORDER: FrontierDomainFilter[] = [
  "all",
  "coding",
  "frontend",
  "terminal",
  "security",
  "intelligence",
];

export function domainsForBoard(boardId: string): FrontierDomain[] {
  return FRONTIER_BOARD_DOMAINS[boardId] ?? [];
}

export function boardMatchesDomain(board: FrontierBenchmark, domain: FrontierDomainFilter): boolean {
  if (domain === "all") return true;
  return domainsForBoard(board.id).includes(domain);
}

export function filterBoardsByDomain(
  boards: FrontierBenchmark[],
  domain: FrontierDomainFilter,
): FrontierBenchmark[] {
  return boards.filter(b => boardMatchesDomain(b, domain));
}

/**
 * Column count that avoids a lonely last-row orphan when possible
 * (e.g. 10 → 5×2, 9 → 3×3, 6 → 3×2, 7 → 4+3).
 */
export function boardGridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 3) return count;
  let best = 3;
  let bestScore = -Infinity;
  for (let cols = Math.min(5, count); cols >= 2; cols--) {
    const rem = count % cols;
    const lastRow = rem === 0 ? cols : rem;
    // Prefer exact fill, then fuller last rows, then fewer columns.
    const score = (rem === 0 ? 1000 : 0) + lastRow * 10 - cols;
    if (score > bestScore) {
      bestScore = score;
      best = cols;
    }
  }
  return best;
}
