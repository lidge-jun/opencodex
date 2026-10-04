// RTK constants (mirror Rust rtk defaults and 9router)
export const RAW_CAP = 10 * 1024 * 1024;      // 10 MiB
export const MIN_COMPRESS_SIZE = 500;          // bytes; skip tiny blobs
export const DETECT_WINDOW = 1024;             // autodetect peeks first N chars
export const GIT_DIFF_HUNK_MAX_LINES = 100;    // per-hunk line cap
export const GIT_DIFF_CONTEXT_KEEP = 3;        // context lines around changes
export const GIT_LOG_MAX_LINES = 200;          // gitLog line cap
export const DEDUP_LINE_MAX = 2000;            // dedupLog truncation cap

// pipe_cmd parity caps
export const GREP_PER_FILE_MAX = 10;
export const FIND_PER_DIR_MAX = 10;
export const FIND_TOTAL_DIR_MAX = 20;

// git status caps
export const STATUS_MAX_FILES = 10;
export const STATUS_MAX_UNTRACKED = 10;

// ls compact_ls
export const LS_EXT_SUMMARY_TOP = 5;
export const LS_NOISE_DIRS: readonly string[] = [
  "node_modules", ".git", "target", "__pycache__",
  ".next", "dist", "build", ".cache", ".turbo",
  ".vercel", ".pytest_cache", ".mypy_cache", ".tox",
  ".venv", "venv",
  "env",
  "coverage", ".nyc_output", ".DS_Store", "Thumbs.db",
  ".idea", ".vscode", ".vs", "*.egg-info", ".eggs",
];

// tree filter_tree_output cap
export const TREE_MAX_LINES = 200;

// searchList
export const SEARCH_LIST_PER_DIR_MAX = 10;
export const SEARCH_LIST_TOTAL_DIR_MAX = 20;

// Smart truncate fallback
export const SMART_TRUNCATE_HEAD = 120;
export const SMART_TRUNCATE_TAIL = 60;
export const SMART_TRUNCATE_MIN_LINES = 250;

// readNumbered
export const READ_NUMBERED_MIN_HIT_RATIO = 0.7;

export const DEFAULT_HEADROOM_URL = "http://localhost:8787";
export const DEFAULT_HEADROOM_TIMEOUT_MS = 30000;

export const FILTERS = {
  GIT_DIFF: "git-diff",
  GIT_STATUS: "git-status",
  GIT_LOG: "git-log",
  GREP: "grep",
  FIND: "find",
  LS: "ls",
  TREE: "tree",
  DEDUP_LOG: "dedup-log",
  SMART_TRUNCATE: "smart-truncate",
  READ_NUMBERED: "read-numbered",
  SEARCH_LIST: "search-list",
  BUILD_OUTPUT: "build-output",
} as const;
