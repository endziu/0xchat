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
    <div role="alert" className="flex flex-col items-start gap-1 m-2 p-2 border border-red-900 text-sm">
      <span className="text-red-400">{title}</span>
      <span className="w-full break-words text-neutral-600">{detail}</span>
      <button onClick={onRetry}>Retry</button>
    </div>
  )
}
