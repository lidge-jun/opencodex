import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "scripts/icons-manifest.json"), "utf8"));
const { aliasMap, generatedFiles } = manifest;

// 1. Update gui/src/provider-icons.ts
const tsPath = path.join(root, "gui/src/provider-icons.ts");
let tsContent = fs.readFileSync(tsPath, "utf8");

const tsInsertionMarker = '  "xiaomi-mimo": "xiaomi-color.svg",\n';
const tsNewAliases = Object.entries(aliasMap)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, file]) => `  ${JSON.stringify(id)}: ${JSON.stringify(file)},`)
  .join("\n") + "\n";

if (tsContent.includes(tsInsertionMarker)) {
  tsContent = tsContent.replace(tsInsertionMarker, tsInsertionMarker + tsNewAliases);
  fs.writeFileSync(tsPath, tsContent, "utf8");
  console.log("Updated gui/src/provider-icons.ts");
} else {
  console.error("Could not find tsInsertionMarker");
}

// 2. Update desktop/src-tauri/src/provider_icons.rs
const rsPath = path.join(root, "desktop/src-tauri/src/provider_icons.rs");
let rsContent = fs.readFileSync(rsPath, "utf8");

const rsAliasMarker = '    ("xiaomi-mimo", "xiaomi-color.svg"),\n';
const rsNewAliases = Object.entries(aliasMap)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, file]) => `    ("${id}", "${file}"),`)
  .join("\n") + "\n";

if (rsContent.includes(rsAliasMarker)) {
  rsContent = rsContent.replace(rsAliasMarker, rsAliasMarker + rsNewAliases);
} else {
  console.error("Could not find rsAliasMarker");
}

const rsSvgMarker = '        "zenmux.svg" => svg!("zenmux.svg"),\n';
const uniqueFiles = Array.from(new Set(Object.values(aliasMap) as string[])).filter(f => f !== "zai.svg").sort();
const rsNewSvgs = uniqueFiles
  .map(file => `        "${file}" => svg!("${file}"),`)
  .join("\n") + "\n";

if (rsContent.includes(rsSvgMarker)) {
  rsContent = rsContent.replace(rsSvgMarker, rsSvgMarker + rsNewSvgs);
  fs.writeFileSync(rsPath, rsContent, "utf8");
  console.log("Updated desktop/src-tauri/src/provider_icons.rs");
} else {
  console.error("Could not find rsSvgMarker");
}
