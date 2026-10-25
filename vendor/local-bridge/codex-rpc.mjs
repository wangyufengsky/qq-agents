import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {EventEmitter} from 'node:events';

/** Own one stdio app-server. Requests with uncertain outcomes are never replayed. */
export class CodexRpc extends EventEmitter {
  constructor({command = 'codex', args = ['app-server', '--stdio'], env = process.env, cwd,
    spawnProcess = spawn, timeoutMs = 30000} = {}) {
    super(); Object.assign(this, {command,args,env,cwd,spawnProcess,timeoutMs});
    this.pending = new Map(); this.sequence = 0; this.child = null;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.initialize().catch(error => { this.close(); throw error; });
    return this.starting;
  }
  async initialize() {
    const child = this.spawnProcess(this.command,this.args,{env:this.env,cwd:this.cwd,stdio:['pipe','pipe','pipe']});
    this.child = child;
    // Diagnostics may contain paths or credentials: do not forward stderr into QQ.
    child.stderr?.on('data',()=>{});
    child.on('error',error=>this.fail(error));
    child.on('exit',()=>this.fail(new Error('CODEX_PROCESS_EXITED')));
    this.lines = createInterface({input:child.stdout});
    this.lines.on('line',line=>{
      let message; try { message=JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const item=this.pending.get(message.id); if(!item)return;
        this.pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error.message || 'CODEX_RPC_ERROR')) : item.resolve(message.result);
      } else if (message.method && message.id !== undefined) this.emit('request',message);
      else if(message.method) this.emit('notification',message);
    });
    const result=await this.request('initialize',{clientInfo:{name:'qq_bridge_codex',title:'QQ Bridge',version:'0.3.0'},
      capabilities:{experimentalApi:true}});
    this.write({method:'initialized',params:{}});
    return result;
  }
  write(message) {
    if(!this.child?.stdin?.writable)throw new Error('CODEX_NOT_CONNECTED');
    this.child.stdin.write(JSON.stringify(message)+'\n');
  }
  request(method,params={},timeoutMs=this.timeoutMs) {
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CODEX_RECEIPT_UNKNOWN:${method}`));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  respond(id,result) { this.write({id,result}); }
  reject(id) { this.write({id,error:{code:-32601,message:'Tool or approval request is not enabled for QQ'}}); }
  fail(error) {
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}
    this.pending.clear(); this.child=null; this.starting=null; this.emit('disconnected',error);
  }
  close() { const child=this.child; this.child=null; child?.kill('SIGTERM'); this.lines?.close(); this.fail(new Error('CODEX_CLOSED')); }
}
