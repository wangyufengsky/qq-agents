/** One coordinator per manager; both bridge instances consult it before accepting group input. */
export class BanterCoordinator {
  constructor({botIds=[],maxMessages=6,cooldownMs=60000,clock=Date.now}={}) {
    this.botIds=new Set(botIds.map(String));this.maxMessages=maxMessages;this.cooldownMs=cooldownMs;
    this.clock=clock;this.groups=new Map();this.paused=false;
  }
  observe({groupId,messageId,senderId}) {
    if(!groupId||messageId==null||!senderId)throw new Error('INVALID_EVENT_IDENTITY');
    const key=String(groupId);let s=this.groups.get(key);
    if(!s){s={count:0,until:0,seen:new Map()};this.groups.set(key,s);}
    const id=`${senderId}:${messageId}`;
    if(s.seen.has(id))return {allow:!this.paused&&s.seen.get(id),duplicate:true};
    const now=this.clock();let allow=true;
    if(!this.botIds.has(String(senderId))){s.count=0;s.until=0;}
    else if(now<s.until)allow=false;
    else{
      if(s.until){s.count=0;s.until=0;}
      if(s.count>=this.maxMessages){s.until=now+this.cooldownMs;allow=false;}else s.count++;
    }
    s.seen.set(id,allow);if(s.seen.size>1000)s.seen.delete(s.seen.keys().next().value);
    if(this.groups.size>1000)this.groups.delete(this.groups.keys().next().value);
    return {allow:!this.paused&&allow,peer:this.botIds.has(String(senderId)),count:s.count,cooldownUntil:s.until};
  }
}
