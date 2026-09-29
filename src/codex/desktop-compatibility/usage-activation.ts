/** Account-bound, time-limited compatibility activation; no persistent settings or timers. */
export type Observation = 'exhausted' | 'available' | 'protected';
export type ApplyScope = 'selected-external-model' | 'account-ui-compatibility';
type RefreshResult = {requested:number;closed:number;failed:number};
export class UsageActivation {
  private mode: 'observe' | 'apply' = 'observe';
  private phase = 'observing';
  private generation = 0;
  private latest: { kind:Observation; at:number } | null = null;
  private startedAt: number | null = null;
  private outputs = 0;
  constructor(private binding:string, private refresh:(binding:string)=>Promise<RefreshResult>,
    private verifyIdentity:()=>Promise<string|null>,
    private clock:()=>number=Date.now, private timeoutMs=180000) {
    if(!binding || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>180000) throw new Error('Invalid activation limits');
  }
  snapshot() { return {mode:this.mode,phase:this.phase,generation:this.generation,outputs:this.outputs,
    appCacheConfirmed:false,requestedUiScope:'account-wide',providerIsolationAvailable:false}; }
  invalidateIdentity() {
    this.mode='observe';this.phase='identity-invalidated';this.startedAt=null;this.latest=null;this.outputs=0;++this.generation;
  }
  observe(binding:string,kind:Observation) {
    if(binding!==this.binding)return false;
    this.latest={kind,at:this.clock()};
    // A recovered or protected account must not silently re-enter a previous trial
    // if a later snapshot becomes exhausted again. A new trial requires consent.
    if(this.mode==='apply'&&kind!=='exhausted'){
      this.mode='observe';this.phase=kind==='available'?'usage-recovered':'protected-observation';
      this.startedAt=null;this.outputs=0;++this.generation;
    }
    return true;
  }
  private async reset(phase:string) {
    this.mode='observe';this.phase=phase;this.startedAt=null;this.latest=null;this.outputs=0;++this.generation;
    return this.refresh(this.binding);
  }
  async activate(options:{scope:ApplyScope;accountWideConsent:boolean}) {
    if(options.scope!=='account-ui-compatibility')return{accepted:false,reason:'selected-model-scope-unavailable',...this.snapshot()};
    if(!options.accountWideConsent)return{accepted:false,reason:'account-wide-scope-not-accepted',...this.snapshot()};
    const beforeVerification=this.generation,binding=this.binding;
    let verified:string|null;
    try{verified=await this.verifyIdentity();}catch{verified=null;}
    if(verified!==binding||this.binding!==binding||this.generation!==beforeVerification)return{accepted:false,reason:'identity-not-verified',...this.snapshot()};
    if(this.mode==='apply')return{accepted:false,reason:'activation-already-pending',...this.snapshot()};
    const age=this.latest?this.clock()-this.latest.at:Infinity;
    if(!this.latest||this.latest.kind!=='exhausted'||age<0||age>300000)return{accepted:false,reason:'no-fresh-eligible-exhaustion',...this.snapshot()};
    // An exhausted observation authorizes one trial, not every retry within its TTL.
    this.latest=null;
    this.mode='apply';this.phase='awaiting-fresh-usage';this.startedAt=this.clock();this.outputs=0;
    const generation=++this.generation;
    let refreshed:RefreshResult;
    try { refreshed=await this.refresh(this.binding); }
    catch {
      if(this.generation===generation){this.mode='observe';this.phase='refresh-failed';this.startedAt=null;this.latest=null;this.outputs=0;++this.generation;}
      return{accepted:false,reason:'refresh-failed',...this.snapshot()};
    }
    // Account/mode changes while a close callback awaited invalidate this activation.
    if(this.generation!==generation)return{accepted:false,reason:'superseded',...this.snapshot()};
    // The registry settles every close and reports failures; it does not reject the batch.
    // Partial closure cannot leave rewriting enabled while an old app cache may survive.
    if(!Number.isSafeInteger(refreshed.requested)||!Number.isSafeInteger(refreshed.closed)
      ||!Number.isSafeInteger(refreshed.failed)||refreshed.requested<0||refreshed.closed<0
      ||refreshed.failed!==0||refreshed.closed!==refreshed.requested){
      this.mode='observe';this.phase='refresh-failed';this.startedAt=null;this.latest=null;this.outputs=0;++this.generation;
      return{accepted:false,reason:'refresh-failed',refresh:refreshed,...this.snapshot()};
    }
    return{accepted:true,reason:'awaiting-new-response',refresh:refreshed,...this.snapshot()};
  }
  recordOutput(binding:string,generation:number) {
    if(binding!==this.binding||generation!==this.generation||this.mode!=='apply')return false;
    if(this.startedAt===null||this.clock()-this.startedAt<0||this.clock()-this.startedAt>=this.timeoutMs)return false;
    ++this.outputs;this.phase='response-produced-app-confirmation-needed';return true;
  }
  async expireIfNeeded() {
    if(this.startedAt===null||this.clock()-this.startedAt<this.timeoutMs&&this.clock()-this.startedAt>=0)return false;
    await this.reset('expired-awaiting-original-response');return true;
  }
  async observeOnly() { return this.reset('observing-awaiting-original-response'); }
  async changeBinding(binding:string) {
    if(!binding)throw new Error('Verified account binding is required');
    const previous=this.binding;
    this.mode='observe';this.phase='account-changed';this.startedAt=null;this.latest=null;this.outputs=0;++this.generation;
    this.binding=binding;
    return this.refresh(previous);
  }
}
