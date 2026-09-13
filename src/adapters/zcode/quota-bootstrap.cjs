// Runs in a private state directory; an OS sandbox is optional. Native host and RPC modules are unmodified official ZCode.
// No HTTP implementation, quota reset or model inference here. All diagnostics stay off stdout.
const {EventEmitter}=require('node:events');
const fs=require('node:fs');
const parent=new EventEmitter(); parent.postMessage=()=>{}; process.parentPort=parent;
const output=process.stdout.write.bind(process.stdout); process.stdout.write=process.stderr.write.bind(process.stderr); const originalLog=value=>output(value+'\n');
const host=process.env.OCX_ZCODE_QUOTA_HOST==='1';
const stateHome=host?process.env.ZCODE_DATA_BASE_DIR:process.env.HOME;
const profile=host?process.env.OCX_ZCODE_QUOTA_CONFIG:'/desktop/config.json';
const credentials=host?process.env.OCX_ZCODE_QUOTA_CREDENTIALS:'/desktop/credentials.json';
fs.mkdirSync(stateHome+'/.zcode/v2',{recursive:true});
const input=JSON.parse(fs.readFileSync(profile,'utf8'));
if(process.argv[2]==='advanced') {
 const raw=input.provider?.[process.argv[3]];
 const url=new URL(raw?.options?.baseURL);
 if(url.protocol!=='https:' || url.hostname!=='api.z.ai' || url.username || url.password || !raw.options.apiKey) throw new Error('unsupported profile');
 fs.writeFileSync(stateHome+'/.zcode/v2/config.json',JSON.stringify({provider:{'builtin:zai-coding-plan':{...raw,name:'Z.ai - Coding Plan',enabled:true}}}),{mode:0o600});
} else {
 fs.copyFileSync(profile,stateHome+'/.zcode/v2/config.json');
 if(credentials && fs.existsSync(credentials)) fs.copyFileSync(credentials,stateHome+'/.zcode/v2/credentials.json');
}
setTimeout(()=>{originalLog(JSON.stringify({error:'timeout'}));process.exit(1)},40000);
(async()=>{
 const dir=(host?process.env.OCX_ZCODE_QUOTA_RUNTIME:'/zcode')+'/resources/app.asar/out/host';
 let classes;
 for(const name of fs.readdirSync(dir).filter(n=>n.startsWith('chunk-')&&n.endsWith('.js'))){
  const source=fs.readFileSync(dir+'/'+name,'utf8');if(source.includes('"ChannelClient"')&&source.includes('"MessagePortProtocol"')){classes=Object.values(await import(dir+'/'+name));break;}
 }
 const Client=classes.find(v=>v?.name==='ChannelClient');const Protocol=classes.find(v=>v?.name==='MessagePortProtocol');
 const left=new EventEmitter(),right=new EventEmitter();
 for(const [a,b]of [[left,right],[right,left]]){a.postMessage=data=>queueMicrotask(()=>b.emit('message',{data,ports:[]}));a.start=()=>{};a.close=()=>a.emit('close');a.addEventListener=a.on.bind(a);a.removeEventListener=a.off.bind(a);}
 const client=new Client(new Protocol(left));
 await import(dir+'/index.js');
 parent.emit('message',{data:{type:'init-local'},ports:[right]});
 const result=await client.getChannel('usage-stats').call('getEntitlementSnapshot',[{preferredProviderId:'builtin:zai-coding-plan',requirePreferredProvider:true,allowEnvApiKey:false,includeSubscription:false}]);
 const limits=Array.isArray(result.quota?.limits)?result.quota.limits.slice(0,16).map(row=>({
 type: ['CREDIT_LIMIT','TOKENS_LIMIT','TIME_LIMIT'].includes(row.type)?row.type:'unknown',
 ...Object.fromEntries(['unit','number','usage','currentValue','remaining','percentage','nextResetTime'].filter(k=>typeof row[k]==='number'&&Number.isFinite(row[k])).map(k=>[k,row[k]])),
})):[];
 originalLog(JSON.stringify({generatedAt:result.generatedAt,limits}));process.exit(0);
})().catch(()=>{originalLog(JSON.stringify({error:'failed'}));process.exit(1)});
