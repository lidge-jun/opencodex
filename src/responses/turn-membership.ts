/** Authenticated structural output-turn membership; never execution or opaque-state authority. */
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
type Item=Record<string,unknown>;
type Scope={principal:string;thread:string};
type Kind='message'|'function_call'|'custom_tool_call'|'tool_search_call'|'reasoning'|'web_search_call';
const kinds=new Map<Kind,{prefix:string;code:string}>([
 ['message',{prefix:'msg',code:'m'}],['function_call',{prefix:'fc',code:'f'}],['custom_tool_call',{prefix:'ctc',code:'c'}],['tool_search_call',{prefix:'tsc',code:'s'}],['reasoning',{prefix:'rs',code:'r'}],['web_search_call',{prefix:'ws',code:'w'}],
]);
const calls=new Set(['function_call','custom_tool_call','tool_search_call']);
const plain=(x:unknown):x is Item=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const text=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=4096;
const reserved=/^(?:msg|fc|ctc|tsc|rs|ws)_ocxt/;
const pattern=/^(msg|fc|ctc|tsc|rs|ws)_ocxt1_([A-Za-z0-9]{1,12})_([A-Za-z0-9_-]{22})_([0-9a-z]{1,4})_([mfcsrw])_([A-Za-z0-9_-]{22})$/;
const resultTypes=new Set(['function_call_output','custom_tool_call_output','tool_search_output']);
const resultType=(type:unknown)=>type==='function_call'?'function_call_output':type==='custom_tool_call'?'custom_tool_call_output':'tool_search_output';
type Member={item:Item;position:number;ordinal:number};
/** Reorder only closed authenticated spans while retaining every original payload object. */
function normalizeGroups(input:unknown[],groups:Member[][]):unknown[]{
 type Occurrence={item:Item;position:number;count:number};
 const byCall=new Map<string,Occurrence>(),byResult=new Map<string,Occurrence>();
 const index=(map:Map<string,Occurrence>,item:Item,position:number)=>{const key=item.call_id as string,old=map.get(key);if(old)old.count++;else map.set(key,{item,position,count:1});};
 for(let i=0;i<input.length;i++){const item=input[i];if(!plain(item)||!text(item.call_id))continue;
  if(calls.has(String(item.type)))index(byCall,item,i);else if(resultTypes.has(String(item.type)))index(byResult,item,i);
 }
 const spans:{first:number;last:number;items:unknown[]}[]=[];
 for(const members of groups){
  if(!members.some(m=>calls.has(String(m.item.type))))continue;
  if(members.some((m,i)=>i>0&&m.ordinal<=members[i-1]!.ordinal))return input;
  const memberIds=new Set(members.map(m=>m.item.id));if(memberIds.size!==members.length)return input;
  const groupCalls=members.filter(m=>calls.has(String(m.item.type))),resultPositions:number[]=[];let valid=true;
  for(const {item} of groupCalls){const call=byCall.get(item.call_id as string),result=byResult.get(item.call_id as string);
   if(call?.count!==1||result?.count!==1||result.item.type!==resultType(item.type)
       || (item.type==='tool_search_call'
         ? result.item.execution!=='client'||!Array.isArray(result.item.tools)
         : !Object.hasOwn(result.item,'output'))){valid=false;break;}
   resultPositions.push(result.position);
  }
  if(!valid)return input;
  const first=members[0]!.position,last=Math.max(members.at(-1)!.position,...resultPositions);
  if(resultPositions.some(i=>i<first))return input;
  const outputs:unknown[]=[],seenCalls=new Set<string>(),seenResults=new Set<string>();
  for(let i=first;i<=last;i++){
   const item=input[i];if(!plain(item)){valid=false;break;}
   if(memberIds.has(item.id)){if(calls.has(String(item.type)))seenCalls.add(item.call_id as string);}
   else if(resultTypes.has(String(item.type))&&text(item.call_id)&&seenCalls.has(item.call_id)&&!seenResults.has(item.call_id)){seenResults.add(item.call_id);outputs.push(item);}
   else{valid=false;break;}
  }
  if(!valid)return input;
  const items=[...members.filter(m=>!calls.has(String(m.item.type))).map(m=>m.item),...groupCalls.map(m=>m.item),...outputs];
  if(items.some((item,index)=>item!==input[first+index]))spans.push({first,last,items});
 }
 if(!spans.length)return input;spans.sort((a,b)=>a.first-b.first);if(spans.some((s,i)=>i>0&&s.first<=spans[i-1]!.last))return input;
 const output:unknown[]=[];let cursor=0;for(const s of spans){output.push(...input.slice(cursor,s.first),...s.items);cursor=s.last+1;}output.push(...input.slice(cursor));return output;
}
/** Authenticate structural replay membership without signing customer payload contents. */
export class TurnTokenCodec {
 private readonly keys:ReadonlyMap<string,Uint8Array>;
 /** Validate and own an independent copy of the bounded signing-key ring. */
 constructor(keys:ReadonlyMap<string,Uint8Array>,private readonly activeKeyId:string){
  if(keys.size<1||keys.size>8||!keys.has(activeKeyId))throw Error('Missing active turn-membership key');
  const owned=new Map<string,Uint8Array>();for(const [id,key] of keys){if(!/^[A-Za-z0-9]{1,12}$/.test(id)||key.length<32||key.length>64)throw Error('Invalid turn-membership key');owned.set(id,Uint8Array.from(key));}this.keys=owned;
 }
 /** Accept only an explicit principal and own-thread scope. */
 private scope(scope:unknown):Scope|undefined{if(!plain(scope)||!text(scope.principal)||!text(scope.thread))return;return{principal:scope.principal,thread:scope.thread};}
 /** Bind the token header to its key, caller and thread using a domain-separated HMAC. */
 private tag(keyId:string,scope:Scope,header:string):Buffer|undefined{
  const key=this.keys.get(keyId);if(!key)return;
  return createHmac('sha256',key).update('opencodex.response-turn-membership.v1\0'+JSON.stringify([scope.principal,scope.thread,header])).digest().subarray(0,16);
 }
 /** Mint at item start. This authenticates grouping, never completion or future payload bytes. */
 begin(scope:unknown):{next:(kind:Kind)=>string}{
  const bound=this.scope(scope);if(!bound)throw Error('Trusted caller/thread scope is required');
  const nonce=randomBytes(16).toString('base64url'),keyId=this.activeKeyId;let ordinal=0;
  return{next:(kind:Kind)=>{const descriptor=kinds.get(kind);if(!descriptor||ordinal>65535)throw Error('Invalid turn item kind or index');
   const header=descriptor.prefix+'_ocxt1_'+keyId+'_'+nonce+'_'+(ordinal++).toString(36)+'_'+descriptor.code;
   return header+'_'+this.tag(keyId,bound,header)!.toString('base64url');
  }};
 }
 /** Verify bounded item membership; malformed or mismatched scopes have no authority. */
 private verify(scope:Scope,item:Item):{group:string;ordinal:number}|undefined{
  if(typeof item.id!=='string'||item.id.length>128)return;
  const match=pattern.exec(item.id);if(!match)return;
  const [_,prefix,keyId,nonce,index,code,encodedTag]=match;
  if(!prefix||!keyId||!nonce||!index||!code||!encodedTag)return;
  const descriptor=kinds.get(item.type as Kind);if(!descriptor||descriptor.prefix!==prefix||descriptor.code!==code)return;
  const ordinal=Number.parseInt(index,36);if(!Number.isSafeInteger(ordinal)||ordinal>65535||ordinal.toString(36)!==index)return;
  if(Buffer.from(nonce,'base64url').toString('base64url')!==nonce||Buffer.from(encodedTag,'base64url').toString('base64url')!==encodedTag)return;
  const expected=this.tag(keyId,scope,item.id.slice(0,-23)),actual=Buffer.from(encodedTag,'base64url');
  if(!expected||actual.length!==16||!timingSafeEqual(actual,expected))return;
  if(item.status!==undefined&&item.status!=='completed')return;
  if(item.type==='message'&&item.role!=='assistant')return;
  if(calls.has(String(item.type))&&!text(item.call_id))return;
  if((item.type==='function_call'||item.type==='custom_tool_call')&&!text(item.name))return;
  if(item.type==='function_call'&&typeof item.arguments!=='string')return;
  if(item.type==='custom_tool_call'&&typeof item.input!=='string')return;
  if(item.type==='tool_search_call'&&(item.execution!=='client'||!plain(item.arguments)))return;
  return{group:keyId+':'+nonce,ordinal};
 }
 normalize(scope:unknown,input:unknown[]):unknown[]{
  const bound=this.scope(scope);if(!bound||input.length>65536)return input;
  const groups=new Map<string,Member[]>();
  for(let position=0;position<input.length;position++){
   const item=input[position];if(!plain(item)||typeof item.id!=='string'||!reserved.test(item.id))continue;
   const verified=this.verify(bound,item);if(!verified)return input;
   const group=groups.get(verified.group)??[];
   if(group.length&&verified.ordinal<=group.at(-1)!.ordinal)return input;
   group.push({item,position,ordinal:verified.ordinal});groups.set(verified.group,group);
  }
  return normalizeGroups(input,[...groups.values()]);
 }
}
