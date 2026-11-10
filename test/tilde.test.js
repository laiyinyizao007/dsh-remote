// `~` 展开的纯逻辑（lib/tilde.js）。
//
// 这条能力的存在理由是一条真实故障：Windows 远程上 `echo ~` 会**原样回显**
// `~`（cmd.exe 不展开波浪号），于是旧实现把 `~` 当成家目录返回——
// `/dsh-remote/home` 答 `{"ok":true,"home":"~"}`，**看起来成功、实际不可用**；
// 而 `normalizeRemotePath('~')` 又会把它当成 POSIX 的相对段，落成 `/~`。
//
// 这里钉住的是"哪些输出算绝对路径""怎么展开""探测顺序"的判定规则：
// 判定错了，Windows 上就会静默地指向一个不存在的目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isTildePath, looksAbsoluteRemotePath, expandTildePath, pickHomeFrom,
  HOME_PROBE_COMMANDS, homeKeyFor, cacheHome, cachedHome, forgetHome,
} from '../lib/tilde.js'

test('isTildePath 只认 `~` 开头，不把 ~foo 或含 ~ 的路径误判', () => {
  assert.equal(isTildePath('~'), true)
  assert.equal(isTildePath('~/Documents'), true)
  assert.equal(isTildePath('~\\Documents'), true)
  assert.equal(isTildePath('  ~  '), true)
  assert.equal(isTildePath('~user'), false, '~user 是另一个用户的主目录，不能当 ~ 处理')
  assert.equal(isTildePath('/home/~backup'), false)
  assert.equal(isTildePath('C:\\Users\\me'), false)
  assert.equal(isTildePath(''), false)
  assert.equal(isTildePath(null), false)
  assert.equal(isTildePath(undefined), false)
})

test('looksAbsoluteRemotePath 认三种绝对路径，挡掉未展开的占位符', () => {
  // Windows 盘符
  assert.equal(looksAbsoluteRemotePath('C:\\Users\\me'), true)
  assert.equal(looksAbsoluteRemotePath('C:/Users/me'), true)
  // Windows UNC
  assert.equal(looksAbsoluteRemotePath('\\\\server\\share'), true)
  // POSIX
  assert.equal(looksAbsoluteRemotePath('/home/me'), true)
  // 这些都**不是**绝对路径：它们是没被 shell 展开的占位符，或者就是 `~`
  assert.equal(looksAbsoluteRemotePath('~'), false)
  assert.equal(looksAbsoluteRemotePath('%USERPROFILE%'), false)
  assert.equal(looksAbsoluteRemotePath('$env:USERPROFILE'), false)
  assert.equal(looksAbsoluteRemotePath(''), false)
  assert.equal(looksAbsoluteRemotePath(null), false)
})

test('expandTildePath 用真实家目录展开，分隔符跟随家目录风格', () => {
  // Windows 家目录
  assert.equal(expandTildePath('~', 'C:\\Users\\me'), 'C:\\Users\\me')
  assert.equal(expandTildePath('~\\Documents', 'C:\\Users\\me'), 'C:\\Users\\me\\Documents')
  assert.equal(expandTildePath('~/Documents', 'C:\\Users\\me'), 'C:\\Users\\me\\Documents')
  // POSIX 家目录
  assert.equal(expandTildePath('~', '/home/me'), '/home/me')
  assert.equal(expandTildePath('~/code', '/home/me'), '/home/me/code')
  // 家目录末尾的斜杠不产生重复分隔符
  assert.equal(expandTildePath('~', 'C:\\Users\\me\\'), 'C:\\Users\\me')
  // 家目录里带空格（Windows 上很常见）——不能被压掉
  assert.equal(expandTildePath('~', 'C:\\Users\\John Doe'), 'C:\\Users\\John Doe')
  // 没探到家目录时**原样返回**：调用方据此提示用户改用绝对路径，
  // 而不是把 `~` 当相对路径默默拼到工作区后面。
  assert.equal(expandTildePath('~', ''), '~')
  assert.equal(expandTildePath('~/x', ''), '~/x')
  // 非 `~` 路径不受影响
  assert.equal(expandTildePath('/abs/path', 'C:\\Users\\me'), '/abs/path')
})

test('pickHomeFrom 取第一个像绝对路径的输出，忽略未展开的占位符', () => {
  // Windows（cmd.exe）：`echo ~` 原样回显，下一条才是答案
  const win = [
    { cmd: 'echo ~', stdout: '~\n' },
    { cmd: 'echo %USERPROFILE%', stdout: 'C:\\Users\\me\n' },
  ]
  assert.equal(pickHomeFrom(win), 'C:\\Users\\me')

  // POSIX：第一条就命中
  assert.equal(pickHomeFrom([{ cmd: 'echo ~', stdout: '/home/me\n' }]), '/home/me')

  // 全是占位符 → 解析失败（空串），而不是猜一个
  assert.equal(pickHomeFrom([
    { cmd: 'echo ~', stdout: '~' },
    { cmd: 'echo %USERPROFILE%', stdout: '%USERPROFILE%' },
    { cmd: 'echo $env:USERPROFILE', stdout: '$env:USERPROFILE' },
  ]), '')

  // 空输入不炸
  assert.equal(pickHomeFrom([]), '')
  assert.equal(pickHomeFrom(null), '')
})

test('探测命令覆盖 POSIX / cmd.exe / PowerShell 三种 shell', () => {
  assert.ok(HOME_PROBE_COMMANDS.includes('echo ~'), 'POSIX')
  assert.ok(HOME_PROBE_COMMANDS.includes('echo %USERPROFILE%'), 'cmd.exe')
  assert.ok(HOME_PROBE_COMMANDS.includes('echo $env:USERPROFILE'), 'PowerShell')
  // 第一条必须是 POSIX 的 `echo ~`：它在 POSIX 上一次命中，
  // 在 Windows 上被 looksAbsoluteRemotePath 挡掉后继续往下试。
  assert.equal(HOME_PROBE_COMMANDS[0], 'echo ~')
})

test('家目录缓存按机器维度存取', () => {
  const key = homeKeyFor('100.97.107.91', 22, 'laiyi')
  assert.equal(key, '100.97.107.91:22:laiyi')
  assert.equal(cachedHome(key), '')
  cacheHome(key, 'C:\\Users\\laiyi')
  assert.equal(cachedHome(key), 'C:\\Users\\laiyi')
  // 另一台机器不能串味
  assert.equal(cachedHome(homeKeyFor('10.0.0.1', 22, 'dev')), '')
  forgetHome(key)
  assert.equal(cachedHome(key), '')
})
