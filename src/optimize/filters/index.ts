import { FILTERS } from "../constants";
import { gitDiff } from "./gitDiff";
import { gitStatus } from "./gitStatus";
import { gitLog } from "./gitLog";
import { grep } from "./grep";
import { find } from "./find";
import { dedupLog } from "./dedupLog";
import { ls } from "./ls";
import { tree } from "./tree";
import { smartTruncate } from "./smartTruncate";
import { readNumbered } from "./readNumbered";
import { searchList } from "./searchList";
import { buildOutput } from "./buildOutput";

import type { FilterFunction } from "../types";
export type { FilterFunction };

const REGISTRY: Record<string, FilterFunction> = {
  [FILTERS.GIT_DIFF]: gitDiff as unknown as FilterFunction,
  [FILTERS.GIT_STATUS]: gitStatus as unknown as FilterFunction,
  [FILTERS.GIT_LOG]: gitLog as unknown as FilterFunction,
  [FILTERS.GREP]: grep as unknown as FilterFunction,
  [FILTERS.FIND]: find as unknown as FilterFunction,
  [FILTERS.DEDUP_LOG]: dedupLog as unknown as FilterFunction,
  [FILTERS.LS]: ls as unknown as FilterFunction,
  [FILTERS.TREE]: tree as unknown as FilterFunction,
  [FILTERS.SMART_TRUNCATE]: smartTruncate as unknown as FilterFunction,
  [FILTERS.READ_NUMBERED]: readNumbered as unknown as FilterFunction,
  [FILTERS.SEARCH_LIST]: searchList as unknown as FilterFunction,
  [FILTERS.BUILD_OUTPUT]: buildOutput as unknown as FilterFunction,
};

const ALIASES: Record<string, FilterFunction> = {
  rg: grep as unknown as FilterFunction,
  fd: find as unknown as FilterFunction,
};

export function resolveFilter(name: string): FilterFunction | null {
  return REGISTRY[name] || ALIASES[name] || null;
}

export function allFilters(): Record<string, FilterFunction> {
  return REGISTRY;
}

export {
  gitDiff,
  gitStatus,
  gitLog,
  grep,
  find,
  dedupLog,
  ls,
  tree,
  smartTruncate,
  readNumbered,
  searchList,
  buildOutput,
};
