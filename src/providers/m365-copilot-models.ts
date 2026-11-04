/** ChatHub selectors adapted from cramt/m365-copilot-proxy, MIT; see adapters/m365-copilot/LICENSE. */
export const M365_COPILOT_BASE_URL = "https://substrate.office.com/m365Copilot";
/** Display-only prefix: Microsoft's selector IDs stay the request identity. */
export const M365_COPILOT_DISPLAY_PREFIX = "M365 Copilot ";
import { M365_NATIVE_MODEL_ID } from "./m365-copilot-discovery";
export const M365_COPILOT_MODEL_TONES: Readonly<Record<string, string>> = {
  "m365-copilot": "magic", auto: "magic", quick: "Gpt_5_5_Chat", "think-deeper": "Gpt_5_5_Reasoning",
  claude: "Claude_Sonnet", "claude-sonnet": "Claude_Sonnet", "claude-sonnet-4.5": "Claude_Sonnet",
  "claude-sonnet-4.6": "Claude_Sonnet", "claude-sonnet-5.5": "Claude_Sonnet", "claude-sonnet-5": "Claude_Sonnet_5",
  "claude-sonnet-think-deeper": "Claude_Sonnet_Reasoning", "claude-opus": "Claude_Opus",
  "claude-opus-5": "Claude_Opus", "claude-opus-5.5": "Claude_Opus", "claude-opus-4.8": "Claude_Opus", "claude-opus-4.5": "Claude_Opus",
  "gpt-5.5": "Gpt_5_5_Chat", "gpt-5.5-quick": "Gpt_5_5_Chat", "gpt-5.5-think-deeper": "Gpt_5_5_Reasoning",
  "gpt-5.6": "Gpt_5_6_Chat", "gpt-5.6-quick": "Gpt_5_6_Chat", "gpt-5.6-think-deeper": "Gpt_5_6_Reasoning",
  "gpt-6-think-deeper": "Gpt_6_Reasoning", "gpt-6-sol": "Gpt_6_Sol_Reasoning", "gpt-6.1-sol": "Gpt_61_Sol_Reasoning",
  "gpt-5.4": "Gpt_5_4_Reasoning", "gpt-5.4-think-deeper": "Gpt_5_4_Reasoning", "gpt-5.4-quick": "Gpt_5_4_Chat",
  "gpt-5.3": "Gpt_5_3_Chat", "gpt-5.3-quick": "Gpt_5_3_Chat", "gpt-5.3-think-deeper": "Gpt_5_3_Reasoning",
  "gpt-5.2": "Gpt_5_2_Chat", "gpt-5.2-quick": "Gpt_5_2_Chat", "gpt-5.2-think-deeper": "Gpt_5_2_Reasoning",
};
export const M365_COPILOT_MODELS = Object.keys(M365_COPILOT_MODEL_TONES);
export function getToneForModel(model: string): string {
  if (model.length <= 160 && M365_NATIVE_MODEL_ID.test(model)) return model === "Magic" ? "magic" : model;
  const tone = Object.hasOwn(M365_COPILOT_MODEL_TONES, model) ? M365_COPILOT_MODEL_TONES[model] : undefined;
  if (!tone) throw new Error("Unknown Microsoft 365 Copilot model alias");
  return tone;
}
export function isSonnet55Model(model: string): boolean { return model === "claude-sonnet-5.5" || model === "Claude_Sonnet"; }
const M365_COPILOT_PAID_TONES = new Set(["Claude_Opus", "Claude_Sonnet", "Claude_Sonnet_5", "Gpt_6_Reasoning", "DeepWork"]);
export function m365CopilotScenario(model: string): { scenario: string; licenseType: string } {
  // Resolve the tone first so aliases and native selector IDs pick the same scenario for the same upstream model.
  return M365_COPILOT_PAID_TONES.has(getToneForModel(model)) ? { scenario: "OfficeWebPaidCopilot", licenseType: "Premium" }
    : { scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" };
}
