import {expect,test} from 'bun:test';
import {TurnTokenCodec} from '../../src/responses/turn-membership';
import {parseRequest} from '../../src/responses/parser';
import {createOpenAIChatAdapter} from '../../src/adapters/openai-chat';
const key=new Uint8Array(32).fill(21),scope={principal:'owned-caller',thread:'owned-thread'};
const codec=()=>new TurnTokenCodec(new Map([['k1',key]]),'k1');
function fixture(c=codec()){
 const epoch=c.begin(scope);
 const call={type:'function_call',id:epoch.next('function_call'),call_id:'call_owned',name:'lookup',arguments:'{"q":"x"}'};
 const message={type:'message',id:epoch.next('message'),role:'assistant',content:[{type:'output_text',text:'owned commentary'}]};
 const result={type:'function_call_output',call_id:'call_owned',output:'REAL_TOOL_RESULT'};
 return {c,call,message,result};
}
function wire(input:unknown[]){const p=parseRequest({model:'fixture-model',tools:[{type:'function',name:'lookup',parameters:{type:'object'}}],input});const b=createOpenAIChatAdapter({adapter:'openai-chat',baseUrl:'https://fixture.invalid/v1',apiKey:'unused'}).buildRequest(p);if(b instanceof Promise)throw Error('unexpected asynchronous build');return b.body;}
test('versioned kind-correct IDs are bounded and unique',()=>{
 const {c,call,message}=fixture();expect(call.id).toMatch(/^fc_ocxt1_/);expect(message.id).toMatch(/^msg_ocxt1_/);
 expect(call.id.length).toBeLessThan(128);expect(message.id.length).toBeLessThan(128);
 expect(fixture(c).call.id).not.toBe(call.id);
});
test('signed early items reconstruct the exact buffered second-turn request',()=>{
 const {c,call,message,result}=fixture();const input=[call,message,result];
 expect(wire(c.normalize(scope,input))).toBe(wire([message,call,result]));expect(input).toEqual([call,message,result]);
});
test('signed client tool search keeps the real result and normalizes its turn group',()=>{
 const c=codec(),epoch=c.begin(scope);
 const call={type:'tool_search_call',id:epoch.next('tool_search_call'),call_id:'search_owned',execution:'client',arguments:{query:'files'},status:'completed'};
 const message={type:'message',id:epoch.next('message'),role:'assistant',content:[{type:'output_text',text:'searching'}]};
 const result={type:'tool_search_output',call_id:'search_owned',execution:'client',status:'completed',tools:[{type:'function',name:'read_file'}]};
 const input=[call,message,result],normalized=c.normalize(scope,input);
 expect(normalized).toEqual([message,call,result]);expect(normalized[0]).toBe(message);expect(normalized[1]).toBe(call);expect(normalized[2]).toBe(result);
});
for(const mode of ['missing','wrong-type','wrong-execution','missing-tools','duplicate','malformed-call'])test('client tool search fails closed: '+mode,()=>{
 const c=codec(),epoch=c.begin(scope);
 let call:any={type:'tool_search_call',id:epoch.next('tool_search_call'),call_id:'search_owned',execution:'client',arguments:{query:'files'},status:'completed'};
 const message={type:'message',id:epoch.next('message'),role:'assistant',content:[]};
 let result:any={type:'tool_search_output',call_id:'search_owned',execution:'client',status:'completed',tools:[]};
 let input:any[];
 if(mode==='wrong-type')result={...result,type:'function_call_output',output:'wrong'};
 if(mode==='wrong-execution')result={...result,execution:'server'};
 if(mode==='missing-tools'){const {tools:_,...without}=result;result=without;}
 if(mode==='malformed-call')call={...call,arguments:'{"query":"files"}'};
 input=mode==='missing'?[call,message]:[call,message,result];
 if(mode==='duplicate')input.push(result);
 expect(c.normalize(scope,input)).toBe(input);
});
test('fresh codec and changed upstream context preserve client-owned grouping',()=>{
 const {call,message,result}=fixture();const fresh=codec();
 expect(wire(fresh.normalize({...scope,model:'other-model',provider:'other-provider',credential:'rotated'},[call,message,result]))).toBe(wire([message,call,result]));
});
for(const changed of [{...scope,principal:'another'},{...scope,thread:'another'},{}])test('wrong or incomplete transport scope does not normalize '+JSON.stringify(changed),()=>{
 const {c,call,message,result}=fixture();const input=[call,message,result];expect(c.normalize(changed,input)).toBe(input);
});
test('untagged malformed history is unchanged',()=>{const {c,call,message,result}=fixture();const input=[{...call,id:'fc_unowned'},{...message,id:'msg_unowned'},result];expect(c.normalize(scope,input)).toBe(input);});
test('rotation retains verification of old keys and mints only with the newest key',()=>{
 const {call,message,result}=fixture();const rotated=new TurnTokenCodec(new Map([['k1',key],['k2',new Uint8Array(32).fill(22)]]),'k2');
 expect(wire(rotated.normalize(scope,[call,message,result]))).toBe(wire([message,call,result]));expect(rotated.begin(scope).next('message')).toContain('_k2_');
});
for(const mode of ['unknown-key','wrong-key','version','tag','kind','index','truncated'])test('invalid token leaves generic history intact: '+mode,()=>{
 const {c,call,message,result}=fixture();let verifier=c,changed={...call};
 if(mode==='unknown-key')verifier=new TurnTokenCodec(new Map([['k2',key]]),'k2');
 if(mode==='wrong-key')verifier=new TurnTokenCodec(new Map([['k1',new Uint8Array(32).fill(23)]]),'k1');
 if(mode==='version')changed.id=call.id.replace('_ocxt1_','_ocxt2_');
 if(mode==='tag')changed.id=call.id.slice(0,-2)+(call.id.at(-2)==='A'?'B':'A')+call.id.at(-1);
 if(mode==='kind')changed.type='custom_tool_call';
 if(mode==='index')changed.id=call.id.replace('_0_f_','_1_f_');
 if(mode==='truncated')changed.id=call.id.slice(0,-1);
 const input=[changed,message,result];expect(verifier.normalize(scope,input)).toBe(input);
});
for(const status of ['failed','in_progress','incomplete','bogus',null])test('noncompleted replay status is refused: '+status,()=>{
 const {c,call,message,result}=fixture();const input=[{...call,status},message,result];expect(c.normalize(scope,input)).toBe(input);
});
for(const mode of ['missing-result','duplicate-result','premature-result','foreign-item','explicit-boundary','duplicate-id','duplicate-call','wrong-result-type','missing-output','reversed-members'])test('closed-span guard remains: '+mode,()=>{
 const {c,call,message,result}=fixture();let input:any[]=[call,message,result];
 if(mode==='missing-result')input=[call,message];
 if(mode==='duplicate-result')input.push(result);
 if(mode==='premature-result')input=[result,call,message];
 if(mode==='foreign-item')input=[call,{type:'message',role:'user',content:'new request'},message,result];
 if(mode==='explicit-boundary')input=[call,{type:'assistant_boundary'},message,result];
 if(mode==='duplicate-id')input=[call,call,message,result];
 if(mode==='duplicate-call')input.push({...call,id:'fc_unowned'});
 if(mode==='wrong-result-type')input=[call,message,{...result,type:'custom_tool_call_output'}];
 if(mode==='missing-output'){const {output:_,...empty}=result;input=[call,message,empty];}
 if(mode==='reversed-members')input=[message,call,result];
 expect(c.normalize(scope,input)).toBe(input);
});
test('payload edits retain structural ownership without retrieving opaque metadata or executing history',()=>{
 const {c,call,message,result}=fixture();const editedCall={...call,arguments:'{"q":"caller edit"}'},editedMessage={...message,content:[{type:'output_text',text:'edited commentary'}]};
 const input=[editedCall,editedMessage,{...result,output:'EDITED_REAL_RESULT'}];const normalized=c.normalize(scope,input);
 expect(wire(normalized)).toBe(wire([editedMessage,editedCall,input[2]]));expect(normalized.every(x=>input.includes(x as any))).toBe(true);
});
test('fresh boundary nonce cannot join the previous epoch',()=>{
 const {c,call,result}=fixture();const other=c.begin(scope);const message={type:'message',id:other.next('message'),role:'assistant',content:[{type:'output_text',text:'another epoch'}]};
 const input=[call,message,result];expect(c.normalize(scope,input)).toBe(input);
});
test('captured scope and key bytes cannot change after epoch creation',()=>{
 const mutable={...scope},material=key.slice();const c=new TurnTokenCodec(new Map([['k1',material]]),'k1');const epoch=c.begin(mutable);mutable.thread='changed';material.fill(0);
 const call={type:'function_call',id:epoch.next('function_call'),call_id:'stable_call',name:'lookup',arguments:'{}'},message={type:'message',id:epoch.next('message'),role:'assistant',content:[]},result={type:'function_call_output',call_id:'stable_call',output:'ok'};
 expect(c.normalize(scope,[call,message,result])).toEqual([message,call,result]);
});
test('Buffer signing material is copied independently of caller storage',()=>{
 const material=Buffer.from(key),c=new TurnTokenCodec(new Map([['k1',material]]),'k1');
 const {call,message,result}=fixture(c);material.fill(0);
 expect(c.normalize(scope,[call,message,result])).toEqual([message,call,result]);
});
test('missing keys and absent trusted scope cannot mint membership',()=>{
 expect(()=>new TurnTokenCodec(new Map(),'k1')).toThrow();expect(()=>codec().begin({thread:'x'})).toThrow();
});
test('linear indexing on a long history retains every group and real result',()=>{
 const c=codec(),input:unknown[]=[];for(let i=0;i<100;i++){const f=fixture(c);f.call.call_id='call_'+i;f.result.call_id='call_'+i;input.push(f.call,f.message,f.result);}
 let reads=0;const observed=new Proxy(input,{get(t,k,r){if(typeof k==='string'&&/^\d+$/.test(k))reads++;return Reflect.get(t,k,r);}});
 const normalized=c.normalize(scope,observed);expect(normalized.length).toBe(input.length);expect(reads).toBeLessThan(input.length*30);
});
test('duplicate signed indices cannot hide in an otherwise call-only group',()=>{
 const {c,call,message,result}=fixture();const badEpoch=c.begin(scope),id=badEpoch.next('function_call');
 const bad={...call,id,call_id:'duplicate_group_call'};const input=[call,message,result,bad,bad];expect(c.normalize(scope,input)).toBe(input);
});
test('mixed parallel custom and namespaced calls preserve all results across 100 stream orders',()=>{
 const c=codec();let state=123456789;
 const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
 for(let trial=0;trial<100;trial++){
  const epoch=c.begin(scope);
  const definitions=[
   {type:'function_call' as const,call_id:'parallel_a',name:'namespace.lookup',arguments:'{"q":"a"}'},
   {type:'custom_tool_call' as const,call_id:'parallel_b',name:'apply_patch',input:'*** Begin Patch\n*** End Patch'},
   {type:'message' as const,role:'assistant',content:[{type:'output_text',text:'commentary'}]},
   {type:'reasoning' as const,summary:[{type:'summary_text',text:'retained summary'}]},
   {type:'web_search_call' as const,status:'completed',action:{type:'search',query:'owned fixture'}},
  ];
  for(let i=definitions.length-1;i>0;i--){const j=random()%(i+1);[definitions[i],definitions[j]]=[definitions[j]!,definitions[i]!];}
  const members=definitions.map(item=>({...item,id:epoch.next(item.type)}));
  const outputs=[{type:'custom_tool_call_output',call_id:'parallel_b',output:'REAL_CUSTOM_RESULT'},{type:'function_call_output',call_id:'parallel_a',output:'REAL_FUNCTION_RESULT'}];
  const input=[...members,...outputs],expected=[...members.filter(item=>item.type!=='function_call'&&item.type!=='custom_tool_call'),...members.filter(item=>item.type==='function_call'||item.type==='custom_tool_call'),...outputs];
  const normalized=c.normalize(scope,input);
  expect(normalized).toEqual(expected);
  expect(normalized.every(item=>input.includes(item))).toBe(true);
  expect(normalized.length).toBe(input.length);
  expect(c.normalize(scope,normalized)).toBe(normalized);
 }
});
test('a caller-pruned group retains structural membership without claiming omitted items',()=>{
 const c=codec(),epoch=c.begin(scope);
 epoch.next('reasoning');
 const call={type:'function_call',id:epoch.next('function_call'),name:'lookup',call_id:'pruned',arguments:'{}'};
 epoch.next('web_search_call');
 const message={type:'message',id:epoch.next('message'),role:'assistant',content:[]};
 const result={type:'function_call_output',call_id:'pruned',output:'REAL'};
 expect(c.normalize(scope,[call,message,result])).toEqual([message,call,result]);
});
test('removing a retained signing key refuses normalization without rewriting the history',()=>{
 const {call,message,result}=fixture();
 const retired=new TurnTokenCodec(new Map([['k2',new Uint8Array(32).fill(22)]]),'k2');
 const input=[call,message,result];expect(retired.normalize(scope,input)).toBe(input);
});
test('call-only turn groups reunite interleaved parallel calls and real outputs',()=>{
 const c=codec(),epoch=c.begin(scope);
 const first={type:'function_call',id:epoch.next('function_call'),name:'lookup',call_id:'first',arguments:'{}'};
 const second={type:'function_call',id:epoch.next('function_call'),name:'lookup',call_id:'second',arguments:'{}'};
 const firstOutput={type:'function_call_output',call_id:'first',output:'FIRST_REAL'};
 const secondOutput={type:'function_call_output',call_id:'second',output:'SECOND_REAL'};
 expect(c.normalize(scope,[first,firstOutput,second,secondOutput])).toEqual([first,second,firstOutput,secondOutput]);
});
for(const mode of ['duplicate-result','missing-result','foreign-item'])test('invalid group keeps the whole history unchanged beside a valid group: '+mode,()=>{
 const c=codec(),bad=fixture(c),good=fixture(c);good.call.call_id='other_call';good.result.call_id='other_call';
 let malformed:unknown[]=[bad.call,bad.message,bad.result];
 if(mode==='duplicate-result')malformed.push(bad.result);
 if(mode==='missing-result')malformed=[bad.call,bad.message];
 if(mode==='foreign-item')malformed=[bad.call,{type:'message',role:'user',content:'boundary'},bad.message,bad.result];
 const input=[...malformed,good.call,good.message,good.result];
 expect(c.normalize(scope,input)).toBe(input);
});


