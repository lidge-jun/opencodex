/** Recognize ONE statically declared Code Mode helper. Never execute or infer a JS program. */
export function advisorEvidenceTool(name: string, args: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
  const tool = name.split(/\.|__|\//).at(-1) ?? name;
  if (tool !== "exec" || typeof args.input !== "string" || args.input.length > 24_000) return { tool, args };
  const source = args.input.replace(/^\s*\/\/ @exec:[^\n]*\n/, "").trim();
  const direct = /^text\(await tools\.(exec_command|write_stdin|apply_patch)\(([\s\S]*)\)\);?$/.exec(source);
  const assigned = /^(?:const|let) ([A-Za-z_$][\w$]*)\s*=\s*await tools\.(exec_command|write_stdin|apply_patch)\(([\s\S]*)\);\s*text\(\1\);?$/.exec(source);
  const helper = direct?.[1] ?? assigned?.[2];
  const literal = direct?.[2] ?? assigned?.[3];
  if (!helper || literal === undefined) return { tool, args };
  try {
    // JSON literals with optional bare identifier keys. Quoted strings remain byte-for-byte
    // data; expressions, identifiers as values, templates and executable code fail JSON.parse.
    const json = literal.replace(/"(?:\\.|[^"\\])*"|([A-Za-z_$][\w$]*)(?=\s*:)/g,
      (match, key: string | undefined) => key ? JSON.stringify(key) : match);
    const payload: unknown = JSON.parse(json);
    if (helper === "apply_patch" && typeof payload === "string") return { tool: helper, args: { input: payload } };
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return { tool: helper, args: payload as Record<string, unknown> };
  } catch { /* Unsupported JavaScript supplies no trustworthy structured evidence. */ }
  return { tool, args };
}
