# @mida-context/sdk

**Give your agent the memory a user approved, and nothing more.** The Mida SDK reads and writes a
user's Mida memory through the Mida service on their machine. The user approves your agent once,
every read passes the grants they signed, and they can revoke your agent at any time.

```ts
import { Mida } from "@mida-context/sdk"

const mida = new Mida({ agent: "my-agent" })
const { items } = await mida.context({ namespace: "projects.current", limit: 8192 })
await mida.remember({ namespace: "projects.current", content: { note: "user prefers pnpm" } })
```

You need Node 22 or later and the `mida` command (`npm install -g mida-context`). It registers your
agent (`mida add-agent my-agent`), lets the user approve it (`mida approve my-agent`), and runs the
local service this SDK talks to. Your app never holds the user's owner keys.

Seven calls: `status`, `requestAccess`, `context`, `remember`, `verify`, `handoff`, `whatsNew`.
Reference: [docs/sdk.md](https://github.com/damli40/mida-context/blob/main/docs/sdk.md).

**Pre-release. Monad testnet only. Not audited.**

## License

MIT.
