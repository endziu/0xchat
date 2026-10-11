import type { ComponentChildren } from 'preact'

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: readonly { value: T; label: ComponentChildren }[]
  onChange: (value: T) => void
}

// A row of mutually exclusive choices, the selected one raised.
export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className="grid w-full auto-cols-fr grid-flow-col gap-0 rounded-md bg-raised p-1">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className="h-10 justify-center gap-1.5 rounded-sm text-sm font-semibold text-text-2 aria-pressed:bg-surface aria-pressed:text-text aria-pressed:shadow-[0_1px_3px_rgb(0_0_0/.12)]"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
