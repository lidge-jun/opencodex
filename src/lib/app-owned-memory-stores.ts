import {
  enforceAppOwnedMemoryBudget,
  registerRetainedStore,
  registerObservedBuffer,
  type RetainedStoreRegistration,
  type RetainedStoreSnapshot,
} from "./app-owned-memory";
import { registerStateSweepAfterTick } from "./state-store-sweeper";
import { debugBufferMetrics, evictOldestDebugEntryForBudget } from "./debug-log-buffer";
import { injectionBufferMetrics, evictOldestInjectionEntryForBudget } from "./injection-debug-log";
import { crashRingMetrics, evictOldestCrashTraceForBudget } from "./crash-guard";
import { claudeInboundDebugMetrics, evictOldestClaudeInboundForBudget } from "../claude/inbound-debug";
import {
  evictOldestRequestLogForBudget,
  requestLogRetainedStoreSnapshot,
} from "../server/request-log";
import {
  anthropicImageNormalizeRetainedStoreSnapshot,
  evictOldestAnthropicImageNormalizeForBudget,
} from "../adapters/anthropic-image-normalize";
import {
  evictOldestVisionDescriptionForBudget,
  visionDescriptionRetainedStoreSnapshot,
} from "../vision";
import {
  antigravityReplayRetainedStoreSnapshot,
  evictOldestAntigravityReplayForBudget,
} from "../adapters/google-antigravity-replay";
import {
  evictOldestModelCacheForBudget,
  modelCacheRetainedStoreSnapshot,
} from "../codex/model-cache";
import {
  evictOldestUsageSummaryForBudget,
  usageSummaryRetainedStoreSnapshot,
} from "../server/management/usage-summary-cache";
import {
  discardRetainedUsageSnapshot,
  retainedUsageSnapshotStats,
} from "../usage/log";
import {
  discardRetainedUsageAggregate,
  usageAggregateRetainedStats,
} from "../server/management/usage-aggregate-cache";
import {
  cursorBlobRetainedStoreSnapshot,
  evictOldestCursorBlobForBudget,
} from "../adapters/cursor/native-exec";
import {
  evictOldestResponseContinuationForBudget,
  responseContinuationRetainedStoreSnapshot,
} from "../responses/state";
import { translatorObservedBufferSnapshot } from "./translator-budget";
import { imageFulfillmentTailSnapshot } from "../images/fulfill";
import { oauthMutationTailSnapshot } from "../oauth/store";
import { grokApplyFlightSnapshot } from "../server/management/agent-settings-routes";

function ringSnapshot(metrics: { entries: number; bytes: number; oldestAt: number | null }): RetainedStoreSnapshot {
  return {
    count: metrics.entries,
    bytes: metrics.bytes,
    evictableBytes: metrics.bytes,
    pinnedBytes: 0,
    oldestAt: metrics.oldestAt,
  };
}

/** Legacy parsed tail and streaming aggregate share one stable public store id. */
function usageSnapshotRetainedStoreSnapshot(): RetainedStoreSnapshot {
  const legacy = retainedUsageSnapshotStats();
  const aggregate = usageAggregateRetainedStats();
  const oldest = [legacy.oldestAt, aggregate.oldestAt]
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)[0] ?? null;
  return {
    count: legacy.count + aggregate.count,
    bytes: legacy.bytes + aggregate.bytes,
    evictableBytes: legacy.bytes + aggregate.evictableBytes,
    pinnedBytes: aggregate.pinnedBytes,
    oldestAt: oldest,
  };
}

function evictOldestUsageSnapshot(): number {
  const legacy = retainedUsageSnapshotStats();
  const aggregate = usageAggregateRetainedStats();
  if (legacy.bytes > 0
    && (aggregate.evictableBytes === 0
      || (legacy.oldestAt ?? Number.POSITIVE_INFINITY) <= (aggregate.oldestAt ?? Number.POSITIVE_INFINITY))) {
    return discardRetainedUsageSnapshot();
  }
  return discardRetainedUsageAggregate();
}

function providerDebugSnapshot(): RetainedStoreSnapshot {
  return ringSnapshot(debugBufferMetrics());
}

