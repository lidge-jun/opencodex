/**
 * Context-window breakdown model: calibration against the measured prompt size and the health word.
 * Pure, no React. The categories and thresholds are ported from Magpie's internal/gui/assets/context.js.
 *
 * MIT License
 * Copyright (c) 2026 yetone
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

export const CONTEXT_CATEGORIES = ["system", "tools", "skills", "memory", "files", "results", "chat"] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

/** `contextBreakdown` on a /api/logs row: estimated tokens of the request as the client sent it. */
export interface ContextBreakdown {
  v: 1;
  parts: Record<ContextCategory, number>;
  /** Per conversation turn, oldest first. */
  turns: number[];
  /** Older turns summed together; their count is not known. */
  turnsEarlier?: number;
  toolCount: number;
  /** Earlier turns live upstream (previous_response_id) and are not in the body. */
  held?: true;
}

export interface ContextShares {
  parts: Record<ContextCategory, number>;
  turns: number[];
  turnsEarlier: number;
  /** Sum of the parts: the measured input when calibrated, else the estimate. */
  used: number;
  calibrated: boolean;
  held: boolean;
  toolCount: number;
}

/**
 * Scale every part and turn by counted / estimated so the pieces add up to what the provider
 * counted. A request with a held upstream history keeps its estimate: the counted input also
 * holds turns this body never carried, so a uniform scale would inflate the parts we can see.
 */
export function calibrateContext(breakdown: ContextBreakdown, counted: number | undefined): ContextShares {
  const estimated = CONTEXT_CATEGORIES.reduce((sum, category) => sum + breakdown.parts[category], 0);
  const held = breakdown.held === true;
  const calibrated = !held && counted !== undefined && counted > 0 && estimated > 0;
  const factor = calibrated ? counted / estimated : 1;
  const parts = {} as Record<ContextCategory, number>;
  for (const category of CONTEXT_CATEGORIES) parts[category] = breakdown.parts[category] * factor;
  return {
    parts,
    turns: breakdown.turns.map(turn => turn * factor),
    turnsEarlier: (breakdown.turnsEarlier ?? 0) * factor,
    used: estimated * factor,
    calibrated, held, toolCount: breakdown.toolCount,
  };
}

export type ContextHealth = "ok" | "filling" | "near";

/** <75% roomy, <90% filling up, else near the limit (Magpie's thresholds). */
export function contextHealth(fraction: number): ContextHealth {
  if (fraction < 0.75) return "ok";
  return fraction < 0.9 ? "filling" : "near";
}
