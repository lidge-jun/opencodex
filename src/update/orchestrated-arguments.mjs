const CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isOrchestratedUpdateArgv(argv) {
  return argv.some(arg => /^(--plan|--yes|--json|--expect-plan|--not-after|--orchestrated-expect|--orchestrated-result)(?:=|$)/.test(arg));
}

/**
 * Internal child grammar is accepted only in the explicitly marked child process, with its result capability.
 * The capability is taken out of env on every call, so no subprocess started afterwards inherits it.
 */
export function parseOrchestratedChildArgs(argv, env) {
  const resultCapability = env.OCX_UPDATE_RESULT_CAPABILITY;
  delete env.OCX_UPDATE_RESULT_CAPABILITY;
  if (env.OCX_UPDATE_ORCHESTRATED_CHILD !== "1") return { ok: false };
  if (typeof resultCapability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(resultCapability)) return { ok: false };
  const values = new Map();
  const allowed = new Set(["--version", "--orchestrated-expect", "--orchestrated-result", "--not-after"]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[++i];
    if (!allowed.has(flag) || values.has(flag) || !value || value.startsWith("-")) return { ok: false };
    values.set(flag, value);
  }
  const version = values.get("--version"), expect = values.get("--orchestrated-expect"), resultPath = values.get("--orchestrated-result"), deadline = values.get("--not-after");
  if (!version || !strictSemver(version) || !expect || !resultPath || (deadline !== undefined
    && (!/^\d+$/.test(deadline) || !Number.isSafeInteger(Number(deadline)) || Number(deadline) <= 0))) return { ok: false };
  return { ok: true, version, expect, resultPath, resultCapability, ...(deadline === undefined ? {} : { notAfter: Number(deadline) }) };
}

function strictSemver(value) {
  if (value.length > 128) return false;
  const match = CORE.exec(value);
  return Boolean(match && (match[4] === undefined || match[4].split(".").every(part =>
    part.length > 0 && /^[0-9A-Za-z-]+$/.test(part) && (!/^\d+$/.test(part) || /^(0|[1-9]\d*)$/.test(part)))));
}

/** Parse only the public orchestrated grammar; callers map an invalid result to exit 64. */
export function parseOrchestratedUpdateArgs(argv) {
  const flags = new Map();
  const switches = new Set(["--plan", "--yes", "--json"]);
  const values = new Set(["--tag", "--version", "--expect-plan", "--not-after"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (switches.has(arg)) {
      if (flags.has(arg)) return { ok: false };
      flags.set(arg, true);
    } else if (values.has(arg)) {
      if (flags.has(arg) || i + 1 >= argv.length || argv[i + 1].startsWith("-")) return { ok: false };
      flags.set(arg, argv[++i]);
    } else return { ok: false };
  }
  const plan = flags.has("--plan"), apply = flags.has("--yes");
  if (plan === apply || !flags.has("--json")) return { ok: false };
  if (flags.has("--tag") && flags.has("--version")) return { ok: false };
  const tag = flags.get("--tag"), version = flags.get("--version");
  if (tag !== undefined && tag !== "latest" && tag !== "preview") return { ok: false };
  if (version !== undefined && !strictSemver(version)) return { ok: false };
  const expectPlan = flags.get("--expect-plan"), deadline = flags.get("--not-after");
  if (plan && (expectPlan !== undefined || deadline !== undefined)) return { ok: false };
  if (expectPlan !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(expectPlan)) return { ok: false };
  if (deadline !== undefined && (!/^\d+$/.test(deadline) || !Number.isSafeInteger(Number(deadline)) || Number(deadline) <= 0)) return { ok: false };
  return { ok: true, mode: plan ? "plan" : "apply", ...(tag === undefined ? {} : { tag }),
    ...(version === undefined ? {} : { version }), ...(expectPlan === undefined ? {} : { expectPlan }),
    ...(deadline === undefined ? {} : { notAfter: Number(deadline) }) };
}
