import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/utils"

/**
 * Audit items 44, 45 and 46 — a dialog that scrolls nothing.
 *
 * The Viewport asked for `h-full`. A percentage height resolves against the
 * parent's DEFINITE height, and a `ScrollArea` sized by `min-h-0 flex-1`
 * inside a dialog whose own height comes from `max-h-[90vh]` and its content
 * has no definite height to offer — so `h-full` computed to the content's own
 * height and `overflow: scroll` had nothing left to clip.
 *
 * Measured in Chromium against the compiled stylesheet, reproducing the
 * Forward dialog: the ScrollArea was correctly 514px, its Viewport computed
 * to 1640px, `scrollHeight === clientHeight`, and the message body box sat
 * 1,717px down a 700px window — which is the report's "the message body box
 * goes missing below", to the pixel.
 *
 * A flex column with `min-h-0 flex-1` takes percentage resolution out of the
 * path entirely; the same correction the Passport booklet needed for the same
 * reason. After: Viewport 514px, `scrollHeight` 1640, scrolls. A ScrollArea
 * that already had a definite height (`h-[480px]`, the common case) measures
 * identically before and after, and the scrollbar is unaffected because Radix
 * positions it absolutely rather than as a child in flow.
 */
const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("relative flex flex-col overflow-hidden", className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="min-h-0 flex-1 w-full rounded-[inherit] [&>div]:!min-w-0 [&>div]:!w-full">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors",
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
