import { splitMessageLinks } from '../lib/message-links'

interface MessageTextProps {
  plaintext: string
  className?: string
}

export function MessageText({ plaintext, className }: MessageTextProps) {
  return (
    <p className={`m-0 break-words whitespace-pre-wrap ${className ?? ''}`}>
      {splitMessageLinks(plaintext).map((part, index) => (
        part.type === 'link' ? (
          <a
            key={index}
            href={part.value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-400 underline underline-offset-2 break-all hover:text-sky-300"
          >
            {part.value}
          </a>
        ) : part.value
      ))}
    </p>
  )
}
