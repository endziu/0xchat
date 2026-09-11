export type MessageLinkPart =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string }

const HTTP_URL = /\bhttps?:\/\/[^\s<>"']+/giu
const SENTENCE_PUNCTUATION = /[.,!?;:]$/u
const CLOSING_DELIMITERS = [
  { open: '(', close: ')' },
  { open: '[', close: ']' },
  { open: '{', close: '}' },
] as const

function count(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length
}

function trimTrailingPunctuation(candidate: string): string {
  let value = candidate
  let changed = true

  while (changed) {
    changed = false
    if (SENTENCE_PUNCTUATION.test(value)) {
      value = value.slice(0, -1)
      changed = true
      continue
    }

    for (const delimiter of CLOSING_DELIMITERS) {
      if (
        value.endsWith(delimiter.close)
        && count(value, delimiter.close) > count(value, delimiter.open)
      ) {
        value = value.slice(0, -1)
        changed = true
        break
      }
    }
  }

  return value
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function splitMessageLinks(message: string): MessageLinkPart[] {
  const parts: MessageLinkPart[] = []
  let cursor = 0

  const appendText = (value: string) => {
    if (!value) return
    const previous = parts.at(-1)
    if (previous?.type === 'text') previous.value += value
    else parts.push({ type: 'text', value })
  }

  for (const match of message.matchAll(HTTP_URL)) {
    const start = match.index
    appendText(message.slice(cursor, start))

    const candidate = match[0]
    const link = trimTrailingPunctuation(candidate)
    if (link && isHttpUrl(link)) {
      parts.push({ type: 'link', value: link })
      appendText(candidate.slice(link.length))
    } else {
      appendText(candidate)
    }
    cursor = start + candidate.length
  }

  appendText(message.slice(cursor))
  return parts
}
