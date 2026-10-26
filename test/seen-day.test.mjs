// node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seenDay } from '../lib/state.mjs'

const now = new Date(2026, 9, 26, 15, 0)   // 2026-10-26 本地时间

test('完整日期（老格式）照旧认', () => {
  assert.equal(seenDay('2026-10-22', now), '2026-10-22')
  assert.equal(seenDay('2026-10-22 18:51', now), '2026-10-22')
  assert.equal(seenDay('2026-10-22T18:51:09', now), '2026-10-22')
  assert.equal(seenDay(' 2026-10-22 ', now), '2026-10-22')
})

test('#133：模型写的短日期按今年补全', () => {
  assert.equal(seenDay('10-23', now), '2026-10-23')
  assert.equal(seenDay('10-26', now), '2026-10-26')
  assert.equal(seenDay('1-5', now), '2026-01-05')
  assert.equal(seenDay('10-23 09:30', now), '2026-10-23')
})

test('别的分隔符和不补零的写法', () => {
  assert.equal(seenDay('2026/10/23', now), '2026-10-23')
  assert.equal(seenDay('2026.1.5', now), '2026-01-05')
  assert.equal(seenDay('10/23', now), '2026-10-23')
})

test('没写年份、补出来比今天晚 ⇒ 算去年（跨年读旧行）', () => {
  const jan = new Date(2027, 0, 3)
  assert.equal(seenDay('12-31', jan), '2026-12-31')
  assert.equal(seenDay('01-03', jan), '2027-01-03')
  assert.equal(seenDay('2027-12-31', jan), '2027-12-31')   // 写了年份就不猜
})

test('2 月 29 日：今年有就用今年，往回退到非闰年就认不出', () => {
  assert.equal(seenDay('02-29', new Date(2028, 5, 1)), '2028-02-29')
  assert.equal(seenDay('02-29', new Date(2027, 5, 1)), null)
})

test('不是日期的格子返回 null', () => {
  for (const x of ['', null, undefined, '日期', 'BV1GSnk6aEUz', '13-01', '10-32', '2026-02-30', '昨天', '317831597441']) {
    assert.equal(seenDay(x, now), null, String(x))
  }
})
