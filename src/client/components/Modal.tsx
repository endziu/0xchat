import type { ComponentChildren } from 'preact'
import { useEffect, useId, useRef } from 'preact/hooks'

interface ModalProps {
  onClose: () => void
  title: string
  // The header's text button, which closes the modal.
  action?: string
  // On phones: a full page, or a bottom sheet with a grabber. Wider screens
  // always get a centred dialog.
  kind?: 'page' | 'sheet'
  children: ComponentChildren
}

const KIND = {
  page: 'max-sm:m-0 max-sm:size-full max-sm:max-h-none max-sm:max-w-none safe-top sm:pt-0',
  sheet: 'max-sm:mx-0 max-sm:mb-0 max-sm:mt-auto max-sm:w-full max-sm:max-w-none max-sm:max-h-[92%] max-sm:rounded-t-md safe-bottom',
}

// A native modal <dialog>: the browser traps focus, closes it on Esc and draws
// the backdrop. Mounting opens it; unmounting closes it and returns focus.
export function Modal({ onClose, title, action = 'Done', kind = 'page', children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

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
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the dialog element itself, not its content, is the backdrop.
      onClick={(event) => { if (event.target === ref.current) onClose() }}
      className={`flex-col overflow-hidden border-0 bg-bg p-0 text-text open:flex backdrop:bg-[rgb(30_28_25/.32)] dark:backdrop:bg-[rgb(0_0_0/.55)] sm:m-auto sm:max-h-[calc(100%-48px)] sm:w-[min(600px,calc(100%-48px))] sm:rounded-md sm:shadow-[0_24px_60px_rgb(0_0_0/.25)] ${KIND[kind]}`}
    >
      {kind === 'sheet' && <span aria-hidden="true" className="mx-auto mt-2 h-[5px] w-9 shrink-0 rounded-full bg-line-strong sm:hidden" />}
      <header className="flex shrink-0 items-center justify-between pt-3 pr-2 pb-1 pl-5">
        <h2 id={titleId} className={`text-lg font-bold ${kind === 'page' ? 'max-sm:text-3xl' : ''}`}>{title}</h2>
        <button onClick={onClose} className="min-h-11 rounded-md px-3 font-bold text-accent-text hover:bg-raised">{action}</button>
      </header>
      {children}
    </dialog>
  )
}
