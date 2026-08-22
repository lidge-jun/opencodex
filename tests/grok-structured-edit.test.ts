import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, OcxTool } from "../src/types";
import {
  encodeGrokEditForCodexSink,
  grokEditCodexSink,
  grokFacingTools,
  grokNativeCatalogTools,
  grokStructuredEditTools,
  isXaiGrokChatProvider,
  grokShellNeedsGitEscalation,
  reconstructGrokToolCallFromExec,
  rewriteAdapterEventsForGrokStructuredEdits,
  rewriteCodexFileEditGuidanceForGrok,
  rewriteGrokNativeCallEventList,
  rewriteGrokStructuredEditEvents,
  translateGrokShellCall,
  translateGrokStructuredEditCall,
} from "../src/adapters/grok-structured-edit";

const xai = { baseUrl: "https://api.x.ai/v1" };
const openai = { baseUrl: "https://api.openai.com/v1" };

const codeModeExec = (description: string): OcxTool => ({
  name: "exec",
  freeform: true,
  description,
  parameters: {},
});

const applyPatchHelper = "declare const tools: { apply_patch(input: string): Promise<unknown>; exec_command(cmd: string): Promise<unknown> }";
const liveCodexExecHelper = "Run JavaScript. declare const tools: { apply_patch(input: string): Promise<unknown>; };";