import {responseTurnMembership} from '../../src/server/responses/turn-membership';
test('embedding key and verified dedicated client establish restart-stable thread scope',()=>{
 const old=process.env.OPENCODEX_API_AUTH_TOKEN;process.env.OPENCODEX_API_AUTH_TOKEN='owned-local-capability';
 try{
  const req=new Request('http://127.0.0.1/v1/responses',{headers:{'x-opencodex-api-key':'owned-local-capability','thread-id':'owned-thread'}});
  const config={apiKeys:[]},admission={kind:'loopback',source:'loopback'} as const;
  const key='dr_turn_v1_'+Buffer.alloc(32,19).toString('base64url');
  const context=responseTurnMembership(req,config,admission,key);expect(context).toBeDefined();
  if(!context)throw Error('missing owned context');
  const epoch=context.begin();const call={type:'function_call',id:epoch.next('function_call'),name:'lookup',call_id:'owned',arguments:'{}'};
  const message={type:'message',id:epoch.next('message'),role:'assistant',content:[]};const result={type:'function_call_output',call_id:'owned',output:'REAL'};
  expect(responseTurnMembership(req,config,admission,key)?.normalize([call,message,result])).toEqual([message,call,result]);
  for(const material of [undefined,'bad','dr_turn_v1_'+Buffer.alloc(32,20).toString('base64url')]){
   const context=responseTurnMembership(req,config,admission,material??'');
   const input=[call,message,result];expect(context?.normalize(input)??input).toBe(input);
  }
  expect(responseTurnMembership(new Request(req.url,{headers:{'x-opencodex-api-key':'wrong','thread-id':'owned-thread'}}),config,admission,key)).toBeUndefined();
  expect(responseTurnMembership(new Request(req.url,{headers:{'x-opencodex-api-key':'owned-local-capability','session-id':'shared-cohort'}}),config,admission,key)).toBeUndefined();
 }finally{if(old===undefined)delete process.env.OPENCODEX_API_AUTH_TOKEN;else process.env.OPENCODEX_API_AUTH_TOKEN=old;}
});

