import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';

export const defaultLock = path.join(os.homedir(),'.cache','qq-bridge','browser.lock');
/** Serialize OpenCLI across MCP processes. Never steal a lock from a live process. */
export async function withBrowserLock(action,{lockPath=process.env.SOCIAL_BROWSER_LOCK||defaultLock,
  timeoutMs=180000,pollMs=100,cooldownMs=3000,signal}={}) {
  await fs.mkdir(path.dirname(lockPath),{recursive:true,mode:0o700});
  const deadline=Date.now()+timeoutMs;
  for(;;) {
    signal?.throwIfAborted();
    try{await fs.mkdir(lockPath,{mode:0o700});break;}catch(error){if(error.code!=='EEXIST')throw error;}
    try {
      const owner=JSON.parse(await fs.readFile(path.join(lockPath,'owner.json'),'utf8'));
      if(Number.isInteger(owner.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(e){
        if(e.code==='ESRCH')throw new Error('BROWSER_LOCK_ORPHANED: 管理端确认无任务后清理锁');
      }
    }catch(error){if(error.message.startsWith('BROWSER_LOCK_ORPHANED'))throw error;}
    if(Date.now()>=deadline)throw new Error('BROWSER_QUEUE_TIMEOUT');
    await sleep(pollMs,undefined,{signal});
  }
  try {
    await fs.writeFile(path.join(lockPath,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now()}),{mode:0o600});
    signal?.throwIfAborted();return await action();
  }finally {
    // Keep a cooldown inside the lock so another process cannot navigate immediately.
    await sleep(cooldownMs);
    await fs.rm(lockPath,{recursive:true});
  }
}
