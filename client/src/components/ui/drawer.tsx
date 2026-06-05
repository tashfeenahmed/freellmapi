import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"

import { cn } from "@/lib/utils"

function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerBackdrop({
  className,
  ...props
}: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-backdrop"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:duration-150 data-[state=open]:duration-300",
        className
      )}
      {...props}
    />
  )
}

function DrawerContent({
  className,
  children,
  ...props
}: DrawerPrimitive.Popup.Props) {
  return (
    <DrawerPortal>
      <DrawerBackdrop />
      <DrawerPrimitive.Popup
        data-slot="drawer-content"
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex h-full w-80 flex-col border-l bg-popover p-4 shadow-xl data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right data-[state=closed]:duration-150 data-[state=open]:duration-300",
          className
        )}
        {...props}
      >
        {children}
      </DrawerPrimitive.Popup>
    </DrawerPortal>
  )
}

function DrawerTitle({
  className,
  ...props
}: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-sm font-semibold", className)}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function DrawerClose({
  className,
  ...props
}: DrawerPrimitive.Close.Props) {
  return (
    <DrawerPrimitive.Close
      data-slot="drawer-close"
      className={cn(
        "absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerTrigger,
  DrawerPortal,
  DrawerBackdrop,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
  DrawerClose,
}
