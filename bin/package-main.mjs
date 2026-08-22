export const packageName = "@yansigit/opencodex";
export const cliCommand = "ocx";

export async function loadBunApi() {
  if (typeof Bun === "undefined") {
    throw new Error("The opencodex programmatic API requires the Bun runtime. Use `ocx` for the CLI entrypoint.");
  }
  return import("../src/index.ts");
}
