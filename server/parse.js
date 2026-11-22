// Traduz uma mensagem crua do WhatsApp para o formato simples que o app guarda.
import { normalizeMessageContent, getContentType, BufferJSON } from 'baileys'

export function toSeconds(ts) {
  if (ts == null) return 0
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') return Number(ts) || 0
  if (typeof ts.toNumber === 'function') return ts.toNumber()
  if (typeof ts.low === 'number') return ts.low
  return Number(ts) || 0
}

function thumbOf(media) {
  const t = media?.jpegThumbnail
  if (!t) return ''
  try {
    const b64 = typeof t === 'string' ? t : Buffer.from(t).toString('base64')
    return b64.length < 60000 ? b64 : ''
  } catch {
    return ''
  }
}

// Devolve null para o que não aparece como mensagem (reações, avisos internos).
export function parseContent(waMessage) {
  const content = normalizeMessageContent(waMessage.message)
  if (!content) return null
  const type = getContentType(content)
  if (!type) return null
  const c = content[type]

  switch (type) {
    case 'conversation':
      return { kind: 'text', text: c }
    case 'extendedTextMessage':
      return { kind: 'text', text: c.text || '' }
    case 'imageMessage':
      return { kind: 'image', text: c.caption || '', thumb: thumbOf(c), mime: c.mimetype }
    case 'videoMessage':
    case 'ptvMessage':
      return { kind: 'video', text: c.caption || '', thumb: thumbOf(c), mime: c.mimetype }
    case 'audioMessage':
      return { kind: 'audio', mime: c.mimetype }
    case 'documentMessage':
      return {
        kind: 'document',
        text: c.caption || '',
        mime: c.mimetype,
        fileName: c.fileName || c.title || 'file',
      }
    case 'stickerMessage':
      return { kind: 'sticker', mime: c.mimetype }
    case 'contactMessage':
      return { kind: 'contact', text: c.displayName || '' }
    case 'contactsArrayMessage':
      return { kind: 'contact', text: c.displayName || '' }
    case 'locationMessage':
    case 'liveLocationMessage':
      return { kind: 'location', text: c.name || c.address || '' }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { kind: 'poll', text: c.name || '' }
    case 'protocolMessage': {
      // 0 = apagar para todos, 14 = editar
      if (c.type === 0 && c.key?.id) return { kind: 'revoke', targetId: c.key.id }
      if (c.type === 14 && c.key?.id) {
        const edited = normalizeMessageContent(c.editedMessage)
        const t = edited ? getContentType(edited) : null
        const text =
          t === 'conversation'
            ? edited.conversation
            : t === 'extendedTextMessage'
              ? edited.extendedTextMessage.text
              : edited?.[t]?.caption
        if (typeof text === 'string') return { kind: 'edit', targetId: c.key.id, text }
      }
      return null
    }
    case 'reactionMessage':
      return c.key?.id ? { kind: 'reaction', targetId: c.key.id, emoji: c.text || '' } : null
    case 'templateMessage': {
      const t = c.hydratedTemplate || c.hydratedFourRowTemplate || {}
      return { kind: 'text', text: [t.hydratedTitleText, t.hydratedContentText].filter(Boolean).join('\n') || 'Template message' }
    }
    case 'buttonsMessage':
      return { kind: 'text', text: c.contentText || c.text || 'Message with buttons' }
    case 'listMessage':
      return { kind: 'text', text: [c.title, c.description].filter(Boolean).join('\n') || 'List message' }
    case 'interactiveMessage':
      return { kind: 'text', text: c.body?.text || 'Interactive message' }
    case 'templateButtonReplyMessage':
    case 'buttonsResponseMessage':
      return { kind: 'text', text: c.selectedDisplayText || 'Button reply' }
    case 'listResponseMessage':
      return { kind: 'text', text: c.title || 'List reply' }
    case 'groupInviteMessage':
      return { kind: 'text', text: `Group invite: ${c.groupName || ''}`.trim() }
    case 'albumMessage':
    case 'placeholderMessage':
    case 'pollUpdateMessage':
    case 'keepInChatMessage':
    case 'encReactionMessage':
    case 'messageContextInfo':
      return null
    default:
      return { kind: 'other', text: '' }
  }
}

export function rawOf(waMessage) {
  return JSON.stringify(
    { key: waMessage.key, message: waMessage.message, messageTimestamp: toSeconds(waMessage.messageTimestamp) },
    BufferJSON.replacer
  )
}

export function fromRaw(raw) {
  return JSON.parse(raw, BufferJSON.reviver)
}
