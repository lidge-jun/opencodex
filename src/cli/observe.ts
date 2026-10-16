import {
  CliUsageError,
  RuntimeApiError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeFlag,
  takeIntegerOption,
  takeOption,
  takeOptionWithSyntax,
  type RuntimeApiDeps,
} from "./runtime-api";
import { followLogs } from "./log-follow";
import { handleLogFilterCommand } from "./log-view-filter";
import { followInjection } from "./injection-follow";
import type { ObserveStreamDeps } from "./observe-stream";
import { formatUsageReport } from "./usage-report";
import { handleUsageCompareCommand } from "./usage-compare";
import { selectUsageModelView, takeUsageSearchOption } from "./usage-model-search";
import { USAGE_RANGES, USAGE_SURFACES, type UsageSummary, type UsageFilterEcho } from "../usage/summary";
import { parseUsageTimeWindow, type UsageTimeWindow } from "../usage/time-range";
import { redactSecretString } from "../lib/redact";
import { readClientConnectionState, sameClientConnectionOwner } from "../client/state";
import { readServiceApiTokenState } from "../lib/service-secrets";
import { fetchHubUsage } from "../client/hub-client";
import type { HubUsageReport } from "../remote/hub-usage";

const USAGE = `Usage:
  ocx observe logs [--provider <name>] [--model <id>] [--status <code>]
      [--conversation <id>] [--account <label>] [--limit <n>] [--follow] [--json|--jsonl] [--events]
  ocx logs explain <request-id> [--json]
  ocx logs filter [selectors] [--scan-limit <1..2000>] [--limit <1..2000>] [--json|--jsonl]
  ocx logs rebuild-index
  ocx logs index-status
  ocx observe usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>]
      [--since <epoch-ms|ISO-datetime>] [--until <epoch-ms|ISO-datetime>]
  ocx usage compare [--range <today|1d|7d|30d>] [--surface <all|codex|claude|grok>]
      [--provider <name>] [--model <id>] [--api-key-id <id>] [--json]
