import { ReplayGuard } from "./auth.js"
import { FileDenyStore } from "./deny-overlay.js"
import { repairModes } from "./secure-fs.js"
import { ApiStore } from "./store.js"
import type { ContextStores } from "./stores.js"

/**
 * The default stores: one directory on the local filesystem holding the object metadata, content-addressed blobs,
 * replay log and deny overlay. `createContextApi` builds these when it is given `dataDir` and no `stores`, so the
 * local `midad` server and every existing test run exactly the app they ran before.
 */
export function fileStores(dataDir: string): ContextStores {
  repairModes(dataDir)
  return {
    objects: new ApiStore(dataDir),
    nonces: new ReplayGuard(`${dataDir}/replay-nonces.json`),
    denies: new FileDenyStore(`${dataDir}/revocations.json`),
  }
}
