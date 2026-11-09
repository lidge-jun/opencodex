import type { OcxContext } from "../../types";
import { MuseMspError } from "./connection";

export type MuseHistoryImage = { type: "image"; mediaType: string; base64Data: string };

export function museProjectedText(content: unknown, project: boolean): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (!project || !Array.isArray(content) || !content.length || content.some(part =>
    !part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string")) return undefined;
  return content.map(part => part.text).join("") || undefined;
}

/** Import client-visible text/tool history as explicitly labelled context for a new Muse session. */
export function projectInitialMuseHistory(context: OcxContext, project: boolean): {developer?: string;user: string;images?: MuseHistoryImage[]} {
  const messages=context.messages;
  const images: MuseHistoryImage[] = [];
  function projectContent(content: unknown): string | undefined {
    if (!Array.isArray(content) || !project) return museProjectedText(content, project);
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") return undefined;
      if (part.type === "text" && typeof part.text === "string") { parts.push(part.text); continue; }
      if (part.type !== "image" || typeof part.imageUrl !== "string") return undefined;
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/]+={0,2})$/i.exec(part.imageUrl);
      if (!match || images.length >= 32) return undefined;
      images.push({ type: "image", mediaType: match[1]!.toLowerCase(), base64Data: match[2]! });
      parts.push(`[Image ${images.length} attached to this request]`);
    }
    return parts.join("") || undefined;
  }
  if (!messages.length || (!project && context.systemPrompt?.length)) throw new MuseMspError("unsupported_input_history");
  if (context.systemPrompt?.some(text => typeof text !== "string")) throw new MuseMspError("unsupported_input_history");
  const developers:string[]=[...(context.systemPrompt ?? [])], users:string[]=[];
  const hasPriorAssistant=messages.some(m=>m.role==="assistant" || m.role==="toolResult");
  if(!project && (messages.length!==1 || messages[0]?.role!=="user")) throw new MuseMspError("unsupported_input_history");
  if (!hasPriorAssistant) {
    for (const message of messages) {
      const text=message.role === "developer" ? museProjectedText(message.content,project) : projectContent(message.content);
      if(!text || (message.role!=="developer" && message.role!=="user")) throw new MuseMspError("unsupported_input_history");
      (message.role==="developer"?developers:users).push(text);
    }
    if(!users.length) throw new MuseMspError("unsupported_input_history");
    return {...(developers.length?{developer:developers.join("\n\n")} : {}), user:users.join("\n\n"), ...(images.length ? { images } : {})};
  }
  const last=messages.at(-1);
  if(!last || last.role!=="user") throw new MuseMspError("unsupported_input_history");
  const transcript:Array<Record<string,unknown>>=[];
  for(const message of messages.slice(0,-1)) {
    if(message.role==="developer") {
      const text=museProjectedText(message.content,project); if(!text) throw new MuseMspError("unsupported_input_history");
      developers.push(text); continue;
    }
    if(message.role==="user") {
      const text=projectContent(message.content); if(!text) throw new MuseMspError("unsupported_input_history");
      transcript.push({role:"user",text}); continue;
    }
    if(message.role==="toolResult") {
      const text=projectContent(message.content);
      if(!text || message.containsEncryptedContent) throw new MuseMspError("unsupported_input_history");
      transcript.push({role:"tool",name:message.toolName,callId:message.toolCallId,isError:message.isError,text}); continue;
    }
    if(message.role==="assistant") {
      const parts:Array<Record<string,unknown>>=[];
      for(const part of message.content) {
        if(part.type==="text")parts.push({type:"text",text:part.text});
        else if(part.type==="toolCall")parts.push({type:"tool_call",id:part.id,name:part.name,namespace:part.namespace,arguments:part.arguments});
      }
      if(parts.length) transcript.push({role:"assistant",content:parts});
    }
  }
  const latest=projectContent(last.content);
  if(!latest) throw new MuseMspError("unsupported_input_history");
  let encoded:string;try{encoded=JSON.stringify(transcript)}catch{throw new MuseMspError("invalid_history")}
  const user=`Prior conversation history follows as JSON. Preserve its context when answering the final user request.\n${encoded}\n\nCurrent user request:\n${latest}`;
  if(Buffer.byteLength(user) + images.reduce((n,image)=>n+image.base64Data.length,0)>4*1024*1024-16*1024)throw new MuseMspError("unsupported_input_history");
  return {...(developers.length?{developer:developers.join("\n\n")} : {}),user,...(images.length?{images}: {})};
}
