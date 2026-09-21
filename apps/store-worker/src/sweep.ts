import { isAnchored, sweepStores } from "@mida/api"
import type { ContextStores, RegistryReader } from "@mida/api"

/**
 * What the Worker's `scheduled` trigger runs: sweepStores with the anchoring check wired to Monad. A pending
 * object older than 24 h is deleted; an anchored object is never swept; nonces outside the 60 s window go too.
 * `now` is injectable so the fake-clock tests exercise the same code path the cron hits.
 */
export async function runSweep(input: { stores: ContextStores; reader: RegistryReader; now?: Date }): Promise<{ objectsRemoved: number; noncesRemoved: number }> {
  return sweepStores({
    stores: input.stores,
    now: input.now,
    isAnchored: async (object) => isAnchored(object, await input.reader.getRecord(object.contextId)),
  })
}
