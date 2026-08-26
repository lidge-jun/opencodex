export type MutableHistoryBackupFixture = {
  version: number;
  stateDbPath?: unknown;
  entries: Record<string, {
    id?: unknown;
    rolloutPath?: unknown;
    modelProvider?: unknown;
    source?: unknown;
    hasUserEvent?: unknown;
  }>;
};

export interface InvalidHistoryBackupFixture {
  name: string;
  mutate: (manifest: MutableHistoryBackupFixture) => void;
}

export const INVALID_HISTORY_BACKUP_FIXTURES: InvalidHistoryBackupFixture[] = [
  { name: "missing state database identity", mutate: manifest => { delete manifest.stateDbPath; } },
  { name: "blank state database identity", mutate: manifest => { manifest.stateDbPath = ""; } },
  { name: "relative state database identity", mutate: manifest => { manifest.stateDbPath = "state.sqlite"; } },
  { name: "mismatched entry id", mutate: manifest => { manifest.entries["thread-1"].id = "thread-2"; } },
  { name: "missing rollout path", mutate: manifest => { delete manifest.entries["thread-1"].rolloutPath; } },
  { name: "blank rollout path", mutate: manifest => { manifest.entries["thread-1"].rolloutPath = ""; } },
  { name: "relative rollout path", mutate: manifest => { manifest.entries["thread-1"].rolloutPath = "rollout.jsonl"; } },
  { name: "missing model provider", mutate: manifest => { delete manifest.entries["thread-1"].modelProvider; } },
  { name: "mistyped model provider", mutate: manifest => { manifest.entries["thread-1"].modelProvider = 7; } },
  { name: "unsupported model provider", mutate: manifest => { manifest.entries["thread-1"].modelProvider = "other"; } },
  { name: "missing source", mutate: manifest => { delete manifest.entries["thread-1"].source; } },
  { name: "mistyped source", mutate: manifest => { manifest.entries["thread-1"].source = 7; } },
  { name: "invalid provider/source tuple", mutate: manifest => { manifest.entries["thread-1"].modelProvider = "opencodex"; } },
  { name: "missing event marker", mutate: manifest => { delete manifest.entries["thread-1"].hasUserEvent; } },
  { name: "mistyped event marker", mutate: manifest => { manifest.entries["thread-1"].hasUserEvent = "1"; } },
  { name: "non-boolean event marker", mutate: manifest => { manifest.entries["thread-1"].hasUserEvent = 2; } },
];

export function validHistoryBackupFixture(
  stateDbPath: string,
  rolloutPath: string,
): MutableHistoryBackupFixture {
  return {
    version: 1,
    stateDbPath,
    entries: {
      "thread-1": {
        id: "thread-1",
        rolloutPath,
        modelProvider: "openai",
        source: "cli",
        hasUserEvent: 1,
      },
    },
  };
}
