import type { OcxParsedRequest } from "../../types";
import { MuseMspError } from "./connection";

/** Separate later developer instructions from an otherwise exact tool-result continuation. */
export function museDeveloperContinuation(parsed: OcxParsedRequest, project: boolean): { toolRequest: OcxParsedRequest; steering?: string } | undefined {
  const messages=parsed.context.messages;
  let end=messages.length;
  while(end>0 && messages[end-1]?.role==="developer") end--;
  if(end===messages.length || messages[end-1]?.role!=="toolResult") return undefined;
  if(!project) throw new MuseMspError("unsupported_developer_continuation");
  const pieces=messages.slice(end).map(message=>{
    if(message.role!=="developer") throw new MuseMspError("invalid_developer_continuation");
    if(typeof message.content==="string") return message.content;
    if(!Array.isArray(message.content)||message.content.some(part=>part.type!=="text"||typeof part.text!=="string"))
      throw new MuseMspError("unsupported_developer_continuation");
    return message.content.map(part=>(part as {text:string}).text).join("");
  });
  const steering=pieces.join("\n\n");
  if(!steering || Buffer.byteLength(steering)>1024*1024) throw new MuseMspError("invalid_developer_continuation");
  return {toolRequest:{...parsed,context:{...parsed.context,messages:messages.slice(0,end)}},steering};
}

export function endsWithMuseToolResult(parsed: OcxParsedRequest): boolean {
  let end=parsed.context.messages.length;
  while(end>0 && parsed.context.messages[end-1]?.role==="developer") end--;
  return parsed.context.messages[end-1]?.role==="toolResult";
}
