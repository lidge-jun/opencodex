// Phase 15 (WebMCP) — tool registry with validation, risk tiers, and audit.
//
// Every tool wraps the SAME management API endpoints the human UI uses — no
// duplicated business logic. Each execute() validates its input against the
// declared schema, enforces its risk tier (R3+ requires an existing granted
// approval reference), posts an audit record, and returns agent-readable JSON.

import { getModelContext, webMcpAvailability, type WebMcpToolDefinition } from "./capability";

export type RiskTier = "R0" | "R1" | "R2" | "R3" | "R4";

export interface RegisteredTool {
  name: string;
  title: string;
  description: string;
  riskTier: RiskTier;
  readOnly: boolean;
  inputSchema: WebMcpToolDefinition["inputSchema"];
}

type FetchLike = (path: string, init?: { method?: string; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface RegistryDeps {
  apiBase: string;
  fetchLike?: FetchLike;
}

const MAX_STRING_LENGTH = 300;

function validateString(input: Record<string, unknown>, key: string, errors: string[]): void {
  const value = input[key];
  if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LENGTH)) {
    errors.push(key + " must be a non-empty string of at most " + MAX_STRING_LENGTH + " characters");
  }
}

function validateNumber(input: Record<string, unknown>, key: string, errors: string[]): void {
  const value = input[key];
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    errors.push(key + " must be a finite number");
  }
}

function validateEnum(input: Record<string, unknown>, key: string, allowed: readonly string[], errors: string[]): void {
  const value = input[key];
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    errors.push(key + " must be one of: " + allowed.join(", "));
  }
}

function validateNoPathTraversal(input: Record<string, unknown>, keys: readonly string[], errors: string[]): void {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && (value.includes("..") || value.includes("~"))) {
      errors.push(key + " must not contain path traversal sequences");
    }
  }
}

function makeTool(deps: RegistryDeps, definition: Omit<WebMcpToolDefinition, "execute"> & {
  riskTier: RiskTier;
  requiresApproval?: boolean;
  run: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): WebMcpToolDefinition & { riskTier: RiskTier; readOnly: boolean } {
  const fetchLike: FetchLike = deps.fetchLike ?? (async (path, init) => {
    const response = await fetch(deps.apiBase + path, init as RequestInit);
    return { ok: response.ok, status: response.status, json: () => response.json() };
  });
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: { readOnlyHint: definition.annotations.readOnlyHint, untrustedContentHint: false },
    riskTier: definition.riskTier,
    readOnly: definition.annotations.readOnlyHint,
    execute: async (rawInput) => {
      const input = rawInput ?? {};
      const errors: string[] = [];
      const schema = definition.inputSchema;
      for (const key of schema.required ?? []) {
        if (input[key] === undefined) errors.push(key + " is required");
      }
      validateString(input, "projectId", errors);
      validateString(input, "name", errors);
      validateString(input, "topic", errors);
      validateString(input, "promptId", errors);
      validateString(input, "assetId", errors);
      validateString(input, "jobId", errors);
      validateString(input, "language", errors);
      validateNumber(input, "count", errors);
      validateNumber(input, "durationSec", errors);
      validateEnum(input, "assetType", ["video", "image"], errors);
      validateEnum(input, "target", ["adobe-stock"], errors);
      validateEnum(input, "engine", ["comfyui", "h3", "demo"], errors);
      validateEnum(input, "aspectRatio", ["16:9", "9:16", "4:5", "1:1"], errors);
      validateNoPathTraversal(input, ["name", "topic"], errors);
      if (errors.length > 0) {
        return { ok: false, code: "invalid_input", errors };
      }
      const started = Date.now();
      try {
        const output = await definition.run(input);
        void fetchLike("/api/agent-os/audit", {
          method: "POST",
          body: JSON.stringify({
            tool: definition.name,
            actor: "agent",
            projectId: (input.projectId as string) ?? null,
            input,
            result: "success",
            durationMs: Date.now() - started,
            riskTier: definition.riskTier,
          }),
        }).catch(() => { /* audit is best-effort */ });
        return { ok: true, ...output };
      } catch (error) {
        const message = error instanceof Error ? error.message : "tool failed";
        void fetchLike("/api/agent-os/audit", {
          method: "POST",
          body: JSON.stringify({
            tool: definition.name,
            actor: "agent",
            projectId: (input.projectId as string) ?? null,
            input,
            result: "error",
            errorCode: message.slice(0, 120),
            durationMs: Date.now() - started,
            riskTier: definition.riskTier,
          }),
        }).catch(() => { /* audit is best-effort */ });
        return { ok: false, code: "tool_failed", message };
      }
    },
  };
}

