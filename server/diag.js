// Event recorder for the WhatsApp connections. One JSON line per event, kept in
// memory and in diag.log inside the data folder, so a problem on the phone can
// be read afterwards. It stores no message text and no phone numbers: only
// event kinds, counts, message ids and timings.
// Read it with GET /api/diag (same access cookie as the rest of the app).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const MAX_LINES = 6000
const MAX_FILE = 1_500_000 // bytes; the file then moves to diag.log.1

// A long run of digits could be a phone number, so none is written: 11 digits
// or more in any text value, 8 or more in a counter name. Shorter numbers stay
// in text values, because quotas and times in seconds are useful there.
const maskValue = (key, v) => (typeof v === 'string' ? v.replace(/\d{11,}/g, '<n>') : v)
const maskName = (name) => String(name).replace(/\d{8,}/g, '<n>')

export function createDiag(dataDir) {
  const lines = []
  const file = dataDir ? path.join(dataDir, 'diag.log') : null
  let size = 0
  if (file) {
    try {
      const old = fs.readFileSync(file, 'utf8')
      size = Buffer.byteLength(old)
      for (const l of old.split('\n')) if (l) lines.push(l)
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
    } catch {}
  }

  function log(account, kind, data) {
    const row = JSON.stringify({ t: new Date().toISOString(), a: account || '-', k: kind, ...(data || {}) }, maskValue)
    lines.push(row)
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
    if (!file) return
    try {
      if (size > MAX_FILE) {
        fs.renameSync(file, `${file}.1`)
        size = 0
      }
      fs.appendFileSync(file, `${row}\n`, { mode: 0o600 })
      size += row.length + 1
    } catch {}
  }

  // Counters are summed and written as one "stat" line every 10 minutes,
  // so frequent events (frames, short sleeps) do not fill the log.
  const counters = new Map() // account -> { name: count }
  function count(account, name, by = 1) {
    const key = account || '-'
    let c = counters.get(key)
    if (!c) counters.set(key, (c = {}))
    const n = maskName(name)
    c[n] = (c[n] || 0) + by
  }
  function flush() {
    for (const [account, c] of counters) {
      if (Object.keys(c).length) log(account, 'stat', c)
    }
    counters.clear()
  }
  setInterval(flush, 600000).unref?.()

  // The process did not run for a while: the device slept or the app was frozen.
  // A 2-second timer that fires much later than 2 seconds shows it.
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    const gap = now - last - 2000
    last = now
    if (gap < 5000) return
    count('-', 'sleeps')
    count('-', 'sleptSec', Math.round(gap / 1000))
    if (gap >= 60000) log('-', 'sleep', { s: Math.round(gap / 1000) })
  }, 2000).unref?.()

  return {
    log,
    count,
    flush,
    // The counters not yet written as a "stat" line, by account. Reading them
    // writes nothing, so a report can be read often without filling the log.
    pending: () => Object.fromEntries([...counters].map(([account, c]) => [account, { ...c }])),
    tail: (n) => lines.slice(-Math.max(1, Math.min(MAX_LINES, n || 500))),
  }
}

// ---- The connection report that a paired device reads (see selfState in index.js) ----

// The kind of error only. Two of the app's error texts end with the text of an
// exception after a colon, and that text can hold a file path or an id.
const errorKind = (e) => (e ? String(e).split(':')[0].replace(/\d{5,}/g, '<n>').slice(0, 120) : null)

// A short code that is the same on both paired devices for the same number, so
// that their entries can be matched without sending the number: the first 4
// hex digits of an HMAC of the number, keyed with the pairing secret.
// - Without the pairing secret, the code says nothing about the digits.
// - With the secret, candidate numbers can be tested against the code. One
//   number in 65,536 matches, so an area code of 10 million numbers still has
//   about 150 matches.
export function numberTag(number, secret) {
  const digits = String(number || '').replace(/\D/g, '')
  if (!digits || !secret) return null
  return crypto.createHmac('sha256', String(secret)).update(digits).digest('hex').slice(0, 4)
}

// One account's state. No phone number leaves the device: `me`, the number,
// becomes a yes or no and a number code (see numberTag). An account that is
// not linked gets the code of `number`, the number it last had.
// newestChat is the time written on the newest message stored for the
// account, in seconds. It is not the time the device got that message.
export const accountState = (a, { newestChat, number, secret } = {}) => ({
  id: a.id,
  status: a.status,
  linked: !!a.me,
  error: errorKind(a.error),
  newestChat: newestChat || 0,
  numberTag: numberTag(a.me || number, secret),
})

// A report that came from another device, rebuilt field by field. The result
// has the report's fields, kinds of value and size limits whatever that device
// sent. Free text stays free text: recorder lines and counter names.
const LINE_MAX = 20_000 // characters; the longest real line seen has under 400
export function cleanReport(r) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1e15) : 0)
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const shaped = (v, shape) => (typeof v === 'string' && shape.test(v) ? v : '')
  const list = (v) => (Array.isArray(v) ? v : [])
  const fields = (v) => Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  return {
    now: num(r?.now),
    startedAt: num(r?.startedAt),
    upSec: num(r?.upSec),
    mobile: r?.mobile === true,
    starting: r?.starting === true,
    accounts: list(r?.accounts).slice(0, 20).map((a) => ({
      id: shaped(a?.id, /^[a-z0-9-]{1,40}$/i),
      status: shaped(a?.status, /^[a-z]{1,20}$/),
      linked: a?.linked === true,
      error: errorKind(text(a?.error, 300)),
      newestChat: num(a?.newestChat),
      numberTag: shaped(a?.numberTag, /^[a-f0-9]{4}$/) || null,
    })),
    pending: Object.fromEntries(
      fields(r?.pending).slice(0, 20).map(([account, c]) => [
        account.slice(0, 40),
        Object.fromEntries(fields(c).slice(0, 300).map(([name, n]) => [name.slice(0, 200), num(n)])),
      ])
    ),
    // A line over the limit is replaced, not cut: a cut line is not valid JSON.
    lines: list(r?.lines)
      .filter((l) => typeof l === 'string')
      .slice(-MAX_LINES)
      .map((l) => (l.length > LINE_MAX ? JSON.stringify({ k: 'line-too-long', len: l.length }) : l)),
  }
}

// Used when no recorder is given (tests, demo mode).
export const noDiag = { log() {}, count() {}, flush() {}, pending: () => ({}), tail: () => [] }
