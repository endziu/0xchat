interface ErrorStateProps {
  title: string
  detail: string
  onRetry: () => void
}

// A failed load has to stay visible even when stale content is on screen, so
// this renders as a notice pinned above the content rather than replacing it.
// Stacked, not a row: the conversation sidebar is narrow enough that a
// side-by-side detail column collapses to one character per line.
export function ErrorState({ title, detail, onRetry }: ErrorStateProps) {
  return (
    <div role="alert" className="m-3 grid shrink-0 justify-items-start gap-1 rounded-md bg-bg px-4 py-3.5 text-sm">
      <b className="text-danger">{title}</b>
      <span className="w-full break-words text-text-2">{detail}</span>
      <button onClick={onRetry} className="btn btn-sm mt-1.5">Retry</button>
    </div>
  )
}
