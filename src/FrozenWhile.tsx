import { memo, type ReactNode } from 'react'

/**
 * Renders its children, except while `frozen`: then what it rendered last stays as it is,
 * mounted and with its state, and is not rendered again until `frozen` is false. For a
 * part of the screen that is hidden for a while (the plan and route panels during a live
 * drive, #95), so that a GPS fix or the drive's clock does not render it once a second for
 * nobody to see. The first render after `frozen` turns false has the latest props.
 */
export const FrozenWhile = memo(
  function FrozenWhile({ children }: { readonly frozen: boolean; readonly children: ReactNode }) {
    return children
  },
  (previous, next) => previous.frozen && next.frozen,
)
