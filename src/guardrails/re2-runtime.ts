import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname } from "node:path";

const RE2_WASM_LOADER_SHA256 =
  "4bfa5d6a8dd0052da8d06baf171078a392dc9c70592d5dca90c9aefa9006336e";
const require = createRequire(import.meta.url);
const loaderPath = require.resolve("re2-wasm/build/wasm/re2.js");

interface CompilableNodeModule extends NodeModule {
  filename: string;
  paths: string[];
  _compile(source: string, filename: string): void;
}

interface NodeModuleConstructor {
  new(id?: string): CompilableNodeModule;
  _nodeModulePaths(path: string): string[];
}

interface Re2Package {
  RE2: typeof import("re2-wasm").RE2;
}

interface WrappedRe2Package {
  WrappedRE2: typeof import("re2-wasm/build/wasm/re2.js").WrappedRE2;
}

export type Re2Instance = import("re2-wasm").RE2;

function replaceExactlyOnce(
  source: string,
  expected: string,
  replacement: string,
): string {
  const offset = source.indexOf(expected);
  if (offset < 0 || source.indexOf(expected, offset + expected.length) >= 0) {
    throw new Error("re2-wasm loader does not match the reviewed patch context");
  }
  return source.slice(0, offset)
    + replacement
    + source.slice(offset + expected.length);
}

function patchedLoaderSource(): string {
  let source = readFileSync(loaderPath, "utf8");
  const actualSha256 = createHash("sha256").update(source).digest("hex");
  if (actualSha256 !== RE2_WASM_LOADER_SHA256) {
    throw new Error("re2-wasm loader hash drifted from the reviewed 1.0.2 artifact");
  }
  source = replaceExactlyOnce(
    source,
    "Module['INITIAL_MEMORY'] || 16777216",
    "Module['INITIAL_MEMORY'] || 67108864",
  );
  source = replaceExactlyOnce(
    source,
    "function getBinary() {",
    `function widenRe2WasmMemoryImport(binary) {
  var bytes = new Uint8Array(binary).slice();
  var offset = 0x68b;
  var expected = [0x02, 0x01, 0x80, 0x02, 0x80, 0x02];
  for (var index = 0; index < expected.length; index++) {
    if (bytes[offset + index] !== expected[index]) {
      abort('re2.wasm memory import does not match the pinned re2-wasm@1.0.2 binary');
    }
  }
  bytes[offset + 5] = 0x08;
  return bytes;
}

function getBinary() {`,
  );
  source = replaceExactlyOnce(
    source,
    "return new Uint8Array(wasmBinary);",
    "return widenRe2WasmMemoryImport(wasmBinary);",
  );
  source = replaceExactlyOnce(
    source,
    "return readBinary(wasmBinaryFile);",
    "return widenRe2WasmMemoryImport(readBinary(wasmBinaryFile));",
  );
  return replaceExactlyOnce(
    source,
    "return response['arrayBuffer']();",
    "return response['arrayBuffer']().then(widenRe2WasmMemoryImport);",
  );
}

function installReviewedLoader(): void {
  if (require.cache[loaderPath]) return;
  const RuntimeModule = Module as unknown as NodeModuleConstructor;
  const runtimeModule = new RuntimeModule(loaderPath);
  runtimeModule.filename = loaderPath;
  runtimeModule.paths = RuntimeModule._nodeModulePaths(dirname(loaderPath));
  require.cache[loaderPath] = runtimeModule;
  try {
    runtimeModule._compile(patchedLoaderSource(), loaderPath);
  } catch (error) {
    delete require.cache[loaderPath];
    throw error;
  }
}

installReviewedLoader();

export const RE2 = (require("re2-wasm") as Re2Package).RE2;
export const WrappedRE2 = (
  require("re2-wasm/build/wasm/re2.js") as WrappedRe2Package
).WrappedRE2;
