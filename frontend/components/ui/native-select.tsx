import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "cn"

/** A native <select> styled like <Input> (rounded, muted fill, chevron). Native keeps keyboard and mobile behaviour. */
function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        data-slot="native-select"
        className={cn(
          "h-11 w-full min-w-0 cursor-pointer appearance-none rounded-2xl border border-transparent bg-muted pr-10 pl-4 text-base transition-[background-color,border-color,box-shadow] duration-150 hover:bg-hover focus-visible:bg-card outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50 md:text-sm",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}

export { NativeSelect }