function injectionDebugSnapshot(): RetainedStoreSnapshot {
  return ringSnapshot(injectionBufferMetrics());
}

function claudeDebugSnapshot(): RetainedStoreSnapshot {
  return ringSnapshot(claudeInboundDebugMetrics());
}

function crashRingSnapshot(): RetainedStoreSnapshot {
  return ringSnapshot(crashRingMetrics());
}

export const APP_OWNED_RETAINED_STORE_REGISTRATIONS = [
  {
    id: "request_log",
    category: "logs",
    snapshot: requestLogRetainedStoreSnapshot,
    evictOldest: evictOldestRequestLogForBudget,
  },
  {
    id: "provider_debug",
    category: "logs",
    snapshot: providerDebugSnapshot,
    evictOldest: evictOldestDebugEntryForBudget,
  },
  {
    id: "injection_debug",
    category: "logs",
    snapshot: injectionDebugSnapshot,
    evictOldest: evictOldestInjectionEntryForBudget,
  },
  {
    id: "claude_debug",
    category: "logs",
    snapshot: claudeDebugSnapshot,
    evictOldest: evictOldestClaudeInboundForBudget,
  },
  {
    id: "crash_ring",
    category: "logs",
    snapshot: crashRingSnapshot,
    evictOldest: evictOldestCrashTraceForBudget,
  },
  {
    id: "image_normalize",
    category: "caches",
    snapshot: anthropicImageNormalizeRetainedStoreSnapshot,
    evictOldest: evictOldestAnthropicImageNormalizeForBudget,
  },
  {
    id: "vision_descriptions",
    category: "caches",
    snapshot: visionDescriptionRetainedStoreSnapshot,
    evictOldest: evictOldestVisionDescriptionForBudget,
  },
  {
    id: "antigravity_replay",
    category: "caches",
    snapshot: antigravityReplayRetainedStoreSnapshot,
    evictOldest: evictOldestAntigravityReplayForBudget,
  },
  {
    id: "model_cache",
    category: "caches",
    snapshot: modelCacheRetainedStoreSnapshot,
    evictOldest: evictOldestModelCacheForBudget,
  },
  {
    id: "usage_summary",
    category: "caches",
    snapshot: usageSummaryRetainedStoreSnapshot,
    evictOldest: evictOldestUsageSummaryForBudget,
  },
  {
    id: "usage_snapshot",
    category: "caches",
    snapshot: usageSnapshotRetainedStoreSnapshot,
    evictOldest: evictOldestUsageSnapshot,
  },
  {
    id: "cursor_blobs",
    category: "blobs",
    snapshot: cursorBlobRetainedStoreSnapshot,
    evictOldest: evictOldestCursorBlobForBudget,
  },
  {
    id: "responses_continuation",
    category: "continuation",
    snapshot: responseContinuationRetainedStoreSnapshot,
    evictOldest: evictOldestResponseContinuationForBudget,
  },
] as const satisfies readonly RetainedStoreRegistration[];

export function registerDefaultAppOwnedMemoryStores(): void {
  for (const registration of APP_OWNED_RETAINED_STORE_REGISTRATIONS) {
    registerRetainedStore(registration);
  }
}

export const APP_OWNED_OBSERVED_BUFFER_REGISTRATIONS = [
  { id: "translator_buffers", category: "translator", snapshot: translatorObservedBufferSnapshot },
  { id: "image_fulfillment_tail", category: "serialized_tails", snapshot: imageFulfillmentTailSnapshot },
  { id: "oauth_mutation_tail", category: "serialized_tails", snapshot: oauthMutationTailSnapshot },
  { id: "grok_apply_flight", category: "serialized_tails", snapshot: grokApplyFlightSnapshot },
] as const;

export function registerDefaultAppOwnedObservedBuffers(): void {
  for (const registration of APP_OWNED_OBSERVED_BUFFER_REGISTRATIONS) registerObservedBuffer(registration);
}

export function registerAppOwnedMemorySweepFallback(): void {
  registerStateSweepAfterTick({
    name: "app-owned-memory-budget",
    afterTick: enforceAppOwnedMemoryBudget,
  });
}
