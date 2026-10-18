import { useEffect, useState } from 'react'

// Seconds since `key` last changed while `active`, re-rendered once a second so
// the number visibly moves during a call that produces no other output. Both the
// translate and review screens sit through calls of minutes with nothing else to
// show, and this clock is the only sign the run has not wedged.
//
// `from` is when the thing being timed began, when the caller knows it. A
// single run mounts its screen before its first batch, so counting from the
// moment the key changed was the same thing. A batch of files opens one file's
// screen part way through a batch that has been running for minutes, and a
// clock starting at zero there contradicted the list line above it, which
// counts from the batch's own start.
export function useElapsed(active: boolean, key: number | string, from?: number): number {
  const [since, setSince] = useState(() => from ?? Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    const started = from ?? Date.now()
    setSince(started)
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, key, from])

  return Math.max(0, Math.round((now - since) / 1000))
}
