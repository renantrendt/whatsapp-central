// Event recorder for the WhatsApp connections. One JSON line per event, kept in
// memory and in diag.log inside the data folder, so a problem on the phone can
// be read afterwards. It stores no message text and no phone numbers: only
// event kinds, counts, message ids and timings.
// Read it with GET /api/diag (same access cookie as the rest of the app).
import fs from 'node:fs'
import path from 'node:path'

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
    tail: (n) => lines.slice(-Math.max(1, Math.min(MAX_LINES, n || 500))),
  }
}

// Used when no recorder is given (tests, demo mode).
export const noDiag = { log() {}, count() {}, flush() {}, tail: () => [] }
