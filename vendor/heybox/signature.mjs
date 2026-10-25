// Port of shadowfish07/heybox-cli internal/api/signer.go (MIT; see LICENSE).
// Protocol compatibility only; this is not password encryption.
import {createHash,randomBytes} from 'node:crypto';
const alphabet='JKMNPQRTX1234OABCDFG56789H';
const md5=s=>createHash('md5').update(String(s)).digest('hex');
const digits=s=>s.replace(/[^0-9]/g,'');
const e=x=>x&128?((x<<1)^27)&255:(x<<1)&255;
const z=x=>e(x)^x,j=x=>z(e(x)),aa=x=>j(z(e(x))),o=x=>aa(x)^j(x)^z(x);
export function sign(path,timestamp,nonce){
 const canonical='/'+path.split('/').filter(Boolean).join('/')+'/';
 let n=Number(digits(md5(String(timestamp+1)+canonical+md5(digits(nonce+alphabet)))).slice(0,9).padEnd(9,'0'));
 let encoded='';for(let i=0;i<5;i++){encoded+=alphabet[n%alphabet.length];n=Math.floor(n/alphabet.length)}
 const [a,b,c,d]=[...encoded.slice(-4)].map(x=>x.charCodeAt(0));
 const mixed=[o(a)^aa(b)^j(c)^z(d),z(a)^o(b)^aa(c)^j(d),j(a)^z(b)^o(c)^aa(d),aa(a)^j(b)^z(c)^o(d)];
 return encoded+String(mixed.reduce((a,b)=>a+b,0)%100).padStart(2,'0');
}
export function signature(path){const timestamp=Math.floor(Date.now()/1000),nonce=md5(timestamp+randomBytes(16).toString('hex')).toUpperCase();return {hkey:sign(path,timestamp,nonce),nonce,_time:String(timestamp)}}
