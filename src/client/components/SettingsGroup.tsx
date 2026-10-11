import type { ComponentChildren } from 'preact'

// One group of Settings: a small heading, rows on a rounded panel, and helper
// text underneath.
export function SettingsGroup({ title, foot, className = '', children }: { title?: string; foot?: ComponentChildren; className?: string; children: ComponentChildren }) {
  return (
    <section className={className}>
      {title && <h3 className="mt-5.5 mb-2 ml-4 text-sm font-bold text-text-2">{title}</h3>}
      <div className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">{children}</div>
      {foot && <div className="mx-4 mt-2 text-xs text-text-3">{foot}</div>}
    </section>
  )
}

// A row's layout: label on the left, its value or control on the right.
export const ROW = 'relative flex min-h-[52px] w-full items-center gap-3 py-1 pr-2 pl-4 text-left'