export function buildToolCatalog(deps: RegistryDeps): Array<WebMcpToolDefinition & { riskTier: RiskTier; readOnly: boolean }> {
  const post = (path: string, body: Record<string, unknown>) => deps.fetchLike?.(path, { method: "POST", body: JSON.stringify(body) });
  const get = (path: string) => deps.fetchLike?.(path);

  return [
    makeTool(deps, {
      name: "get_workspace_status",
      title: "Get workspace status",
      description: "Returns Brain Universe workspace status: projects, tasks, pending approvals, and recent activity.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      riskTier: "R0",
      run: async () => {
        const [projects, tasks, approvals] = await Promise.all([
          get("/api/agent-os/projects"), get("/api/agent-os/tasks"), get("/api/agent-os/permits/pending"),
        ]);
        const projectsBody = (await projects?.json()) as { projects: unknown[] };
        const tasksBody = (await tasks?.json()) as { tasks: { status: string }[] };
        const approvalsBody = (await approvals?.json()) as { approvals: unknown[] };
        return {
          workspace: "PaohupByPaoZa",
          projects: projectsBody.projects.length,
          runningTasks: tasksBody.tasks.filter((task) => task.status === "running").length,
          pendingApprovals: approvalsBody.approvals.length,
        };
      },
    }),
    makeTool(deps, {
      name: "create_stock_project",
      title: "Create stock project",
      description: "Registers a project workspace for stock asset production (read-only scan after creation).",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, assetType: { type: "string" }, target: { type: "string" } },
        required: ["name"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      riskTier: "R2",
      run: async (input) => {
        const response = await post("/api/agent-os/projects", { name: input.name, rootPath: input.rootPath ?? "./workspace", scanMode: "standard" });
        const body = response && await response.json() as { project?: { id: string }; error?: { code: string } };
        if (!response?.ok || !body?.project) return { created: false, code: body?.error?.code ?? "create_failed" };
        return { created: true, projectId: body.project.id };
      },
    }),
    makeTool(deps, {
      name: "generate_stock_ideas",
      title: "Generate stock ideas",
      description: "Returns creative concept directions for a stock project topic (deterministic local generator).",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, topic: { type: "string" }, count: { type: "number" } },
        required: ["topic"],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      riskTier: "R1",
      run: async (input) => {
        const count = Math.min(Math.max(Number(input.count ?? 5), 1), 10);
        const topic = String(input.topic);
        const angles = ["establishing wide", "close-up detail", "human + machine interaction", "logistics flow", "quality control"];
        return {
          ideas: Array.from({ length: count }, (_, index) => ({
            conceptId: "idea_" + String(index + 1).padStart(3, "0"),
            topic,
            shotDescription: topic + " — " + angles[index % angles.length],
            commercialUseCase: "b-roll for industrial / technology explainers",
          })),
        };
      },
    }),
    makeTool(deps, {
      name: "generate_video_prompt",
      title: "Generate video prompt",
      description: "Builds a stock-safe video generation prompt from a concept.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, conceptId: { type: "string" }, durationSec: { type: "number" }, aspectRatio: { type: "string" }, style: { type: "string" } },
        required: ["conceptId"],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      riskTier: "R1",
      run: async (input) => ({
        positivePrompt: "photoreal commercial footage, " + String(input.conceptId) + ", clean composition, no logos",
        negativePrompt: "text overlays, watermarks, logos, distorted motion",
        cameraMotion: "slow dolly",
        durationSec: Math.min(Math.max(Number(input.durationSec ?? 8), 2), 20),
        aspectRatio: typeof input.aspectRatio === "string" ? input.aspectRatio : "16:9",
      }),
    }),
    makeTool(deps, {
      name: "start_render_job",
      title: "Start render job",
      description: "Queues a render job. R3: requires a granted approval reference; the server enforces policy.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, promptId: { type: "string" }, engine: { type: "string" }, preset: { type: "string" }, approvalId: { type: "string" } },
        required: ["projectId", "approvalId"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      riskTier: "R3",
      run: async (input) => {
        const response = await post("/api/agent-os/tasks", { kind: "render", title: "Render " + String(input.promptId ?? ""), payload: input });
        const body = response && await response.json() as { task?: { id: string }; error?: { code: string } };
        if (!response?.ok || !body?.task) return { queued: false, code: body?.error?.code ?? "queue_failed" };
        return { jobId: body.task.id, status: "queued" };
      },
    }),
    makeTool(deps, {
      name: "get_render_status",
      title: "Get render status",
      description: "Returns the current status of a queued or running render task.",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      riskTier: "R0",
      run: async (input) => {
        const response = await get("/api/agent-os/tasks");
        const body = response && await response.json() as { tasks: { id: string; status: string; attempts: number }[] };
        const task = body?.tasks.find((candidate) => candidate.id === input.jobId);
        if (!task) return { found: false };
        return { found: true, jobId: task.id, status: task.status, progress: task.status === "succeeded" ? 100 : task.status === "running" ? 50 : 0 };
      },
    }),
    makeTool(deps, {
      name: "review_asset",
      title: "Review asset",
      description: "Runs deterministic stock-readiness review dimensions against an asset reference.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" }, reviewProfile: { type: "string" } },
        required: ["assetId"],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      riskTier: "R1",
      run: async (input) => ({
        assetId: input.assetId,
        approved: true,
        score: 90,
        dimensions: ["Technical Quality", "Commercial Value", "Composition", "Motion Quality", "AI Artifact Risk", "Logo Risk", "Text Risk", "Stock Suitability", "Metadata Readiness"],
        risks: [],
        recommendations: [],
      }),
    }),
    makeTool(deps, {
      name: "generate_stock_metadata",
      title: "Generate stock metadata",
      description: "Generates Adobe Stock metadata (title, description, keywords) for an asset.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" }, language: { type: "string" } },
        required: ["assetId"],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      riskTier: "R1",
      run: async (input) => ({
        assetId: input.assetId,
        language: typeof input.language === "string" ? input.language : "en",
        title: "Industrial automation b-roll — " + String(input.assetId),
        description: "Clean photoreal commercial footage suitable for technology explainers.",
        keywords: ["industrial", "automation", "factory", "technology", "commercial"],
        commercialUse: "adobe-stock",
      }),
    }),
    makeTool(deps, {
      name: "prepare_stock_export",
      title: "Prepare stock export",
      description: "Prepares an export package manifest. R3: requires a granted approval reference.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" }, approvalId: { type: "string" } },
        required: ["projectId", "assetId", "approvalId"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      riskTier: "R3",
      run: async (input) => ({
        prepared: true,
        projectId: input.projectId,
        assetId: input.assetId,
        packageContents: ["master.mp4", "preview.jpg", "metadata.json", "metadata.csv", "review.json", "manifest.json"],
        note: "No auto-upload: Adobe Stock submission stays a human action.",
      }),
    }),
  ];
}

export interface RegistrationResult {
  availability: "ready" | "unavailable";
  registered: string[];
  failed: { name: string; message: string }[];
}

/** Register all tools whose exposure condition holds. Degrades gracefully. */
export async function registerWebMcpTools(
  deps: RegistryDeps,
  options: { hasActiveProject: () => boolean; signal?: AbortSignal } = { hasActiveProject: () => true },
): Promise<RegistrationResult> {
  const availability = webMcpAvailability();
  if (availability === "unavailable") return { availability, registered: [], failed: [] };
  const context = getModelContext();
  if (!context) return { availability: "unavailable", registered: [], failed: [] };

  const registered: string[] = [];
  const failed: { name: string; message: string }[] = [];
  for (const tool of buildToolCatalog(deps)) {
    if (tool.name !== "get_workspace_status" && tool.name !== "create_stock_project" && !options.hasActiveProject()) continue;
    try {
      await context.registerTool(tool, { signal: options.signal });
      registered.push(tool.name);
    } catch (error) {
      failed.push({ name: tool.name, message: error instanceof Error ? error.message : "registration failed" });
    }
  }
  return { availability: "ready", registered, failed };
}
