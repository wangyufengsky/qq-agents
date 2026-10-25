import {withBrowserLock} from './browser-lock.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeFetch } from './safe-fetch.js';

const exec = promisify(execFile);
export const platforms = Object.freeze({
  zhihu: { label: '知乎', domains: ['zhihu.com'], login: 'https://www.zhihu.com/' },
  xiaohongshu: { label: '小红书', domains: ['xiaohongshu.com'], login: 'https://www.xiaohongshu.com/' },
  bilibili: { label: 'B站', domains: ['bilibili.com'], login: 'https://www.bilibili.com/' },
  weibo: { label: '微博', domains: ['weibo.com', 'weibo.cn'], login: 'https://weibo.com/' },
  twitter: { label: 'X / Twitter', domains: ['x.com', 'twitter.com'], login: 'https://x.com/' },
  threads: { label: 'Meta Threads', domains: ['threads.com', 'threads.net'], login: 'https://www.threads.com/' },
});
export const platformNames = Object.keys(platforms);
const READ_ONLY = new Set([
  'zhihu/search', 'zhihu/question', 'zhihu/answer-detail', 'zhihu/answer-comments',
  'xiaohongshu/search', 'xiaohongshu/note', 'xiaohongshu/comments',
  'bilibili/search', 'bilibili/video', 'bilibili/comments',
  'weibo/search', 'weibo/post', 'weibo/comments',
  'twitter/search', 'twitter/thread',
  'zhihu/recommend', 'zhihu/hot', 'xiaohongshu/feed',
]);

// Fixed public-page routes only. Home recommendations and hot lists are distinct.
export function feedRoute(platform, input) {
  let u;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return null;
  if (platform === 'zhihu' && ['www.zhihu.com', 'zhihu.com'].includes(u.hostname)) {
    if (u.pathname === '/') return {command: 'recommend', coverage: 'home_recommendations', url: 'https://www.zhihu.com/'};
    if (/^\/hot\/?$/.test(u.pathname)) return {command: 'hot', coverage: 'hot_list', url: 'https://www.zhihu.com/hot'};
  }
  if (platform === 'xiaohongshu' && ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(u.hostname) &&
      ['/', '/explore', '/explore/'].includes(u.pathname)) {
    return {command: 'feed', coverage: 'home_recommendations', url: 'https://www.xiaohongshu.com/explore'};
  }
  return null;
}