test('parallel siblings never share membership through their parent or cache cohort',()=>{
 const old=process.env.OPENCODEX_API_AUTH_TOKEN;process.env.OPENCODEX_API_AUTH_TOKEN='owned-local-capability';
 try{
  const key='dr_turn_v1_'+Buffer.alloc(32,24).toString('base64url'),config={apiKeys:[]},admission={kind:'loopback',source:'loopback'} as const;
  const req=(thread?:string,parent='shared-parent')=>new Request('http://127.0.0.1/v1/responses',{headers:{'x-opencodex-api-key':'owned-local-capability','x-codex-parent-thread-id':parent,'session-id':'shared-cohort',...(thread?{'thread-id':thread}:{})}});
  const first=responseTurnMembership(req('child-a'),config,admission,key);if(!first)throw Error('missing first context');const epoch=first.begin();
  const call={type:'function_call',id:epoch.next('function_call'),name:'lookup',call_id:'owned',arguments:'{}'};
  const message={type:'message',id:epoch.next('message'),role:'assistant',content:[]};const result={type:'function_call_output',call_id:'owned',output:'REAL'};const input=[call,message,result];
  expect(responseTurnMembership(req('child-b'),config,admission,key)?.normalize(input)).toBe(input);
  expect(responseTurnMembership(req(undefined),config,admission,key)).toBeUndefined();
  expect(responseTurnMembership(req('child-a','changed-lineage-parent'),config,admission,key)?.normalize(input)).toEqual([message,call,result]);
 }finally{if(old===undefined)delete process.env.OPENCODEX_API_AUTH_TOKEN;else process.env.OPENCODEX_API_AUTH_TOKEN=old;}
});
