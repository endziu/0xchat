import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

interface ModalProps {
  onClose: () => void
  labelledBy: string
  className?: string
  children: ComponentChildren
}

// A native modal <dialog>: the browser traps focus, closes it on Esc and draws
// the backdrop. Mounting opens it; unmounting closes it and returns focus.
export function Modal({ onClose, labelledBy, className = '', children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current!
    const opener = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
      opener?.focus()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onClose={onClose}
      // A click on the dialog element itself, not its content, is the backdrop.
      onClick={(event) => { if (event.target === ref.current) onClose() }}
      className={`m-auto modal-safe-viewport w-[calc(100%-1.5rem)] flex-col border border-neutral-800 bg-black p-0 text-neutral-200 open:flex backdrop:bg-black/80 ${className}`}
    >
      {children}
    </dialog>
  )
}
