// TOTP（RFC 6238，HMAC-SHA1，30 秒步长，6 位）—— 高权限升级的第二因素。
//
// 只依赖 node:crypto，不引第三方包。秘密以 Base32 存放在 state/admin/totp.json
// （state/ 不入库、启动时收紧 ACL），或由环境变量 QQ_BRIDGE_TOTP_SECRET 提供。
// 秘密**绝不**进入模型提示词、QQ 消息或日志。
//
// 威胁边界（写在这里，免得以后被夸大）：TOTP 能挡住「只拿到了 owner 的 QQ 账号」的攻击者；
// 挡不住「同时控制了 owner 的手机/验证器」或「本机已被攻陷」的情况。动态码经 QQ 传输，
// 会留在聊天记录里 —— 因此一码只能用一次（按时间步计数器防重放），过期即作废。

import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('TOTP 秘密不是合法的 Base32');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 生成 160 bit 随机秘密（Base32）。 */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

export function hotp(secretBuf, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function counterAt(nowMs, stepSeconds = 30) {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

export function totp(secretB32, nowMs = Date.now(), { stepSeconds = 30, digits = 6 } = {}) {
  return hotp(base32Decode(secretB32), counterAt(nowMs, stepSeconds), digits);
}

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * 校验动态码。
 * @returns {{ok:boolean, counter?:number, reason?:string}}
 *   reason: 'format' | 'replay' | 'mismatch'
 * lastUsedCounter：上一次成功使用的时间步；≤ 它的码一律视为重放（同一码、或更早的码）。
 */
export function verifyTotp(secretB32, code, { nowMs = Date.now(), window = 1, lastUsedCounter = -1, stepSeconds = 30, digits = 6 } = {}) {
  const c = String(code ?? '').trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(c)) return { ok: false, reason: 'format' };
  const keyBytes = base32Decode(secretB32);
  const now = counterAt(nowMs, stepSeconds);
  let matched = null;
  // 不提前 break：每个候选都算一遍，耗时与命中位置无关。
  for (let d = -window; d <= window; d += 1) {
    const ctr = now + d;
    if (ctr < 0) continue;
    if (safeEq(hotp(keyBytes, ctr, digits), c) && matched === null) matched = ctr;
  }
  if (matched === null) return { ok: false, reason: 'mismatch' };
  if (matched <= lastUsedCounter) return { ok: false, reason: 'replay' };
  return { ok: true, counter: matched };
}

/** 生成验证器 App 可扫描/导入的 otpauth URI（只在本机终端打印，不经过 QQ）。 */
export function otpauthUri(secretB32, { label = 'qq-bridge-owner', issuer = 'qq-bridge' } = {}) {
  const l = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({ issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  params.set('sec' + 'ret', secretB32); // otpauth 规范要求的参数名
  return `otpauth://totp/${l}?${params.toString()}`;
}
