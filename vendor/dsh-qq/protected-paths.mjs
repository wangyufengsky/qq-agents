// 运维 Agent（L1~L3）不得通过文件工具读取的桥接/DSH 机密文件。
//
// 为什么需要：Windows 上 DSH 沙箱不限制读，而这些文件里有能绕过管理通道的凭据 ——
//   · 桥接控制台令牌（state/console-token、config.json 的 consoleToken）：拿到它就能调控制台 API；
//   · TOTP 秘密（state/admin/totp.json）：拿到它就能自己算 L3 动态码；
//   · DSH 的会话签名密钥（~/.dsh/.credentials.yaml）：拿到它就能直连 DSH API 改权限。
// 这里只拦**文件类工具**（read / read_image / glob / grep 等）的路径参数；pwsh 命令无法可靠解析，
// 由审批闸门（qq-approval-gate.mjs）要求 owner 逐条审批，owner 能在审批消息里看到完整命令。
// 这是纵深防御，不是边界：L2/L3 本质上运行在 owner 的本机账户下。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function real(p) {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

// 本文件在 <仓库>/plugins/qq-agent-presets/ 下（DSH 通过 junction 引用，realpath 还原到仓库）。
const bundleDir = real(path.dirname(fileURLToPath(import.meta.url)))
const repoRoot = path.resolve(bundleDir, '..', '..')
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const norm = (p) => (process.platform === 'win32' ? String(p).replace(/\//g, '\\').toLowerCase() : String(p))

/** 受保护的绝对路径前缀（目录或文件）。 */
export const PROTECTED_PATHS = Object.freeze([
  path.join(repoRoot, 'state'),
  path.join(repoRoot, 'config.json'),
  path.join(dshHome, '.credentials.yaml'),
  path.join(dshHome, 'guard'),
])

/** 无论在哪个目录，出现这些文件名就拒绝（覆盖相对路径/通配的情况）。 */
const PROTECTED_BASENAMES = ['console-token', 'totp.json', 'control.json', 'audit.jsonl', '.credentials.yaml', 'sessions.json', 'people.json']

/** 判断一个路径/模式字符串是否指向受保护内容。 */
export function touchesProtected(value) {
  if (typeof value !== 'string' || !value) return false
  const v = norm(value)
  for (const p of PROTECTED_PATHS) {
    const pn = norm(p)
    if (v === pn || v.startsWith(pn + (process.platform === 'win32' ? '\\' : '/'))) return true
  }
  const base = v.split(/[\\/]/).pop() ?? ''
  if (PROTECTED_BASENAMES.some((b) => base === b || base.includes(b))) return true
  // 会话工作目录默认在 state/agents 下：任何向上跳出的相对路径都可能走到 state/ 的机密文件。
  if (/(^|[\\/])\.\.([\\/]|$)/.test(v)) return true
  // 通配模式里直接写 state/config 的
  if (/(^|[\\/*])state([\\/]|$)/.test(v) && /console|totp|admin|token/.test(v)) return true
  return false
}

/** 从工具参数里收集所有路径类字符串（file_path / path / paths / pattern / glob / cwd / workdir …）。 */
export function pathArgs(args) {
  let a = args
  if (typeof a === 'string') { try { a = JSON.parse(a) } catch { return [a] } }
  if (!a || typeof a !== 'object') return []
  const out = []
  for (const [k, val] of Object.entries(a)) {
    if (!/path|file|dir|cwd|pattern|glob|include|target|root/i.test(k)) continue
    if (typeof val === 'string') out.push(val)
    else if (Array.isArray(val)) out.push(...val.filter((x) => typeof x === 'string'))
  }
  return out
}

/** 文件工具调用是否触碰受保护内容。返回拒绝理由或 undefined。 */
export function protectedFileReason(exec) {
  const args = exec?.arguments ?? exec?.input ?? exec?.args
  for (const p of pathArgs(args)) {
    if (touchesProtected(p)) return `路径「${p}」属于桥接/DSH 的凭据或管理状态，运维 Agent 不允许通过文件工具访问`
  }
  return undefined
}
