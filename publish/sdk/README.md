# @mida-context/sdk — ask a user's Mida for scoped context

The Mida SDK lets an agent ask the user's Mida for context: request access, read and write
only the records the user granted — every write carries on-chain provenance, and revocation
is live.

```ts
import { Mida } from "@mida-context/sdk"

const mida = new Mida({ agent: "my-agent" })
const { items } = await mida.context({ namespace: "projects.current", limit: 8192 })
```

Requires Node 22+ and the `mida` CLI (package `mida-context`) — it provisions agents, signs
grants, and runs the local Mida service this SDK talks to.

## License

MIT — see LICENSE.
