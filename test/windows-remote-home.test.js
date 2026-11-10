// 路由级回归：Windows 远程的 `/dsh-remote/home` 必须返回**真实家目录**。
//
// 这条能力存在的原因是一条真实故障：cmd.exe 不展开波浪号，`echo ~` 原样
// 回显 `~`，而旧实现把这段输出直接当家目录，于是接口答
// `{"ok":true,"home":"~"}`——**看起来成功、实际不可用**。用户在选择器里点
// 「~ 主目录」，拿到的还是一个 `~`，于是任何路径都打不开。
//
// 这里不打桩 pool，而是用一个**假的 ssh 可执行文件**（openssh 后端真的
// spawn 它），让它按 cmd.exe 的行为应答：`cmd /c ver` 报 Windows、
// `echo ~` 回显 `~`、`echo %USERPROFILE%` 给出 `C:\Users\laiyi`。
// 于是被测的是真实的路由 + 真实的 pool + 真实的探测顺序。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CONFIG = {
  host: 'winbox', port: 22, username: 'laiyi', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 5000, connectTimeoutMs: 2000,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
  backend: 'openssh',
}

/** 一个按 Windows cmd.exe 行为应答的假 ssh。 */
function fakeWindowsSsh(dir) {
  const script = path.join(dir, 'fake-ssh')
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    '# 最后一个参数就是远端要执行的命令（openssh 后端: ssh [opts] -- dest <cmd>）',
    'cmd="${@: -1}"',
    'case "$cmd" in',
    '  *"cmd /c ver"*) echo "Microsoft Windows [Version 10.0.26100.9278]" ;;',
    // cmd.exe 不展开波浪号：原样回显
    "  *'echo ~'*)      echo '~' ;;",
    '  *USERPROFILE*)   echo "C:\\Users\\laiyi" ;;',
    '  *HOMEDRIVE*)     echo "C:\\Users\\laiyi" ;;',
    '  *)               echo "" ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(script, 0o755)
  return script
}

/** 一个按 POSIX 行为应答的假 ssh。 */
function fakePosixSsh(dir) {
  const script = path.join(dir, 'fake-ssh-posix')
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'cmd="${@: -1}"',
    'case "$cmd" in',
    '  *"cmd /c ver"*) exit 127 ;;', // POSIX 上没有 cmd
    "  *'echo ~'*)      echo '/home/laiyi' ;;",
    '  *)               echo "" ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(script, 0o755)
  return script
}

function makeCtx() {
  const routes = new Map()
  const ctx = {
    effect: () => {},
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    get: (k) => {
      if (k === 'webServer') return { register: (r) => { routes.set(r.path, r); return () => {} } }
      return undefined
    },
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes }
}

async function loadPlugin(home, sshBinary) {
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?tilde-home=${Math.random()}`)
  const { ctx, routes } = makeCtx()
  await mod.apply(ctx, { ...CONFIG, sshBinary })
  return { routes }
}

async function call(routes, routePath, { method = 'GET', url, body } = {}) {
  const route = routes.get(routePath)
  assert.ok(route, `route ${routePath} must be registered`)
  const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req = Readable.from([Buffer.from(payload)])
  req.method = method
  req.url = url || routePath
  const res = {
    statusCode: 0,
    headers: {},
    payload: '',
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  let rejected = null
  await route.handler(req, res).catch((e) => { rejected = e })
  let json = null
  try { json = JSON.parse(res.payload) } catch { /* not JSON */ }
  return { status: res.statusCode, json, rejected, raw: res.payload }
}

test('Windows 远程：/home 返回真实家目录，而不是字面量 "~"', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-home-win-'))
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-bin-'))
  try {
    const { routes } = await loadPlugin(home, fakeWindowsSsh(dir))
    const r = await call(routes, '/dsh-remote/home', { method: 'POST', body: {} })
    assert.equal(r.rejected, null)
    assert.equal(r.status, 200)
    // 关键断言：不是 "~"，也不是 null
    assert.notEqual(r.json.home, '~', 'home must not be the literal tilde on Windows remotes')
    assert.equal(r.json.home, 'C:\\Users\\laiyi')
    assert.equal(r.json.ok, true)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POSIX 远程：/home 仍然返回 POSIX 家目录（没有回归）', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-home-posix-'))
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-bin-'))
  try {
    const { routes } = await loadPlugin(home, fakePosixSsh(dir))
    const r = await call(routes, '/dsh-remote/home', { method: 'POST', body: {} })
    assert.equal(r.rejected, null)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.home, '/home/laiyi')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
