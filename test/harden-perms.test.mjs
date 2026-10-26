// node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hardenPerms } from '../lib/login.mjs'

const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-perms-'))
  const file = join(dir, 'bili_credential.json')
  writeFileSync(file, '{"sessdata":"x"}', 'utf8')
  return { dir, file }
}

test('#128：收紧之后自己还读得回来（机器名 = 用户名时以前会被锁死）', { skip: process.platform !== 'win32' }, () => {
  const { dir, file } = tempFile()
  try {
    assert.equal(hardenPerms(file), true)
    assert.equal(readFileSync(file, 'utf8'), '{"sessdata":"x"}')
    const acl = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true })
    assert.doesNotMatch(acl, /\(I\)/, '继承来的权限应该已经去掉了')
  } finally {
    try { execFileSync('icacls', [file, '/reset'], { stdio: 'ignore', windowsHide: true }) } catch { /* 清理尽力而为 */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非 Windows：chmod 600', { skip: process.platform === 'win32' }, () => {
  const { dir, file } = tempFile()
  try {
    assert.equal(hardenPerms(file), true)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
