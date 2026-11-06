import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "group/badge inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border border-transparent px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        ink: "bg-primary text-primary-foreground",
        secondary: "bg-muted text-foreground",
        muted: "bg-muted text-muted-foreground",
        brand: "bg-brand-soft text-brand-hover",
        "brand-solid": "bg-brand text-white",
        trade: "bg-trade-soft text-trade-deep",
        "trade-solid": "bg-trade text-foreground",
        "trade-deep": "bg-trade-deep/90 text-white",
        profit: "bg-profit/10 text-profit",
        loss: "bg-loss/10 text-loss",
        white: "bg-white text-foreground",
        destructive: "bg-loss/10 text-loss",
        outline: "border-border bg-card text-foreground",
        ghost: "text-muted-foreground hover:bg-muted",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "",
        micro: "h-5 px-2 font-mono text-[10px] tracking-[0.08em] uppercase",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
