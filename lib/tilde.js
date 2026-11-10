// ~ 展开：让 Windows 远程也能用 `~`（家目录）。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
//
// Windows 上的 SSH 默认 shell 是 cmd.exe（也可能是 PowerShell），而：
//
//     echo ~            →  cmd.exe 原样回显 `~`（它不展开波浪号）
//     echo %USERPROFILE% →  cmd.exe 展开成 `C:\Users\me`
//     echo $env:USERPROFILE → PowerShell 展开成 `C:\Users\me`
//
// 旧实现只问了一次 `echo ~`，并把输出直接当家目录，于是
// `/dsh-remote/home` 在 Windows 上返回 `{"ok":true,"home":"~"}`——**看起来
// 成功、实际不可用**；而 `normalizeRemotePath('~')` 又会把它当成 POSIX 的
// 相对段处理，落成 `/~`（Windows 上一律打不开）。表现就是选择器里的
// 「~ 主目录」按钮填进去一个 `~`，然后一切都找不到。
//
// ── 这个文件解决两件事（刻意分开）──────────────────────────────────────────
//
//   1. 探测：按 shell 家族依次试命令，取**第一个看起来是绝对路径**的输出。
//      未展开的占位符（`%USERPROFILE%`、`$env:USERPROFILE`）不算绝对路径，
//      所以在 POSIX 上试 cmd 那条命令也不会误命中。
//   2. 展开：纯函数，把 `~` / `~/x` / `~\x` 换成真实家目录；分隔符跟随家
//      目录自身的风格（Windows 家目录用 `\`）。
//
// 探测要过 SSH（异步），而路径归一化是同步的，所以家目录结果会进一个
// **进程内缓存**：连接成功时、调用 `/home` 时都会写入它；同步的路径展开
// 从缓存里读，缓存冷时才回落到旧行为。

/** 该路径是否以 `~` 开头（需要展开）。 */
export function isTildePath(p) {
  const s = String(p === null || p === undefined ? '' : p).trim()
  return s === '~' || s.startsWith('~/') || s.startsWith('~\\')
}

/**
 * 输出是否像一个**绝对路径**：
 *   · Windows 盘符   `C:\Users\me`、`C:/Users/me`
 *   · Windows UNC    `\\server\share`
 *   · POSIX           `/home/me`
 *
 * 未展开的占位符（`%USERPROFILE%`、`$env:USERPROFILE`、字面 `~`）都不算。
 */
export function looksAbsoluteRemotePath(v) {
  const s = String(v === null || v === undefined ? '' : v).trim()
  if (!s) return false
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true
  if (/^\\\\[^\\]+\\[^\\]+/.test(s)) return true
  if (s.startsWith('/')) return true
  return false
}

/**
 * 把 `~` 前缀展开成真实家目录。
 * home 为空（家目录没解析出来）时**原样返回**——调用方据此提示用户改用
 * 绝对路径，而不是把 `~` 当成相对目录默默拼到工作区后面。
 */
export function expandTildePath(p, home) {
  const s = String(p === null || p === undefined ? '' : p).trim()
  if (!isTildePath(s)) return s
  const h = String(home === null || home === undefined ? '' : home).trim()
  if (!h) return s
  const rest = s.slice(1).replace(/^[/\\]+/, '')
  // 家目录末尾的分隔符不重复出现：`C:\Users\me\` → `C:\Users\me`。
  // POSIX 根目录 `/` 是例外——剥掉就没有家目录了，所以保留它。
  const base = h.replace(/[\\/]+$/, '') || (h.startsWith('/') ? '/' : h)
  if (!rest) return base
  const sep = h.includes('\\') ? '\\' : '/'
  return h.replace(/[\\/]+$/, '') + sep + rest.replace(/[\\/]+/g, sep)
}

/**
 * 家目录探测命令，按"最可能命中"排序。每条命令对**一种** shell 有效，
 * 其余 shell 会原样回显占位符（被 `looksAbsoluteRemotePath` 挡掉）。
 *
 * 顺序说明：
 *   1. `echo ~`                    POSIX shell（最常见，先问它）
 *   2. `echo %USERPROFILE%`        cmd.exe
 *   3. `echo $env:USERPROFILE`     PowerShell
 *   4. `powershell -NoProfile ...`  从 cmd.exe 再叫一次 PowerShell
 *   5. `echo %HOMEDRIVE%%HOMEPATH%` cmd.exe 兜底（USERPROFILE 缺失时）
 */
export const HOME_PROBE_COMMANDS = [
  'echo ~',
  'echo %USERPROFILE%',
  'echo $env:USERPROFILE',
  'powershell -NoProfile -Command "echo $env:USERPROFILE"',
  'echo %HOMEDRIVE%%HOMEPATH%',
]

/**
 * 从探测结果里挑出第一个像绝对路径的输出。
 *
 * @param {Array<{cmd?: string, stdout?: string, stderr?: string}>} results
 * @returns {string} 命中的家目录；没有则空串
 */
export function pickHomeFrom(results) {
  for (const r of Array.isArray(results) ? results : []) {
    const out = String((r && r.stdout) || '').trim()
    if (looksAbsoluteRemotePath(out)) return out
  }
  return ''
}

/** 缓存键：同一台机器（同 host/port/user）共用一条家目录记录。 */
export function homeKeyFor(host, port, username) {
  return `${host || ''}:${Number(port) || 22}:${username || ''}`
}

// ── 进程内家目录缓存（同步可读）────────────────────────────────────────────
// 探测是异步的，路径归一化是同步的：这个缓存是两者之间的桥。写入点在
// 连接成功与 `/home` 调用处；读取点在路径展开处。

const homeCache = new Map()

/** 记录某台机器的家目录。 */
export function cacheHome(key, home) {
  if (!key) return
  homeCache.set(key, String(home || ''))
}

/** 读某台机器的家目录（未探测过则空串）。 */
export function cachedHome(key) {
  if (!key) return ''
  return homeCache.get(key) || ''
}

/** 清掉缓存（换机器、连接失败等场景）。 */
export function forgetHome(key) {
  if (!key) return
  homeCache.delete(key)
}
