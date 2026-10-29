import { useEffect, useState } from 'react'
import { useGlyphs } from '../theme.js'

const FRAME_MS = 80

// A frame that moves while `active`, for a row whose work gives no other sign
// of life: an export of a plugin the size of WooCommerce is generated on
// request and can take minutes with nothing else changing on screen. Counted
// seconds were the alternative, and were turned down: what the person asked to
// see was that the line is being worked on, not for how long.
export function useSpinner(active: boolean): string {
  const { spinner } = useGlyphs()
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setFrame((f) => f + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [active])
  return spinner[frame % spinner.length]!
}
