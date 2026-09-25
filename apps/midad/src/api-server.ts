import { mkdirSync } from "node:fs"
import { createPublicClient } from "viem"
import { serve } from "@hono/node-server"
import { chainFor, rpcTransport } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { RegistryReader, createContextApi } from "@mida/api"

/** The existing Context API, on a data folder that is still there after a restart. Bound to localhost only. */
export async function startPersistentApi(input: { rpcUrl: string; deployment: Deployment; dataDir: string }): Promise<{ baseUrl: string; close(): Promise<void> }> {
  mkdirSync(input.dataDir, { recursive: true, mode: 0o700 })
  const publicClient = createPublicClient({ chain: chainFor(input.deployment.chainId), transport: rpcTransport(input.rpcUrl) })
  const reader = new RegistryReader({ publicClient, deployment: input.deployment })
  const { app } = createContextApi({ reader, deployment: input.deployment, dataDir: input.dataDir })
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({ baseUrl: `http://127.0.0.1:${info.port}`, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}
