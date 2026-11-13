/**
 * Context-window breakdown model: calibration against the measured prompt size, health word,
 * and the treemap layout. Pure, no React.
 *
 * The squarified layout, the share^0.35 easing of the used share and the tile floors are ported
 * from Magpie's internal/gui/assets/context.js.
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

export interface ContextTile {
  kind: ContextCategory | "free";
  /** 1-based position among the turns this row lists; only on a per-turn chat tile. */
  turn?: number;
  /** The merged tile for turns older than the listed ones. */
  earlier?: true;
  tokens: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Magpie's constants: item tile floor/threshold in px^2, most turn tiles, thinnest part/item tile. */
const TILE_MIN_AREA = 1500;
const TILE_MAX_TURNS = 12;
const TILE_FLOOR_AREA = 700;
const PART_MIN_SIDE = 16;
const TURN_MIN_SIDE = 14;
const USED_MIN_LEN = 36;

interface Cell<T> { v: number; item: T }
interface Placed<T> { item: T; x: number; y: number; w: number; h: number }

/** Bruls, Huizing and van Wijk: rectangles with sides as near alike as possible, in `cells` order. */
function squarify<T>(cells: Array<Cell<T>>, x: number, y: number, w: number, h: number): Array<Placed<T>> {
  const out: Array<Placed<T>> = [];
  const live = cells.filter(cell => cell.v > 0);
  const total = live.reduce((sum, cell) => sum + cell.v, 0);
  if (total <= 0 || w <= 0 || h <= 0) return out;
  const k = (w * h) / total;
  const worst = (row: Array<Cell<T>>, side: number): number => {
    let sum = 0;
    let hi = 0;
    let lo = Infinity;
    for (const cell of row) {
      const area = cell.v * k;
      sum += area;
      hi = Math.max(hi, area);
      lo = Math.min(lo, area);
    }
    return Math.max((side * side * hi) / (sum * sum), (sum * sum) / (side * side * lo));
  };
  const lay = (row: Array<Cell<T>>): void => {
    const sum = row.reduce((s, cell) => s + cell.v * k, 0);
    if (w >= h) {
      const colW = sum / h;
      let cy = y;
      for (const cell of row) {
        const cellH = (cell.v * k) / colW;
        out.push({ item: cell.item, x, y: cy, w: colW, h: cellH });
        cy += cellH;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = sum / w;
      let cx = x;
      for (const cell of row) {
        const cellW = (cell.v * k) / rowH;
        out.push({ item: cell.item, x: cx, y, w: cellW, h: rowH });
        cx += cellW;
      }
      y += rowH;
      h -= rowH;
    }
  };
  let row: Array<Cell<T>> = [];
  for (const cell of live) {
    const side = Math.min(w, h);
    if (row.length === 0 || worst([...row, cell], side) <= worst(row, side)) {
      row.push(cell);
      continue;
    }
    lay(row);
    row = [cell];
  }
  if (row.length > 0) lay(row);
  return out;
}

/** No tile smaller than TILE_FLOOR_AREA px^2: a sliver cannot be pointed at. */
function floored<T>(cells: Array<Cell<T>>, area: number): Array<Cell<T>> {
  const sum = cells.reduce((s, cell) => s + cell.v, 0);
  const lo = (sum * TILE_FLOOR_AREA) / Math.max(1, area);
  return cells.map(cell => ({ ...cell, v: Math.max(cell.v, lo) }));
}

interface TurnItem { turn?: number; earlier?: true }

/** The chat rect split per turn: latest turns each, older ones merged, or null when they would be slivers. */
function chatTurnTiles(shares: ContextShares, rect: Placed<unknown>): ContextTile[] | null {
  const area = rect.w * rect.h;
  const listed = shares.turns.length;
  const whole = shares.turns.reduce((s, v) => s + v, 0) + shares.turnsEarlier;
  if (listed === 0 || whole <= 0 || area < TILE_MIN_AREA * 2) return null;
  for (let keep = Math.min(listed, TILE_MAX_TURNS); keep >= 1; keep--) {
    const first = listed - keep;
    const cells: Array<Cell<TurnItem>> = [];
    for (let i = listed - 1; i >= first; i--) cells.push({ v: shares.turns[i]!, item: { turn: i + 1 } });
    const older = shares.turnsEarlier + shares.turns.slice(0, first).reduce((s, v) => s + v, 0);
    if (older > 0) cells.push({ v: older, item: { earlier: true } });
    cells.sort((a, b) => b.v - a.v);
    const laid = squarify(floored(cells, area), rect.x, rect.y, rect.w, rect.h);
    if (laid.length === 0 || laid.some(tile => Math.min(tile.w, tile.h) < TURN_MIN_SIDE)) continue;
    const real = new Map(cells.map(cell => [cell.item, cell.v]));
    return laid.map(tile => ({
      kind: "chat" as const, ...tile.item, tokens: (real.get(tile.item)! / whole) * shares.parts.chat,
      x: tile.x, y: tile.y, w: tile.w, h: tile.h,
    }));
  }
  return null;
}

/**
 * Lay the request out as tiles in a width x height box. Parts are squarified inside the used
 * share of the window; the used share is drawn as share^0.35 of the box (at least 36px) so a mostly
 * empty window still leaves room to read its tiles, and the free space fills the rest. An unknown
 * window gets no free tile. The tiles cover the box exactly, without overlap.
 */
export function layoutTiles(shares: ContextShares, windowTokens: number | undefined, width: number, height: number): ContextTile[] {
  if (!(width > 0) || !(height > 0)) return [];
  const used = CONTEXT_CATEGORIES.reduce((sum, category) => sum + Math.max(0, shares.parts[category]), 0);
  const scale = Math.max(windowTokens ?? used, used, 1);
  const across = width >= height;
  const long = across ? width : height;
  const hasFree = used < scale;
  let usedLen = long;
  if (hasFree) {
    const eased = used > 0 ? long * Math.pow(used / scale, 0.35) : 0;
    usedLen = used > 0 ? Math.min(long, Math.max(eased, Math.min(long, USED_MIN_LEN))) : 0;
  }
  const tiles: ContextTile[] = [];
  const usedRect: [number, number, number, number] = across ? [0, 0, usedLen, height] : [0, 0, width, usedLen];
  const present = CONTEXT_CATEGORIES.filter(category => shares.parts[category] > 0);

  if (present.length > 0) {
    const cells = floored(present.map(category => ({ v: shares.parts[category], item: category })), usedRect[2] * usedRect[3]);
    let placed = squarify(cells, ...usedRect);
    for (let pass = 0; pass < 8; pass++) {
      const thin = placed.filter(rect => Math.min(rect.w, rect.h) < PART_MIN_SIDE);
      if (thin.length === 0) break;
      for (const rect of thin) {
        const cell = cells.find(c => c.item === rect.item)!;
        cell.v *= (PART_MIN_SIDE / Math.max(1, Math.min(rect.w, rect.h))) * 1.05;
      }
      placed = squarify(cells, ...usedRect);
    }
    for (const rect of placed) {
      const split = rect.item === "chat" ? chatTurnTiles(shares, rect) : null;
      if (split) tiles.push(...split);
      else tiles.push({ kind: rect.item, tokens: shares.parts[rect.item], x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    }
  }
  if (hasFree) {
    const free: [number, number, number, number] = across ? [usedLen, 0, width - usedLen, height] : [0, usedLen, width, height - usedLen];
    tiles.push({ kind: "free", tokens: scale - used, x: free[0], y: free[1], w: free[2], h: free[3] });
  }
  return tiles;
}
