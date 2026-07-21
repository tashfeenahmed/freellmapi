import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

// Thin styled wrapper over Base UI's Slider. Supports both single-value and
// range (two-thumb) sliders: pass an array `value` to get one thumb per entry.
// `formatLabel` renders an optional bubble above each thumb (e.g. the formatted
// value), positioned so it tracks the thumb as it moves.
function Slider({
  className,
  formatLabel,
  value,
  defaultValue,
  ...props
}: SliderPrimitive.Root.Props & {
  formatLabel?: (index: number) => React.ReactNode
}) {
  const resolved = (value ?? defaultValue) as number | readonly number[] | undefined
  const thumbCount = Array.isArray(resolved) ? resolved.length : 1

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      defaultValue={defaultValue}
      className={cn("relative w-full", className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full touch-none items-center py-2 select-none">
        <SliderPrimitive.Track className="relative h-1.5 w-full grow rounded-full bg-muted">
          <SliderPrimitive.Indicator className="absolute h-full rounded-full bg-primary" />
          {Array.from({ length: thumbCount }).map((_, i) => (
            <SliderPrimitive.Thumb
              key={i}
              index={i}
              className="relative size-4 rounded-full border-2 border-primary bg-background shadow-md ring-1 ring-black/5 transition-transform outline-none hover:scale-115 focus-visible:ring-3 focus-visible:ring-ring/50 data-dragging:scale-115 dark:bg-background"
            >
              {formatLabel && (
                <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-primary-foreground shadow-sm tabular-nums">
                  {formatLabel(i)}
                </span>
              )}
            </SliderPrimitive.Thumb>
          ))}
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
