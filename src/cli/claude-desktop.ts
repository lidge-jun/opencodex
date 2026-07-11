import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, saveConfig } from "../config";
import {
  DESKTOP_FAMILIES,
  moveDesktopRoute,
  parseDesktopProfile,
  setDesktopFamilyDefault,
  type DesktopFamily,
  type DesktopProfile,
} from "../claude/desktop-profile";
import { writeDesktop3pConfig, type Desktop3pConfigMode, parseDesktop3pModeArgs } from "../claude/desktop-3p";
import { filterCatalogVisibleModels, visibleNativeSlugs } from "../codex/catalog";
import { buildClaudeDesktopState, fetchAllModels } from "../server/management-api";
import { findLiveProxy } from "../server/proxy-liveness";

function isFamily(value: string | undefined): value is DesktopFamily {
  return !!value && (DESKTOP_FAMILIES as readonly string[]).includes(value);
}

function printDesktopHelp(): void {
  console.log(`Usage:
  ocx claude desktop [apply] [--static|--hybrid|--discovery-only]
  ocx claude desktop show [--json]
  ocx claude desktop move <provider/model> <opus|fable|sonnet|haiku> [--default]
  ocx claude desktop default <family> <provider/model|none>
  ocx claude desktop export <path|->
  ocx claude desktop import <path> [--apply]`);
}

async function applyProfile(profile: DesktopProfile, mode: Desktop3pConfigMode): Promise<{ ok: boolean; path: string; reason?: string }> {
  const config = loadConfig();
  const state = await buildClaudeDesktopState(config, profile);
  config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: state.profile };
  saveConfig(config);
  const live = await findLiveProxy();
  const allModels = await fetchAllModels(config);
  const routed = filterCatalogVisibleModels(allModels, config).map(model => ({
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow,
  }));
  const result = writeDesktop3pConfig(
    live?.port ?? config.port ?? 10100,
    [...visibleNativeSlugs(config)],
    routed,
    config.apiKeys?.[0]?.key,
    mode,
    state.profile,
  );
  return { ok: result.written, path: result.path, reason: result.reason };
}

export async function handleClaudeDesktopCommand(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") {
    printDesktopHelp();
    return 0;
  }

  // Legacy mode flags remain apply aliases and are parsed before subcommands.
  const legacyFlags = argv.filter(arg => ["--static", "--hybrid", "--discovery-only"].includes(arg));
  const applyInvocation = argv.length === 0 || command === "apply" || legacyFlags.length > 0;
  if (applyInvocation) {
    const nonMode = argv.filter(arg => !["apply", "--static", "--hybrid", "--discovery-only"].includes(arg));
    if (nonMode.length > 0) {
      console.error(`알 수 없는 인자: ${nonMode.join(" ")}`);
      return 1;
    }
    const parsedMode = parseDesktop3pModeArgs(legacyFlags);
    if ("error" in parsedMode) { console.error(parsedMode.error); return 1; }
    try {
      const config = loadConfig();
      const state = await buildClaudeDesktopState(config);
      const result = await applyProfile(state.profile, parsedMode.mode);
      if (!result.ok) { console.error(`설정 적용 실패: ${result.reason ?? "unknown error"}`); return 1; }
      console.log(`Claude Desktop 설정을 적용했습니다: ${result.path}`);
      console.log("Claude Desktop을 완전히 종료한 뒤 다시 열어 주세요.");
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  try {
    const config = loadConfig();
    const state = await buildClaudeDesktopState(config);
    if (command === "show") {
      if (argv.length > 2 || (argv[1] && argv[1] !== "--json")) throw new Error("Usage: ocx claude desktop show [--json]");
      if (argv[1] === "--json") console.log(JSON.stringify(state));
      else {
        for (const family of DESKTOP_FAMILIES) {
          console.log(`${family.toUpperCase()}${state.profile.defaults[family] ? ` (default: ${state.profile.defaults[family]})` : ""}`);
          for (const model of state.models.filter(item => item.assignment.family === family)) {
            console.log(`  ${model.available ? "•" : "○"} ${model.route} -> ${model.assignment.alias}${model.available ? "" : " (unavailable)"}`);
          }
        }
      }
      return 0;
    }
    if (command === "move") {
      const [, route, familyRaw, ...flags] = argv;
      if (!route || !isFamily(familyRaw) || flags.some(flag => flag !== "--default")) throw new Error("Usage: ocx claude desktop move <route> <family> [--default]");
      if (!state.models.some(model => model.route === route && model.available)) throw new Error(`현재 사용할 수 없는 모델입니다: ${route}`);
      const profile = moveDesktopRoute(state.profile, route, familyRaw, flags.includes("--default"));
      config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: profile };
      saveConfig(config);
      console.log(`${route} 모델을 ${familyRaw} 그룹으로 옮겼습니다.`);
      return 0;
    }
    if (command === "default") {
      const [, familyRaw, routeRaw] = argv;
      if (!isFamily(familyRaw) || !routeRaw || argv.length !== 3) throw new Error("Usage: ocx claude desktop default <family> <route|none>");
      const route = routeRaw === "none" ? null : routeRaw;
      if (route && !state.models.some(model => model.route === route && model.available)) throw new Error(`현재 사용할 수 없는 모델입니다: ${route}`);
      const profile = setDesktopFamilyDefault(state.profile, familyRaw, route);
      config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: profile };
      saveConfig(config);
      console.log(`${familyRaw} 기본 모델을 ${route ?? "없음"}으로 지정했습니다.`);
      return 0;
    }
    if (command === "export") {
      const target = argv[1];
      if (!target || argv.length !== 2) throw new Error("Usage: ocx claude desktop export <path|->");
      const json = JSON.stringify(state.profile, null, 2) + "\n";
      if (target === "-") process.stdout.write(json);
      else writeFileSync(resolve(target), json, { encoding: "utf8", mode: 0o600 });
      return 0;
    }
    if (command === "import") {
      const source = argv[1];
      const flags = argv.slice(2);
      if (!source || flags.some(flag => flag !== "--apply")) throw new Error("Usage: ocx claude desktop import <path> [--apply]");
      const profile = parseDesktopProfile(JSON.parse(readFileSync(resolve(source), "utf8")));
      const reconciled = (await buildClaudeDesktopState(config, profile)).profile;
      config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: reconciled };
      saveConfig(config);
      if (flags.includes("--apply")) {
        const result = await applyProfile(reconciled, "static");
        if (!result.ok) { console.error(`프로필은 저장했지만 Desktop 적용에 실패했습니다: ${result.reason ?? "unknown error"}`); return 1; }
      }
      console.log("Claude Desktop 프로필을 가져왔습니다.");
      return 0;
    }
    printDesktopHelp();
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
