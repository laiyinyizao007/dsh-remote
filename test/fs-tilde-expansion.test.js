// `/dsh-remote/ls` 必须在碰 SFTP **之前**把 `~` 展开成真实家目录。
//
// 为什么这条要单独钉：Windows 远程上 `~` 不是家目录（cmd.exe 原样回显
// `~`），而 `normalizeRemotePath('~')` 会把它当成 POSIX 的相对段，落成
// `/~`——一个看起来合法、实际打不开的路径。于是用户在选择器里敲 `~`，
// 远端报的是"路径不存在"，而不是"这个路径写法不对"。
//
// 这里的断言点在**交给 SFTP 的那个路径**上：展开对了，`readdir` 收到的
// 就是 `C:\Users\laiyi`；没展开，收到的是 `/~`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createFsRoutes } from '../lib/routes-fs.js'

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

/** 一个记下路径的假 SFTP。 */
function fakeSftp(recorder) {
  return {
    async readdir(p) { recorder.push(p); return [] },
    async stat(p) { recorder.push(p); return { isDirectory: () => true, size: 0, mtime: 0 } },
  }
}

async function callLs({ rawPath, home }) {
  const seen = []
  const { ctx, routes } = makeCtx()
  await ctx.effect(() => {}, 'test') // ctx.effect 是 no-op；这里只是保持形状一致
  const created = createFsRoutes({
    sendJson: (res, status, body) => { res.statusCode = status; res.payload = JSON.stringify(body) },
    readBody: async () => '',
    resolveRequestBinding: async () => ({
      pool: {
        platform: 'windows',
        sftp: async () => fakeSftp(seen),
        exec: async () => ({ stdout: '', stderr: '', code: 0 }),
        detect: async () => {},
      },
      ws: 'C:\\Users\\laiyi',
      host: 'winbox',
      port: 22,
      username: 'laiyi',
      mirrorDir: '',
    }),
    decodeBuf: (b) => b,
    encodeText: (t) => Buffer.from(t),
    audit: () => {},
    config: { encoding: 'utf-8', maxFileBytes: 100000 },
    mirrorDirFor: () => '',
    // 家目录由宿主注入：这里模拟"已探到 C:\Users\laiyi"
    expandRemoteTilde: async (pool, p) => {
      const s = String(p || '').trim()
      if (s === '~') return home
      if (s.startsWith('~\\')) return home + '\\' + s.slice(2)
      return s
    },
  })
  const route = created.find((r) => r.path === '/dsh-remote/ls')
  assert.ok(route, '/dsh-remote/ls route must exist')
  const req = Readable.from([])
  req.method = 'GET'
  req.url = `/dsh-remote/ls?path=${encodeURIComponent(rawPath)}`
  const res = {
    statusCode: 0, payload: '',
    setHeader() {}, end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  await route.handler(req, res)
  return { seen, payload: res.payload }
}

test('/ls 把 `~` 展开成真实家目录后再交给 SFTP', async () => {
  const { seen } = await callLs({ rawPath: '~', home: 'C:\\Users\\laiyi' })
  assert.ok(seen.length > 0, 'SFTP must have been called')
  assert.equal(seen[0], 'C:\\Users\\laiyi', 'the path handed to SFTP must be the expanded home')
  assert.notEqual(seen[0], '/~', 'the old code turned `~` into the POSIX path /~')
})

test('/ls 把 `~\\子目录` 展开成 家目录\\子目录', async () => {
  const { seen } = await callLs({ rawPath: '~\\Documents', home: 'C:\\Users\\laiyi' })
  assert.equal(seen[0], 'C:\\Users\\laiyi\\Documents')
})

test('/ls 对普通绝对路径不做任何改写', async () => {
  const { seen } = await callLs({ rawPath: 'C:\\Dev\\projects', home: 'C:\\Users\\laiyi' })
  assert.equal(seen[0], 'C:\\Dev\\projects')
})
