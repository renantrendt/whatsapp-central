// Converte o áudio gravado pelo navegador (WebM com Opus) para OGG com Opus,
// o formato das mensagens de voz do WhatsApp. O som não muda: só a "embalagem".
// Feito em JavaScript puro para rodar também no celular, onde não há ffmpeg.

// IDs dos elementos do WebM (formato EBML) que interessam.
const SEGMENT = 0x18538067
const CLUSTER = 0x1f43b675
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const BLOCK_GROUP = 0xa0
const CODEC_PRIVATE = 0x63a2
const SIMPLE_BLOCK = 0xa3
const BLOCK = 0xa1
const CONTAINERS = new Set([SEGMENT, CLUSTER, TRACKS, TRACK_ENTRY, BLOCK_GROUP])

function readVint(buf, pos, keepMarker) {
  const first = buf[pos]
  if (first === undefined) return null
  let len = 1
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
  if (len > 8 || pos + len > buf.length) return null
  let value = keepMarker ? first : first & (0xff >> len)
  let allOnes = (first & (0xff >> len)) === 0xff >> len
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i]
    if (buf[pos + i] !== 0xff) allOnes = false
  }
  return { value, len, unknown: allOnes }
}

// Lê os pacotes Opus e o cabeçalho OpusHead de dentro do WebM.
function parseWebm(buf) {
  const packets = []
  let head = null
  let pos = 0
  while (pos < buf.length) {
    const id = readVint(buf, pos, true)
    if (!id) break
    const size = readVint(buf, pos + id.len, false)
    if (!size) break
    const start = pos + id.len + size.len
    if (CONTAINERS.has(id.value)) {
      pos = start // entra no elemento (o tamanho pode ser "desconhecido")
      continue
    }
    const end = Math.min(buf.length, start + size.value)
    if (id.value === CODEC_PRIVATE) head = buf.subarray(start, end)
    if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
      const track = readVint(buf, start, false)
      if (track) {
        const flags = buf[start + track.len + 2]
        if (((flags >> 1) & 3) === 0) packets.push(buf.subarray(start + track.len + 3, end))
      }
    }
    pos = end
  }
  return { head, packets }
}

// Quantas amostras (a 48 kHz) um pacote Opus representa, pelo primeiro byte (TOC).
function opusSamples(packet) {
  const toc = packet[0]
  const config = toc >> 3
  let ms
  if (config < 12) ms = [10, 20, 40, 60][config % 4]
  else if (config < 16) ms = [10, 20][config % 2]
  else ms = [2.5, 5, 10, 20][config % 4]
  const c = toc & 3
  const frames = c === 0 ? 1 : c === 3 ? packet[1] & 0x3f : 2
  return frames * ms * 48
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0
    t[i] = r >>> 0
  }
  return t
})()

function crc32(buf) {
  let crc = 0
  for (const b of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0
  return crc
}

function oggPage(packet, { granule, serial, seq, flags }) {
  const lacing = []
  let left = packet.length
  while (left >= 255) {
    lacing.push(255)
    left -= 255
  }
  lacing.push(left)
  const header = Buffer.alloc(27 + lacing.length)
  header.write('OggS', 0, 'ascii')
  header[4] = 0
  header[5] = flags
  header.writeBigUInt64LE(BigInt(granule), 6)
  header.writeUInt32LE(serial, 14)
  header.writeUInt32LE(seq, 18)
  header.writeUInt32LE(0, 22)
  header[26] = lacing.length
  Buffer.from(lacing).copy(header, 27)
  const page = Buffer.concat([header, packet])
  page.writeUInt32LE(crc32(page), 22)
  return page
}

function defaultHead() {
  const h = Buffer.alloc(19)
  h.write('OpusHead', 0, 'ascii')
  h[8] = 1 // versão
  h[9] = 1 // um canal
  h.writeUInt16LE(312, 10) // amostras iniciais a descartar
  h.writeUInt32LE(48000, 12)
  return h
}

/** Recebe um WebM/Opus e devolve um OGG/Opus. Lança erro se não houver áudio Opus. */
export function webmToOgg(webm) {
  const { head, packets } = parseWebm(Buffer.from(webm))
  if (!packets.length) throw new Error('no Opus audio in the recording')
  const opusHead = head && head.subarray(0, 8).toString('ascii') === 'OpusHead' ? Buffer.from(head) : defaultHead()
  const vendor = Buffer.from('Whatsapp Central')
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4)
  tags.write('OpusTags', 0, 'ascii')
  tags.writeUInt32LE(vendor.length, 8)
  vendor.copy(tags, 12)

  const serial = (Math.random() * 0xffffffff) >>> 0
  const pages = [
    oggPage(opusHead, { granule: 0, serial, seq: 0, flags: 0x02 }),
    oggPage(tags, { granule: 0, serial, seq: 1, flags: 0 }),
  ]
  let granule = 0
  packets.forEach((p, i) => {
    granule += opusSamples(p)
    const last = i === packets.length - 1
    pages.push(oggPage(p, { granule, serial, seq: i + 2, flags: last ? 0x04 : 0 }))
  })
  return Buffer.concat(pages)
}