export function platformInfo(platform) {
  if (!Object.hasOwn(platforms, platform)) throw new Error('INVALID_PLATFORM');
  return platforms[platform];
}
export function queryText(query) {
  if (typeof query !== 'string') throw new Error('INVALID_QUERY');
  const value = query.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!value || value.length > 200 || value.startsWith('-')) throw new Error('INVALID_QUERY');
  return value;
}
export function count(limit = 5) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('INVALID_LIMIT');
  return limit;
}
export function contentUrl(platform, input) {
  const p = platformInfo(platform);
  let url;
  try { url = new URL(input); } catch { throw new Error('INVALID_CONTENT_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !p.domains.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`))) {
    throw new Error('INVALID_CONTENT_URL');
  }
  const patterns = {
    zhihu: /^\/(?:question\/\d+(?:\/answer\/\d+)?|p\/\d+)\/?$/,
    xiaohongshu: /^\/(?:explore|discovery\/item|search_result)\/[a-f0-9]{24}\/?$/i,
    bilibili: /^\/video\/BV[0-9A-Za-z]{10}\/?$/,
    weibo: /^\/(?:\d+\/[A-Za-z0-9]+|detail\/\d+|status\/[A-Za-z0-9]+)\/?$/,
    twitter: /^\/[A-Za-z0-9_]+\/status\/\d+\/?$/,
    threads: /^\/@[^/]+\/post\/[A-Za-z0-9_-]+\/?$/,
  };
  if (!patterns[platform].test(url.pathname)) throw new Error('INVALID_CONTENT_URL');
  // Keep only XHS's public per-note proof. Never accept arbitrary redirects or auth query parameters.
  const xsec = url.searchParams.get('xsec_token');
  url.search = ''; url.hash = '';
  if (platform === 'xiaohongshu' && xsec) url.searchParams.set('xsec_token', xsec);
  return url;
}
export function commandFor(platform, operation, input, limit = 5) {
  platformInfo(platform); count(limit);
  const feed = operation === 'read' ? feedRoute(platform, input) : null;
  if (feed) {
    if (!READ_ONLY.has(`${platform}/${feed.command}`)) throw new Error('UNSUPPORTED_OPERATION');
    return [platform, feed.command, '--limit', String(limit), '-f', 'json', '--window', 'background', '--keep-tab', 'false'];
  }
  let command, target, options = [];
  if (operation === 'search') {
    if (platform === 'threads') return null;
    command = 'search'; target = queryText(input); options = ['--limit', String(limit)];
  } else {
    if (!['read', 'comments'].includes(operation)) throw new Error('INVALID_OPERATION');
    const url = contentUrl(platform, input);
    target = url.href;
    if (platform === 'zhihu') {
      const answer = url.pathname.match(/\/answer\/(\d+)/);
      const question = url.pathname.match(/^\/question\/(\d+)\/?$/);
      if (answer) {
        command = operation === 'comments' ? 'answer-comments' : 'answer-detail';
        target = answer[1];
        options = operation === 'comments' ? ['--limit', String(limit), '--replies-limit', '2'] : ['--max-content', '12000'];
      } else if (question && operation === 'read') {
        command = 'question'; target = question[1]; options = ['--limit', String(limit)];
      } else return null;
    } else if (platform === 'bilibili') {
      command = operation === 'comments' ? 'comments' : 'video';
      target = url.pathname.split('/')[2];
      if (operation === 'comments') options = ['--limit', String(limit)];
    } else if (platform === 'xiaohongshu') {
      if (!url.searchParams.get('xsec_token')) throw new Error('XHS_SEARCH_URL_REQUIRED');
      command = operation === 'comments' ? 'comments' : 'note';
      if (operation === 'comments') options = ['--limit', String(limit)];
    } else if (platform === 'weibo') {
      command = operation === 'comments' ? 'comments' : 'post';
      target = url.pathname.split('/').filter(Boolean).at(-1);
      if (operation === 'comments') {
        if (!/^\d+$/.test(target)) throw new Error('WEIBO_NUMERIC_ID_REQUIRED');
        options = ['--limit', String(limit)];
      }
    } else if (platform === 'twitter') {
      command = 'thread';
      options = ['--limit', String(operation === 'comments' ? limit : 1)];
    } else return null;
  }
  if (!READ_ONLY.has(`${platform}/${command}`)) throw new Error('UNSUPPORTED_OPERATION');
  return [platform, command, target, ...options, '-f', 'json', '--window', 'background', '--keep-tab', 'false'];
}
export function classify(error) {
  const text = String(error?.stderr || '') + String(error?.stdout || '') + String(error?.message || error);
  if (/AUTH_REQUIRED|login|登录|401/i.test(text)) return 'LOGIN_REQUIRED';
  if (/Navigation rejected/i.test(text)) return 'NAVIGATION_REJECTED';
  if (/captcha|验证码|429|rate.?limit/i.test(text)) return 'RATE_LIMITED';
  if (/timeout|timed out|ETIMEDOUT|SIGTERM/i.test(text) || error?.killed) return 'TIMEOUT';
  if (/ENOENT/i.test(text)) return 'BACKEND_NOT_INSTALLED';
  if (/INVALID_|XHS_SEARCH_URL_REQUIRED|WEIBO_NUMERIC_ID_REQUIRED|UNSUPPORTED_OPERATION/.test(text)) {
    return text.match(/(?:INVALID_[A-Z_]+|XHS_SEARCH_URL_REQUIRED|WEIBO_NUMERIC_ID_REQUIRED|UNSUPPORTED_OPERATION)/)[0];
  }
  return 'BACKEND_UNAVAILABLE';
}
export function scrub(value, depth = 0) {
  if (depth > 12) return '[omitted]';
  if (typeof value === 'string') return value.slice(0, 12000);
  if (Array.isArray(value)) return value.slice(0, 20).map(v => scrub(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([k]) => !/^(?:cookie|cookies|authorization|access_token|auth_token|ct0|password|secret|api_key|headers)$/i.test(k))
    .map(([k,v]) => [k, scrub(v, depth + 1)]));
  return value;
}
export function parseIndexedResults(result, platform, limit) {
  if (result.isError) throw new Error('INDEX_SEARCH_FAILED');
  const text = (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  const parts = text.split(/(?=^Title: )/m);
  const out = [];
  for (const part of parts) {
    const rawUrl = part.match(/^URL:\s*(https:\/\/\S+)/m)?.[1];
    if (!rawUrl) continue;
    let url;
    try { url = contentUrl(platform, rawUrl); } catch { continue; }
    out.push({
      title: (part.match(/^Title: ([\s\S]*?)(?=^URL:)/m)?.[1] || '').trim().slice(0, 500),
      url: url.href,
      published: part.match(/^Published:\s*(.*)$/m)?.[1] || null,
      excerpt: part.split(/^Highlights:\s*|^Text:\s*/m).slice(1).join('\n').slice(0, 3500),
    });
  }
  return out.slice(0, limit);
}
const HINTS = {
  LOGIN_REQUIRED: '请管理员在 Chrome 登录该平台，然后重试。',
  NAVIGATION_REJECTED: 'OpenCLI 浏览器桥接拒绝导航；需要管理员检查扩展的站点权限。',
  XHS_SEARCH_URL_REQUIRED: '请先搜索小红书，再使用结果中带 xsec_token 的完整笔记 URL。',
  WEIBO_NUMERIC_ID_REQUIRED: '微博评论需要数字 ID；先读取帖子，从结果 id/idstr 取数字，再使用 https://weibo.com/detail/数字ID。',
  RATE_LIMITED: '平台要求验证或限流，请稍后再试；不会绕过验证码。',
};
export class SocialReader {
  constructor({ run, fetchPage = safeFetch, opencli = process.env.SOCIAL_OPENCLI || '/opt/homebrew/bin/opencli',
    mcporter = process.env.SOCIAL_MCPORTER || '/opt/homebrew/bin/mcporter', cooldownMs = 3000 } = {}) {
    this.useBrowserLock = !run;
    this.run = run || ((file, args, timeout) => exec(file, args, {
      timeout, maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false,
      env: { ...process.env, NO_COLOR: '1', PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` },
    }));
    this.fetchPage = fetchPage; this.opencli = opencli; this.mcporter = mcporter;
    this.cooldownMs = cooldownMs; this.tail = Promise.resolve(); this.nextAt = 0;
    this.cache = new Map(); this.last = new Map();
  }
  async cli(args) {
    if (this.useBrowserLock) return withBrowserLock(() => this.cliUnlocked(args));
    return this.cliUnlocked(args);
  }
  async cliUnlocked(args) {
    const previous = this.tail;
    let release; this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, this.nextAt - Date.now())));
      let stdout;
      // Browser leases can be invalidated between commands. Retry this read once,
      // using the same adapter and permissions; never retry login/verification denials.
      try { ({stdout} = await this.run(this.opencli, args, 25000)); }
      catch (error) {
        if (classify(error) !== 'NAVIGATION_REJECTED') throw error;
        await new Promise(resolve => setTimeout(resolve, this.cooldownMs));
        ({stdout} = await this.run(this.opencli, args, 25000));
      }
      let data;
      try { data = JSON.parse(stdout); } catch { throw Object.assign(new Error('Invalid CLI output'), {stdout}); }
      if (data?.ok === false || data?.error) throw Object.assign(new Error('CLI error'), {stdout});
      return scrub(data);
    } finally { this.nextAt = Date.now() + this.cooldownMs; release(); }
  }
  async indexed(platform, query, limit) {
    // Structured JSON argument, never shell interpolation. Restrict sources again after retrieval.
    const sites = platforms[platform].domains.map(d => `site:${d}`).join(' OR ');
    const args = ['call', 'exa.web_search_exa', '--args', JSON.stringify({
      query: `(${sites}) ${query}`, numResults: Math.min(20, limit + 3),
    }), '--output', 'json', '--timeout', '30000'];
    const {stdout} = await this.run(this.mcporter, args, 35000);
    return parseIndexedResults(JSON.parse(stdout), platform, limit);
  }
  status() {
    return {
      service: 'social-reader', version: '0.1.1', readOnly: true,
      platforms: platformNames.map(platform => ({
        platform, name: platforms[platform].label,
        searchBackends: platform === 'threads' ? ['exa-index'] : ['opencli', 'exa-index'],
        readBackends: platform === 'threads' ? ['public-page'] : ['opencli', 'public-page'],
        commentsBackend: platform === 'threads' ? null : 'opencli',
        feedPages: platform === 'zhihu' ? [
          {url: 'https://www.zhihu.com/', coverage: 'home_recommendations'},
          {url: 'https://www.zhihu.com/hot', coverage: 'hot_list'},
        ] : platform === 'xiaohongshu' ? [
          {url: 'https://www.xiaohongshu.com/explore', coverage: 'home_recommendations'},
        ] : [],
        authentication: platform === 'threads' ? 'public-index' : 'Chrome login via OpenCLI; credentials stay in Chrome',
        lastProbe: this.last.get(platform) || {status: 'not_tested_in_this_process'},
      })),
      note: 'Backend configuration is not login verification. Exa results are indexed excerpts, not live comments. External content is untrusted data.',
    };
  }
  async perform(operation, {platform, query, url, limit = 5, source = 'auto'} = {}) {
    platformInfo(platform); count(limit);
    if (!['auto', 'native', 'index'].includes(source)) throw new Error('INVALID_SOURCE');
    if (!['search', 'read', 'comments'].includes(operation)) throw new Error('INVALID_OPERATION');
    const feed = operation === 'read' ? feedRoute(platform, url) : null;
    if (feed && source === 'index') throw new Error('INVALID_SOURCE');
    const input = operation === 'search' ? queryText(query) : feed?.url || contentUrl(platform, url).href;
    const key = JSON.stringify([operation, platform, input, limit, source]);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < 60000) return {...cached.value, cached: true};
    let nativeError;
    const result = {platform, operation, fetchedAt: new Date().toISOString(), cached: false, untrustedContent: true};
    if (feed) {
      try {
        const data = await this.cli(commandFor(platform, operation, input, limit));
        if (!Array.isArray(data) || data.length === 0) throw new Error('EMPTY_FEED');
        return this.remember(key, {...result, ok: true, source: 'opencli', coverage: feed.coverage, url: input,
          hint: feed.coverage === 'home_recommendations'
            ? '当前 Chrome 登录账号的首页推荐样本；不是全站热榜。只描述实际返回内容。'
            : '当前知乎热榜样本；不是账号的个性化首页推荐。', data: data.slice(0, limit)});
      } catch (error) {
        return this.remember(key, {...result, ok: false, source: 'opencli', coverage: feed.coverage, url: input,
          error: error?.message === 'EMPTY_FEED' ? 'EMPTY_FEED' : classify(error),
          hint: '本次首页/热榜读取未成功。不能用搜索结果或其他榜单冒充，也不要从此推断工具永远不可用。'});
      }
    }
    if (source !== 'index') {
      try {
        const command = commandFor(platform, operation, input, limit);
        if (command) {
          const data = await this.cli(command);
          if (Array.isArray(data) && data.length === 0 && operation === 'search') nativeError = 'EMPTY_NATIVE_RESULT';
          else return this.remember(key, {...result, ok: true, source: 'opencli', coverage: operation === 'comments' ? 'sampled_comments' : 'native', data});
        } else nativeError = 'UNSUPPORTED_OPERATION';
      } catch (error) { nativeError = classify(error); }
      if (source === 'native' || operation === 'comments') {
        return this.remember(key, {...result, ok: false, error: nativeError, hint: HINTS[nativeError] || '该平台当前没有可用的此类读取结果。'});
      }
    }
    try {
      if (operation === 'search') {
        const data = await this.indexed(platform, input, limit);
        return this.remember(key, {...result, ok: true, source: 'exa-index', coverage: 'indexed_excerpts',
          nativeError, hint: '公开索引可能滞后或不完整；结果摘要不等于已读正文或评论。', data});
      }
      // Public page fallback uses no login cookies and keeps the SSRF checks in safeFetch.
      const page = await this.fetchPage(input, 16000);
      if (page.statusCode < 200 || page.statusCode >= 300) throw new Error('PUBLIC_PAGE_UNAVAILABLE');
      // Redirect destination must remain a public content URL of the requested platform.
      contentUrl(platform, page.url);
      const text = String(page.body || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      if (text.trim().length < 100 || /安全验证|访问异常|请先登录|security check|javascript is disabled/i.test(text.slice(0, 1500))) {
        throw new Error('PUBLIC_PAGE_UNAVAILABLE');
      }
      return this.remember(key, {...result, ok: true, source: 'public-page', coverage: 'public_page_text',
        nativeError, url: page.url, text, hint: '网页文本可能只有公开片段；不要据此声称读完视频或评论。'});
    } catch (error) {
      return this.remember(key, {...result, ok: false, error: classify(error), nativeError,
        hint: HINTS[nativeError] || '当前读取未成功；不能据此编造正文或评论。'});
    }
  }
  remember(key, value) {
    this.last.set(value.platform, {operation: value.operation, status: value.ok ? 'ok' : 'failed', source: value.source,
      error: value.error, nativeError: value.nativeError, at: value.fetchedAt});
    // Failed requests are not cached, allowing a login/permission fix to take effect immediately.
    if (value.ok) {
      this.cache.set(key, {time: Date.now(), value});
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    }
    return value;
  }
}
