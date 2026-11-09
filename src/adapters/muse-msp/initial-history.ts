import type { OcxContext } from "../../types";
import { MuseMspError } from "./connection";

export function museProjectedText(content: unknown, project: boolean): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (!project || !Array.isArray(content) || !content.length || content.some(part =>
    !part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string")) return undefined;
  return content.map(part => part.text).join("") || undefined;
}

/** Import client-visible text/tool history as explicitly labelled context for a new Muse session. */
export function projectInitialMuseHistory(context: OcxContext, project: boolean): {developer?: string;user: string} {
  const messages=context.messages;
  if (context.systemPrompt?.length || !messages.length) throw new MuseMspError("unsupported_input_history");
  const developers:string[]=[], users:string[]=[];
  const hasPriorAssistant=messages.some(m=>m.role==="assistant" || m.role==="toolResult");
  if(!project && (messages.length!==1 || messages[0]?.role!=="user")) throw new MuseMspError("unsupported_input_history");
  if (!hasPriorAssistant) {
    for (const message of messages) {
      const text=museProjectedText(message.content,project);
      if(!text || (message.role!=="developer" && message.role!=="user")) throw new MuseMspError("unsupported_input_history");
      (message.role==="developer"?developers:users).push(text);
    }
    if(!users.length) throw new MuseMspError("unsupported_input_history");
    return {...(developers.length?{developer:developers.join("\n\n")} : {}), user:users.join("\n\n")};
  }
  const last=messages.at(-1);
  if(!last || last.role!=="user") throw new MuseMspError("unsupported_input_history");
  const latest=museProjectedText(last.content,project);
  if(!latest) throw new MuseMspError("unsupported_input_history");
  const transcript:Array<Record<string,unknown>>=[];
  for(const message of messages.slice(0,-1)) {
    if(message.role==="developer") {
      const text=museProjectedText(message.content,project); if(!text) throw new MuseMspError("unsupported_input_history");
      developers.push(text); continue;
    }
    if(message.role==="user") {
      const text=museProjectedText(message.content,project); if(!text) throw new MuseMspError("unsupported_input_history");
      transcript.push({role:"user",text}); continue;
    }
    if(message.role==="toolResult") {
      const text=museProjectedText(message.content,project);
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
  let encoded:string;try{encoded=JSON.stringify(transcript)}catch{throw new MuseMspError("invalid_history")}
  const user=`Prior conversation history follows as JSON. Preserve its context when answering the final user request.\n${encoded}\n\nCurrent user request:\n${latest}`;
  if(Buffer.byteLength(user)>4*1024*1024)throw new MuseMspError("unsupported_input_history");
  return {...(developers.length?{developer:developers.join("\n\n")} : {}),user};
}
