# mida-context-sdk — ask a user's Mida for scoped context

The Mida SDK lets an agent request access to a user's Mida, then read and write only the
context the user granted — every write carries on-chain provenance, and revocation is live.

```ts
import { MidaAgent } from "mida-context-sdk"
```

Requires Node 22+. The `mida` CLI (package `mida-context`) provisions agents and grants.

## License

MIT — see LICENSE.
