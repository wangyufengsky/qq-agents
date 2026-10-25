// Resolve proxy Fake-IP answers through HTTPS DNS, without using system DNS
// to bootstrap the resolver. Only the hostname is sent; never URLs or API keys.
import https from 'node:https';
import net from 'node:net';

const RESOLVER_HOST = 'cloudflare-dns.com';
const RESOLVER_IPS = ['1.1.1.1', '1.0.0.1'];
const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;

function queryOnce(hostname, type, address) {
  return new Promise((resolve, reject) => {
    let request, response, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const abort = (error) => {
      finish(error);
      request?.destroy();
      response?.destroy();
    };
    timer = setTimeout(() => abort(new Error('公网 DNS 查询超时')), TIMEOUT_MS);
    try {
      request = https.request({
        hostname: address,
        port: 443,
        servername: RESOLVER_HOST,
        rejectUnauthorized: true,
        method: 'GET',
        path: `/dns-query?${new URLSearchParams({ name: hostname, type })}`,
        headers: { host: RESOLVER_HOST, accept: 'application/dns-json' },
      }, (res) => {
        response = res;
        res.on('error', abort);
        res.on('aborted', () => abort(new Error('公网 DNS 响应中断')));
        res.on('close', () => {
          if (!res.complete) abort(new Error('公网 DNS 响应不完整'));
        });
        if (settled) { res.destroy(); return; }
        // No redirects: the resolver and its TLS identity are fixed.
        if (res.statusCode !== 200) {
          abort(new Error(`公网 DNS 返回 HTTP ${res.statusCode}`));
          return;
        }
        let bytes = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_BYTES) { abort(new Error('公网 DNS 响应过大')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (result.Status !== 0 || result.TC === true) {
              throw new Error('公网 DNS 查询未成功或响应被截断');
            }
            const expectedType = type === 'A' ? 1 : 28;
            if (!Array.isArray(result.Question) || !result.Question.some(q =>
              q.type === expectedType &&
              String(q.name).toLowerCase().replace(/\.$/, '') === hostname
            )) throw new Error('公网 DNS 响应与查询不匹配');
            if (result.Answer !== undefined && !Array.isArray(result.Answer)) {
              throw new Error('公网 DNS 应答格式错误');
            }
            const addresses = [];
            for (const answer of result.Answer ?? []) {
              if (answer.type !== 1 && answer.type !== 28) continue;
              const family = answer.type === 1 ? 4 : 6;
              if (net.isIP(answer.data) !== family) throw new Error('公网 DNS 返回非法地址');
              addresses.push({ address: answer.data, family });
            }
            finish(null, addresses);
          } catch (error) { finish(error); }
        });
      });
      request.on('error', abort);
      request.end();
    } catch (error) { abort(error); }
  });
}

async function query(hostname, type) {
  let lastError;
  for (const ip of RESOLVER_IPS) {
    try { return await queryOnce(hostname, type, ip); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function resolvePublicDns(hostname) {
  // Both address families must be checked; a failed family must not be ignored.
  const results = await Promise.all([query(hostname, 'A'), query(hostname, 'AAAA')]);
  const unique = new Map(results.flat().map(item => [item.address, item]));
  if (!unique.size) throw new Error('公网 DNS 没有返回地址');
  return [...unique.values()];
}