async function collect(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

describe("Grok structured edit tools", () => {
  test("rewrites Codex apply_patch edit constraints to Grok write/search_replace", () => {
    const codex = [
      "## File editing constraints",
      "",
      "Use `apply_patch` for local file edits. Do not create or edit files with `cat` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need `apply_patch`. Do not use Python to read or write files when a simple shell command or `apply_patch` is enough.",
      "",
      "## Something else",
    ].join("\n");
    const rewritten = rewriteCodexFileEditGuidanceForGrok(codex);
    expect(rewritten).toContain("File edits on this turn use the listed tools `write` and `search_replace`");
    expect(rewritten).toContain("Do not call `apply_patch` or `exec` unless this turn's catalog lists those exact names");
    expect(rewritten).toContain("## Something else");
    expect(rewritten).not.toContain("Use `apply_patch` for local file edits");
    expect(rewriteCodexFileEditGuidanceForGrok("Use apply_patch in a code comment")).toBe("Use apply_patch in a code comment");
  });

  test("detects xAI chat hosts only", () => {
    expect(isXaiGrokChatProvider(xai)).toBe(true);
    expect(isXaiGrokChatProvider({ baseUrl: "https://cli-chat-proxy.grok.com/v1" })).toBe(true);
    expect(isXaiGrokChatProvider(openai)).toBe(false);
    expect(isXaiGrokChatProvider({ baseUrl: "https://openrouter.ai/api/v1" })).toBe(false);
  });

  test("advertises the Grok Build catalog and hides exec on xAI code-mode turns", () => {
    const extras = grokStructuredEditTools([codeModeExec(applyPatchHelper)], undefined, xai);
    expect(extras.map(tool => tool.name)).toEqual(["search_replace", "write"]);
    expect(grokNativeCatalogTools([codeModeExec(applyPatchHelper)], undefined, xai).map(tool => tool.name)).toEqual([
      "read_file", "grep", "list_dir", "search_replace", "write", "run_terminal_command",
    ]);
    const facing = grokFacingTools(
      [codeModeExec(applyPatchHelper), { name: "wait", description: "wait", parameters: {} }],
      undefined,
      xai,
    );
    expect(facing?.map(tool => tool.name)).toEqual([
      "wait", "read_file", "grep", "list_dir", "search_replace", "write", "run_terminal_command",
    ]);
    const advertised = grokNativeCatalogTools([codeModeExec(applyPatchHelper)], undefined, xai);
    expect(advertised.find(tool => tool.name === "read_file")?.parameters).toMatchObject({ required: ["target_file"] });
    expect(advertised.find(tool => tool.name === "list_dir")?.parameters).toMatchObject({
      properties: { target_directory: { type: "string" } },
    });
    expect(advertised.find(tool => tool.name === "write")?.parameters).toMatchObject({ required: ["file_path", "content"] });
    expect(grokStructuredEditTools([codeModeExec(applyPatchHelper)], undefined, openai)).toEqual([]);
    expect(grokStructuredEditTools([codeModeExec("JavaScript only")], undefined, xai)).toEqual([]);
    expect(grokStructuredEditTools(
      [codeModeExec(applyPatchHelper), { name: "exec_command", parameters: {} } as OcxTool],
      undefined,
      xai,
    )).toEqual([]);
  });

  test("advertises the Grok catalog when Codex declares only apply_patch", () => {
    expect(grokNativeCatalogTools([codeModeExec(liveCodexExecHelper)], undefined, xai).map(tool => tool.name)).toEqual([
      "read_file", "grep", "list_dir", "search_replace", "write", "run_terminal_command",
    ]);
    expect(grokFacingTools([codeModeExec(liveCodexExecHelper)], undefined, xai)?.map(tool => tool.name)).toEqual([
      "read_file", "grep", "list_dir", "search_replace", "write", "run_terminal_command",
    ]);
  });

  test("does not shadow an already-listed search_replace and stays off in plan mode", () => {
    const existing: OcxTool = { name: "search_replace", description: "mcp", parameters: {} };
    const extras = grokStructuredEditTools([codeModeExec(applyPatchHelper), existing], undefined, xai);
    expect(extras.map(tool => tool.name)).toEqual(["write"]);
    expect(grokStructuredEditTools(
      [codeModeExec(applyPatchHelper)],
      undefined,
      xai,
      ["You are in **Plan Mode**"],
    )).toEqual([]);
  });

  test("keeps exec when caller collisions remove both native edit tools", () => {
    const callerSearch: OcxTool = { name: "search_replace", description: "caller search", parameters: {} };
    const callerWrite: OcxTool = { name: "write", description: "caller write", parameters: {} };
    const tools = [codeModeExec(applyPatchHelper), callerSearch, callerWrite];

    expect(grokNativeCatalogTools(tools, undefined, xai)).toEqual([]);
    expect(grokFacingTools(tools, undefined, xai)).toEqual(tools);
  });

  test("keeps every caller-owned Grok-name collision byte-identical in adapter events", async () => {
    for (const name of [
      "read_file",
      "grep",
      "list_dir",
      "search_replace",
      "write",
      "write_file",
      "run_terminal_command",
    ]) {
      const callerTool: OcxTool = {
        name,
        description: "Caller-owned tool",
        parameters: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      };
      const tools = [codeModeExec(applyPatchHelper), callerTool];
      const original: AdapterEvent[] = [
        { type: "tool_call_start", id: `caller_${name}`, name },
        { type: "tool_call_delta", arguments: JSON.stringify({ message: "caller payload" }) },
        { type: "tool_call_end" },
      ];
      expect(await collect(rewriteAdapterEventsForGrokStructuredEdits(replay(original), {
        context: { tools },
        options: {},
      }, xai))).toEqual(original);
    }
  });

  test("keeps the Grok catalog on for Codex Default-mode developer text", () => {
    const defaultMode = [
      "<collaboration_mode># Collaboration Mode: Default",
      "You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.",
      "Never write a multiple choice question as a textual assistant message.",
    ];
    expect(grokNativeCatalogTools([codeModeExec(applyPatchHelper)], undefined, xai, defaultMode).map(tool => tool.name)).toEqual([
      "read_file", "grep", "list_dir", "search_replace", "write", "run_terminal_command",
    ]);
    expect(grokFacingTools(
      [codeModeExec(applyPatchHelper)],
      undefined,
      xai,
      defaultMode,
    )?.map(tool => tool.name)).toEqual([
      "read_file", "grep", "list_dir", "search_replace", "write", "run_terminal_command",
    ]);
  });

  test("chooses exec sink for code mode and apply_patch when it is top-level", () => {
    expect(grokEditCodexSink([codeModeExec(applyPatchHelper)])).toEqual({ kind: "exec", name: "exec" });
    expect(grokEditCodexSink([
      { name: "apply_patch", freeform: true, description: "patch", parameters: {} } as OcxTool,
    ])).toEqual({ kind: "apply_patch" });
  });

  test("translates search_replace into a Codex update hunk", () => {
    const translated = translateGrokStructuredEditCall("search_replace", JSON.stringify({
      file_path: "README.md",
      old_string: "hello",
      new_string: "hello\ntest",
    }));
    expect(translated?.patch).toBe([
      "*** Begin Patch",
      "*** Update File: README.md",
      "@@",
      "-hello",
      "+hello",
      "+test",
      "*** End Patch",
    ].join("\n"));
  });

  test("translates empty old_string and write into Add File", () => {
    expect(translateGrokStructuredEditCall("search_replace", JSON.stringify({
      file_path: "utils/time.py",
      old_string: "",
      new_string: "X = 1\n",
    }))?.patch).toContain("*** Add File: utils/time.py");
    expect(translateGrokStructuredEditCall("write", JSON.stringify({
      file_path: "./utils/time.py",
      content: "X = 1\n",
    }))?.patch).toBe([
      "*** Begin Patch",
      "*** Add File: utils/time.py",
      "+X = 1",
      "*** End Patch",
    ].join("\n"));
    expect(translateGrokStructuredEditCall("write_file", JSON.stringify({
      file_path: "./utils/time.py",
      contents: "X = 1\n",
    }))?.patch).toContain("*** Add File: utils/time.py");
  });

  test("wraps a converted patch as nested tools.apply_patch for code-mode exec", () => {
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch";
    const encoded = encodeGrokEditForCodexSink({ patch }, { kind: "exec", name: "exec" });
    expect(encoded.name).toBe("exec");
    const body = JSON.parse(encoded.arguments) as { input: string };
    expect(body.input).toBe(`await tools.apply_patch(${JSON.stringify(patch)})`);
  });

  test("rewrites read_file into exec_command cat", async () => {
    const events = await collect(rewriteGrokStructuredEditEvents(replay([
      { type: "tool_call_start", id: "c1", name: "read_file" },
      { type: "tool_call_delta", arguments: JSON.stringify({ path: "README.md" }) },
      { type: "tool_call_end" },
    ]), new Set(["read_file"]), { kind: "exec", name: "exec" }));
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "exec" });
    expect((events[1] as { arguments: string }).arguments).toContain("tools.exec_command");
    expect((events[1] as { arguments: string }).arguments).toContain("cat --");
    expect((events[1] as { arguments: string }).arguments).toContain("README.md");
  });

  test("uses POSIX shell on darwin and PowerShell on win32", () => {
    expect(translateGrokShellCall("read_file", JSON.stringify({ path: "README.md" }), "darwin")).toEqual({
      cmd: "cat -- 'README.md'",
    });
    expect(translateGrokShellCall("list_dir", JSON.stringify({ path: "." }), "darwin")?.cmd).toContain("ls -la --");
    const winRead = translateGrokShellCall("read_file", JSON.stringify({ path: "README.md" }), "win32");
    expect(winRead && "cmd" in winRead && winRead.cmd.startsWith("powershell.exe -NoProfile -NonInteractive -EncodedCommand ")).toBe(true);
    if (!winRead || "error" in winRead) throw new Error("expected windows read command");
    const decoded = Buffer.from(winRead.cmd.split(" ").pop() ?? "", "base64").toString("utf16le");
    expect(decoded).toContain("Get-Content -LiteralPath 'README.md' -Raw");
    const winList = translateGrokShellCall("list_dir", JSON.stringify({ path: "." }), "win32");
    if (!winList || "error" in winList) throw new Error("expected windows list command");
    expect(Buffer.from(winList.cmd.split(" ").pop() ?? "", "base64").toString("utf16le")).toContain("Get-ChildItem -Force");
    const winGrep = translateGrokShellCall("grep", JSON.stringify({ pattern: "foo", glob: "README*" }), "win32");
    if (!winGrep || "error" in winGrep) throw new Error("expected windows grep command");
    expect(Buffer.from(winGrep.cmd.split(" ").pop() ?? "", "base64").toString("utf16le")).toContain("Select-String");
  });

  test.skipIf(process.platform === "win32")("does not expand POSIX path and search arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-grok-shell-"));
    try {
      for (const [tool, args] of [
        ["read_file", { path: `$(touch ${join(root, "read.marker")})` }],
        ["list_dir", { path: `\`touch ${join(root, "list.marker")}\`` }],
        ["grep", {
          pattern: `$(touch ${join(root, "pattern.marker")})`,
          path: ".",
          glob: `\`touch ${join(root, "glob.marker")}\``,
        }],
      ] as const) {
        const translated = translateGrokShellCall(tool, JSON.stringify(args), "darwin");
        if ("error" in translated) throw new Error(translated.error);
        Bun.spawnSync(["sh", "-c", translated.cmd], { cwd: root, stdout: "ignore", stderr: "ignore" });
      }
      expect(existsSync(join(root, "read.marker"))).toBe(false);
      expect(existsSync(join(root, "list.marker"))).toBe(false);
      expect(existsSync(join(root, "pattern.marker"))).toBe(false);
      expect(existsSync(join(root, "glob.marker"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rewrites ranged read_file into BSD-safe sed", async () => {
    const events = await collect(rewriteGrokStructuredEditEvents(replay([
      { type: "tool_call_start", id: "c1", name: "read_file" },
      { type: "tool_call_delta", arguments: JSON.stringify({ path: "utils/database.py", offset: 160 }) },
      { type: "tool_call_end" },
    ]), new Set(["read_file"]), { kind: "exec", name: "exec" }));
    const args = (events[1] as { arguments: string }).arguments;
    expect(args).toContain("sed -n '160,$p' 'utils/database.py'");
    expect(args).not.toContain(" -- ");
    expect(args).not.toContain("160,$p\"");
  });

  test("rewrites a streamed search_replace call into exec apply_patch", async () => {
    const events = await collect(rewriteGrokStructuredEditEvents(replay([
      { type: "tool_call_start", id: "c1", name: "search_replace" },
      { type: "tool_call_delta", arguments: JSON.stringify({ file_path: "a.txt", old_string: "old", new_string: "new" }) },
      { type: "tool_call_end" },
      { type: "done" },
    ]), new Set(["search_replace", "write", "read_file"]), { kind: "exec", name: "exec" }));
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "exec" });
    expect((events[1] as { arguments: string }).arguments).toContain("await tools.apply_patch");
    expect((events[1] as { arguments: string }).arguments).toContain("*** Begin Patch");
    expect((events[1] as { arguments: string }).arguments).not.toContain("search_replace");
    expect(events[2]).toMatchObject({ type: "tool_call_end" });
  });

  test("leaves ordinary exec calls unchanged", async () => {
    const original: AdapterEvent[] = [
      { type: "tool_call_start", id: "c1", name: "exec" },
      { type: "tool_call_delta", arguments: JSON.stringify({ input: "await tools.exec_command({cmd:\"ls\"})" }) },
      { type: "tool_call_end" },
    ];
    expect(await collect(rewriteGrokStructuredEditEvents(replay(original), new Set(["search_replace"]), { kind: "exec", name: "exec" }))).toEqual(original);
    const buffered = rewriteGrokNativeCallEventList(
      original,
      new Set(["exec"]),
      new Set(["exec"]),
      new Set(["search_replace"]),
    );
    expect(buffered).toEqual({ events: original, rewritten: false });
    expect(buffered.events).toBe(original);
  });

  test("settles a converted call before an ordinary interleaved call", async () => {
    const original: AdapterEvent[] = [
      { type: "tool_call_start", id: "converted", name: "search_replace" },
      { type: "tool_call_delta", arguments: JSON.stringify({ file_path: "a.txt", old_string: "old", new_string: "new" }) },
      { type: "tool_call_start", id: "ordinary", name: "wait" },
      { type: "tool_call_delta", arguments: JSON.stringify({ milliseconds: 50 }) },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    const streamed = await collect(rewriteGrokStructuredEditEvents(
      replay(original),
      new Set(["search_replace"]),
      { kind: "exec", name: "exec" },
    ));
    const buffered = rewriteGrokNativeCallEventList(
      original,
      new Set(["exec"]),
      new Set(["exec", "wait"]),
      new Set(["search_replace"]),
    );

    expect(buffered.rewritten).toBe(true);
    expect(buffered.events).toEqual(streamed);
    expect(streamed.map(event => event.type)).toEqual([
      "tool_call_start", "tool_call_delta", "tool_call_end",
      "tool_call_start", "tool_call_delta", "tool_call_end", "done",
    ]);
    expect(streamed[0]).toMatchObject({ type: "tool_call_start", id: "converted", name: "exec" });
    expect(streamed[3]).toEqual({ type: "tool_call_start", id: "ordinary", name: "wait" });
    expect(streamed[4]).toEqual({ type: "tool_call_delta", arguments: JSON.stringify({ milliseconds: 50 }) });
  });

  test("advertises the Grok catalog when Codex pins exec via allowed_tools", () => {
    const toolChoice = { allowedTools: ["exec"], mode: "auto" as const };
    expect(grokNativeCatalogTools([codeModeExec(liveCodexExecHelper)], toolChoice, xai).map(tool => tool.name)).toEqual([
      "read_file", "grep", "list_dir", "search_replace", "write", "run_terminal_command",
    ]);
    expect(grokFacingTools([codeModeExec(liveCodexExecHelper)], toolChoice, xai)?.map(tool => tool.name)).toEqual([
      "read_file", "grep", "list_dir", "search_replace", "write", "run_terminal_command",
    ]);
  });

  test("converts live Codex list_dir/read_file calls into exec", async () => {
    const events = await collect(rewriteAdapterEventsForGrokStructuredEdits(replay([
      { type: "tool_call_start", id: "c1", name: "list_dir" },
      { type: "tool_call_delta", arguments: JSON.stringify({ path: "/workspace/project" }) },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "c2", name: "read_file" },
      { type: "tool_call_delta", arguments: JSON.stringify({ path: "README.md" }) },
      { type: "tool_call_end" },
    ]), {
      context: { tools: [codeModeExec(liveCodexExecHelper)] },
      options: { toolChoice: { allowedTools: ["exec"], mode: "auto" } },
    }, xai));
    expect(events.filter(event => event.type === "tool_call_start")).toEqual([
      { type: "tool_call_start", id: "c1", name: "exec" },
      { type: "tool_call_start", id: "c2", name: "exec" },
    ]);
    const args = events.filter((event): event is Extract<AdapterEvent, { type: "tool_call_delta" }> => event.type === "tool_call_delta");
    expect(args[0]?.arguments).toContain("tools.exec_command");
    expect(args[0]?.arguments).toContain("ls -la --");
    expect(args[1]?.arguments).toContain("cat --");
    expect(args[1]?.arguments).toContain("README.md");
  });

  test("restores Grok tool names from converted exec history", async () => {
    const roundTrip = async (name: string, args: Record<string, unknown>) => {
      const events = await collect(rewriteGrokStructuredEditEvents(replay([
        { type: "tool_call_start", id: "c1", name },
        { type: "tool_call_delta", arguments: JSON.stringify(args) },
        { type: "tool_call_end" },
      ]), new Set(["read_file", "grep", "list_dir", "search_replace", "write", "write_file", "run_terminal_command"]), { kind: "exec", name: "exec" }));
      const parsed = JSON.parse((events[1] as { arguments: string }).arguments) as Record<string, unknown>;
      return reconstructGrokToolCallFromExec(parsed);
    };
    expect(await roundTrip("read_file", { target_file: "README.md" })).toEqual({
      name: "read_file", arguments: { target_file: "README.md" },
    });
    expect(await roundTrip("read_file", { path: "README.md" })).toEqual({
      name: "read_file", arguments: { target_file: "README.md" },
    });
    expect(await roundTrip("read_file", { target_file: "utils/database.py", offset: 160, limit: 20 })).toEqual({
      name: "read_file", arguments: { target_file: "utils/database.py", offset: 160, limit: 20 },
    });
    expect(await roundTrip("list_dir", { target_directory: "." })).toEqual({
      name: "list_dir", arguments: { target_directory: "." },
    });
    expect(await roundTrip("list_dir", { path: "." })).toEqual({
      name: "list_dir", arguments: { target_directory: "." },
    });
    expect(await roundTrip("grep", { pattern: "foo", path: ".", glob: "README*" })).toEqual({
      name: "grep", arguments: { pattern: "foo", path: ".", glob: "README*" },
    });
    expect(await roundTrip("grep", {
      pattern: "owner's $HOME $(literal)",
      path: "dir/it's here",
      glob: "*.{ts,tsx}",
    })).toEqual({
      name: "grep",
      arguments: { pattern: "owner's $HOME $(literal)", path: "dir/it's here", glob: "*.{ts,tsx}" },
    });
    expect(await roundTrip("search_replace", { file_path: "a.txt", old_string: "old", new_string: "new" })).toEqual({
      name: "search_replace", arguments: { file_path: "a.txt", old_string: "old", new_string: "new" },
    });
    expect(await roundTrip("write", { file_path: "b.txt", content: "hello\nworld" })).toEqual({
      name: "write", arguments: { file_path: "b.txt", content: "hello\nworld" },
    });
    expect(await roundTrip("write_file", { file_path: "b.txt", contents: "hello\nworld" })).toEqual({
      name: "write", arguments: { file_path: "b.txt", content: "hello\nworld" },
    });
    expect(await roundTrip("run_terminal_command", { command: "git status" })).toEqual({
      name: "run_terminal_command", arguments: { command: "git status" },
    });
    expect(await roundTrip("run_terminal_command", {
      command: "git add -- cogs/admin.py",
      with_escalated_permissions: true,
      justification: "stage refactor",
    })).toEqual({
      name: "run_terminal_command",
      arguments: {
        command: "git add -- cogs/admin.py",
        with_escalated_permissions: true,
        justification: "stage refactor",
      },
    });
    expect(reconstructGrokToolCallFromExec({
      input: "const toolsList = ALL_TOOLS.map(t => t.name).join('\\n');\ntext(toolsList);",
    })).toBeUndefined();
    const win = translateGrokShellCall("read_file", JSON.stringify({ target_file: "README.md" }), "win32");
    if (!win || "error" in win) throw new Error("expected windows read");
    expect(reconstructGrokToolCallFromExec({
      input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(win.cmd)} });\ntext(r.output);`,
    })).toEqual({ name: "read_file", arguments: { target_file: "README.md" } });
    for (const arguments_ of [
      { pattern: "foo", path: "src", glob: "*.ts" },
      { pattern: "it's 'quoted'", path: "src/it's here", glob: "*.t's" },
    ]) {
      const winGrep = translateGrokShellCall("grep", JSON.stringify(arguments_), "win32");
      if (!winGrep || "error" in winGrep) throw new Error("expected windows grep");
      expect(reconstructGrokToolCallFromExec({
        input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(winGrep.cmd)} });\ntext(r.output);`,
      })).toEqual({ name: "grep", arguments: arguments_ });
    }
  });

  test("escalates Git index and ref mutations through Codex exec_command permissions", async () => {
    expect(grokShellNeedsGitEscalation("git add -- cogs/admin.py")).toBe(true);
    expect(grokShellNeedsGitEscalation("git commit -m 'split packages'")).toBe(true);
    expect(grokShellNeedsGitEscalation("git checkout feature/refactor")).toBe(true);
    expect(grokShellNeedsGitEscalation("git switch -c feature/refactor")).toBe(true);
    expect(grokShellNeedsGitEscalation("git reset --mixed HEAD~1")).toBe(true);
    expect(grokShellNeedsGitEscalation("git restore --staged src/a.ts")).toBe(true);
    expect(grokShellNeedsGitEscalation("git revert HEAD")).toBe(true);
    expect(grokShellNeedsGitEscalation("git branch -f main HEAD")).toBe(true);
    expect(grokShellNeedsGitEscalation("git update-ref refs/heads/main HEAD")).toBe(true);
    expect(grokShellNeedsGitEscalation("git -C /repo add .")).toBe(true);
    expect(grokShellNeedsGitEscalation("git -C '/repo with spaces' commit -m split")).toBe(true);
    expect(grokShellNeedsGitEscalation("git -C /repo status --short")).toBe(false);
    expect(grokShellNeedsGitEscalation("git -C /repo log -1")).toBe(false);
    expect(grokShellNeedsGitEscalation("echo ready\ngit -C /repo add .")).toBe(true);
    expect(grokShellNeedsGitEscalation("git status --short")).toBe(false);
    expect(grokShellNeedsGitEscalation("git log -1")).toBe(false);
    expect(grokShellNeedsGitEscalation("echo 'git add'")).toBe(false);

    const gitAdd = await collect(rewriteGrokStructuredEditEvents(replay([
      { type: "tool_call_start", id: "c1", name: "run_terminal_command" },
      { type: "tool_call_delta", arguments: JSON.stringify({ command: "git -C /repo add -- cogs/admin.py" }) },
      { type: "tool_call_end" },
    ]), new Set(["run_terminal_command"]), { kind: "exec", name: "exec" }));
    const addInput = (JSON.parse((gitAdd[1] as { arguments: string }).arguments) as { input: string }).input;
    expect(addInput).toContain('sandbox_permissions: "require_escalated"');
    expect(addInput).not.toContain("with_escalated_permissions: true");
    expect(addInput).toContain(".git/index.lock");
    expect(addInput).toContain("git -C /repo add -- cogs/admin.py");

    const status = await collect(rewriteGrokStructuredEditEvents(replay([
      { type: "tool_call_start", id: "c1", name: "run_terminal_command" },
      { type: "tool_call_delta", arguments: JSON.stringify({ command: "git status --short" }) },
      { type: "tool_call_end" },
    ]), new Set(["run_terminal_command"]), { kind: "exec", name: "exec" }));
    expect((JSON.parse((status[1] as { arguments: string }).arguments) as { input: string }).input)
      .not.toContain("sandbox_permissions");

    for (const annotation of [
      { description: "list files" },
      { justification: "list files" },
    ]) {
      const annotated = await collect(rewriteGrokStructuredEditEvents(replay([
        { type: "tool_call_start", id: "c1", name: "run_terminal_command" },
        { type: "tool_call_delta", arguments: JSON.stringify({ command: "ls -la", ...annotation }) },
        { type: "tool_call_end" },
      ]), new Set(["run_terminal_command"]), { kind: "exec", name: "exec" }));
      const annotatedInput = (JSON.parse((annotated[1] as { arguments: string }).arguments) as { input: string }).input;
      expect(annotatedInput).not.toContain("sandbox_permissions");
      expect(annotatedInput).not.toContain("justification:");
    }

    const explicit = await collect(rewriteGrokStructuredEditEvents(replay([
      { type: "tool_call_start", id: "c1", name: "run_terminal_command" },
      {
        type: "tool_call_delta",
        arguments: JSON.stringify({
          command: "ls -la .git",
          working_directory: "/tmp",
          with_escalated_permissions: true,
          justification: "inspect git dir",
        }),
      },
      { type: "tool_call_end" },
    ]), new Set(["run_terminal_command"]), { kind: "exec", name: "exec" }));
    const explicitInput = (JSON.parse((explicit[1] as { arguments: string }).arguments) as { input: string }).input;
    expect(explicitInput).toContain('sandbox_permissions: "require_escalated"');
    expect(explicitInput).not.toContain("with_escalated_permissions: true");
    expect(explicitInput).toContain("workdir: \"/tmp\"");
    expect(explicitInput).toContain("inspect git dir");
  });

  test("forwards run_terminal_command python writes without a proxy-side refusal", async () => {
    const liveSplit = "python3 << 'PY'\nfrom pathlib import Path\nPath('pool.py').write_text('x = 1\\n')\nPY";
    const events = await collect(rewriteGrokStructuredEditEvents(replay([
      { type: "tool_call_start", id: "c1", name: "run_terminal_command" },
      { type: "tool_call_delta", arguments: JSON.stringify({ command: liveSplit }) },
      { type: "tool_call_end" },
    ]), new Set(["run_terminal_command"]), { kind: "exec", name: "exec" }));
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "exec" });
    const args = (events[1] as { arguments: string }).arguments;
    expect(args).toContain("tools.exec_command");
    expect(args).toContain("write_text");
  });
});
