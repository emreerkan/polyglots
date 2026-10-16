import { useEffect, useState } from 'react'
import type { DataClient } from '../../data/download.js'
import type { Locale } from '../../types.js'
import { errorMessage, useCommands } from '../commands.js'
import { tmListed } from '../setup.js'

/**
 * Whether polyglots-data has a memory for the locale, read once in the
 * background so the screen asking draws at once. `listed` carries a client
 * whose manifest is the answer already read, so the fetch that follows does
 * not ask the network the same question twice. `offline` is any failure to
 * read the manifest, a refusal included: either way there is nothing to offer.
 */
export type TmListing =
  | { status: 'loading' }
  | { status: 'listed'; client: DataClient }
  | { status: 'unlisted' }
  | { status: 'offline'; message: string }

export function useTmListing(locale: Locale | undefined): TmListing {
  const commands = useCommands()
  const [listing, setListing] = useState<TmListing>(locale === undefined ? { status: 'unlisted' } : { status: 'loading' })
  useEffect(() => {
    if (locale === undefined) return
    let wanted = true
    // The client's own timeout (15 s) bounds the wait; nothing here waits on
    // it, since the screen is drawn and usable while it runs.
    commands.dataClient.manifest().then(
      (manifest) => {
        if (!wanted) return
        setListing(
          tmListed(manifest, locale) ? { status: 'listed', client: { ...commands.dataClient, manifest: async () => manifest } } : { status: 'unlisted' },
        )
      },
      (err: unknown) => wanted && setListing({ status: 'offline', message: errorMessage(err) }),
    )
    return () => {
      wanted = false
    }
  }, [commands, locale])
  return listing
}
