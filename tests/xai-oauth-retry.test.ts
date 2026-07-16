import { afterEach, describe, expect, test } from "bun:test";
import { postXaiToken, XaiTokenRequestError } from "../src/oauth/xai";
const original=globalThis.fetch; afterEach(()=>{globalThis.fetch=original;});
function queue(items:Array<Response|Error>){let n=0;globalThis.fetch=(async()=>{const x=items[n++]!;if(x instanceof Error)throw x;return x;}) as typeof fetch;return()=>n;}
const body={grant_type:"refresh_token",client_id:"client",refresh_token:"secret"}; const ok=()=>new Response(JSON.stringify({access_token:"a",refresh_token:"r",expires_in:3600}));
describe("xAI retry",()=>{
 test("network retry succeeds",async()=>{const calls=queue([new Error("net"),ok()]),d:number[]=[];await postXaiToken("https://auth.x.ai/token",body,undefined,{sleep:async x=>{d.push(x)},random:()=>.5});expect(calls()).toBe(2);expect(d).toEqual([100]);});
 test("429 and 5xx retry at most three attempts",async()=>{const calls=queue([new Response("",{status:429}),new Response("",{status:503}),ok()]),d:number[]=[];await postXaiToken("https://auth.x.ai/token",body,undefined,{sleep:async x=>{d.push(x)},random:()=>.5});expect(calls()).toBe(3);expect(d).toEqual([100,250]);});
 test("third transient failure is final",async()=>{const calls=queue([500,502,503].map(status=>new Response("",{status})));await expect(postXaiToken("https://auth.x.ai/token",body,undefined,{sleep:async()=>{},random:()=>.5})).rejects.toMatchObject({status:503});expect(calls()).toBe(3);});
 test("permanent 4xx is not retried or leaked",async()=>{const calls=queue([new Response(JSON.stringify({error:"invalid_grant"}),{status:400})]);await expect(postXaiToken("https://auth.x.ai/token",body,undefined,{sleep:async()=>{}})).rejects.toBeInstanceOf(XaiTokenRequestError);expect(calls()).toBe(1);});
 test("caller abort is not retried",async()=>{const c=new AbortController();c.abort();let calls=0;globalThis.fetch=(async()=>{calls++;throw new DOMException("aborted","AbortError")}) as typeof fetch;await expect(postXaiToken("https://auth.x.ai/token",body,c.signal,{sleep:async()=>{}})).rejects.toMatchObject({name:"AbortError"});expect(calls).toBe(1);});
});
