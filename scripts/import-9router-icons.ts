import fs from "node:fs";
import path from "node:path";
import { PROVIDER_REGISTRY } from "../src/providers/registry";

const root = path.resolve(import.meta.dir, "..");
const src9IconsDir = path.resolve(root, "../9router/public/providers");
const dstIconsDir = path.resolve(root, "gui/public/provider-icons");

const files9 = fs.readdirSync(src9IconsDir);

// Mapping from provider ID to source file in 9router
const mappings: Record<string, string> = {
  zed: "zed.png",
  chutes: "chutes.png",
  "volcengine": "volcengine-ark.png",
  "volcengine-ark": "volcengine-ark.png",
  "volcengine-coding-plan": "volcengine-ark.png",
  "volcengine-agent-plan": "volcengine-ark.png",
  "zhipu-bigmodel-responses": "zai.svg", // already in dst as zai.svg
  "api-airforce": "api-airforce.png",
  kilocode: "kilocode.png",
  "kilo-gateway": "kilo-gateway.png",
  blackbox: "blackbox.png",
  bluesminds: "bluesminds.png",
  bazaarlink: "bazaarlink.png",
  atria: "atria.png",
  dahl: "dahl.png",
  bai: "bai.png",
  tokenrouter: "tokenrouter.png",
  tokenharbor: "tokenharbor.png",
  nanobanana: "nanobanana.png",
  morph: "morph.png",
  poolside: "poolside.png",
  trae: "trae.png",
  kimchi: "kimchi.svg",
  llm7: "llm7.png",
  tinyfish: "tinyfish.png",
  byteplus: "byteplus.png",
  cohere: "cohere.png",
  agnes: "agnes.png",
  v1m: "v1m.png",
  iflow: "iflow.png",
  perplexity: "perplexity.png",
  "perplexity-agent": "perplexity-agent.png",
  "vertex-partner": "vertex-partner.png",
  "selfhosted-stt": "selfhosted-stt.png",
  "selfhosted-tts": "selfhosted-tts.png",
  "selfhosted-embedding": "selfhosted-embedding.png",
  "brave-search": "brave-search.png",
  tavily: "tavily.png",
  exa: "exa.png",
  firecrawl: "firecrawl.png",
  "jina-reader": "jina-reader.png",
  serper: "serper.png",
  searchapi: "searchapi.png",
  assemblyai: "assemblyai.png",
  deepgram: "deepgram.png",
  cartesia: "cartesia.png",
  elevenlabs: "elevenlabs.png",
  "fish-audio": "fish-audio.png",
  playht: "playht.png",
  "black-forest-labs": "black-forest-labs.png",
  "fal-ai": "fal-ai.png",
  recraft: "recraft.png",
  "stability-ai": "stability-ai.png",
  runwayml: "runwayml.png",
  "voyage-ai": "voyage-ai.png",
  "jina-ai": "jina-ai.png",
};

const generatedFiles = new Set<string>();
const aliasMap: Record<string, string> = {};

for (const [providerId, srcFile] of Object.entries(mappings)) {
  if (srcFile.endsWith(".svg")) {
    const srcPath = path.join(src9IconsDir, srcFile);
    const targetFile = `${providerId}.svg`;
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(dstIconsDir, targetFile));
      generatedFiles.add(targetFile);
      aliasMap[providerId] = targetFile;
    } else if (fs.existsSync(path.join(dstIconsDir, srcFile))) {
      aliasMap[providerId] = srcFile;
    }
  } else if (srcFile.endsWith(".png")) {
    const srcPath = path.join(src9IconsDir, srcFile);
    if (!fs.existsSync(srcPath)) {
      console.warn(`Source not found: ${srcPath}`);
      continue;
    }
    const buf = fs.readFileSync(srcPath);
    const b64 = buf.toString("base64");
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <image width="128" height="128" href="data:image/png;base64,${b64}"/>
</svg>
`;
    const targetFile = `${providerId}.svg`;
    fs.writeFileSync(path.join(dstIconsDir, targetFile), svgContent, "utf8");
    generatedFiles.add(targetFile);
    aliasMap[providerId] = targetFile;
  }
}

console.log(`Generated ${generatedFiles.size} SVG icons in ${dstIconsDir}`);
console.log(`Aliases count: ${Object.keys(aliasMap).length}`);
fs.writeFileSync(path.join(root, "scripts/icons-manifest.json"), JSON.stringify({ aliasMap, generatedFiles: Array.from(generatedFiles) }, null, 2));
