// D6 storage half: the embedded store's data tree is user-only — every
// directory 0700, every file 0600 — both at creation and after a restart on
// a tree that already exists.

import { describe, expect, it } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Deployment } from "@mida/chain"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import { DenyOverlay, ReplayGuard, createContextApi } from "@mida/api"
import type { RegistryReader, StoredObject } from "@mida/api"

const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  deploymentBlock: 0n,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}

const OWNER = `0x${"1".repeat(40)}` as Address
const NAMESPACE = hexOf(randomBytes(32))

function fakeObject(): StoredObject {
  const contextId = hexOf(randomBytes(32))
  return {
    contextId,
    owner: OWNER,
    uploader: OWNER,
    namespaceId: NAMESPACE,
    authorId: hexOf(randomBytes(32)),
    objectNonce: hexOf(randomBytes(32)),
    expectedParentId: `0x${"0".repeat(64)}` as Hex,
    manifest: {
      v: 1,
      contextId,
      ciphertextHash: hexOf(randomBytes(32)),
      ciphertextSize: 4,
      payloadNonce: hexOf(randomBytes(32)),
      cryptoVersion: "mida-crypto-v1",
      readEpoch: "1",
      epochDekWrap: {
        v: 1,
        contextId,
        namespaceId: NAMESPACE,
        readEpoch: "1",
        ephemeralPublicKey: hexOf(randomBytes(32)),
        nonce: hexOf(randomBytes(12)),
        wrappedDek: hexOf(randomBytes(48)),
      },
    },
    manifestHash: hexOf(randomBytes(32)),
    uploadedAt: new Date().toISOString(),
    anchoredAt: null,
  }
}

/** Every path under root, paired with its mode bits. */
function walkModes(root: string): Array<{ path: string; mode: number; dir: boolean }> {
  const out: Array<{ path: string; mode: number; dir: boolean }> = [{ path: root, mode: statSync(root).mode & 0o777, dir: true }]
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name)
      const stat = statSync(full)
      out.push({ path: full, mode: stat.mode & 0o777, dir: stat.isDirectory() })
      if (stat.isDirectory()) visit(full)
    }
  }
  visit(root)
  return out
}

function expectLocked(root: string): void {
  for (const entry of walkModes(root)) {
    expect(entry.mode, `${entry.dir ? "dir" : "file"} ${entry.path}`).toBe(entry.dir ? 0o700 : 0o600)
  }
}

describe("the embedded store's data tree is user-only", () => {
  it("creates every directory 0700 and every file 0600", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "mida-modes-")), "data")
    const { store, overlay } = createContextApi({ reader: {} as RegistryReader, deployment, dataDir })

    await store.putObject(fakeObject())
    await store.putWrap({
      v: 1,
      owner: OWNER,
      namespaceId: NAMESPACE,
      readEpoch: "1",
      agentId: hexOf(randomBytes(32)),
      agentKeyVersion: 1,
      ephemeralPublicKey: hexOf(randomBytes(32)),
      nonce: hexOf(randomBytes(12)),
      wrappedEpochPrivateKey: hexOf(randomBytes(48)),
      createdAt: new Date().toISOString(),
    })
    await store.setManifestIndex(hexOf(randomBytes(32)), hexOf(randomBytes(32)))
    await store.blobs.put(new Uint8Array([1, 2, 3]))
    await overlay.create(OWNER, { kind: "capability", capabilityId: hexOf(randomBytes(32)) }, 1n)
    await new ReplayGuard(join(dataDir, "replay-nonces.json")).consume(OWNER, hexOf(randomBytes(32)), 100n, 100n)

    expectLocked(dataDir)
  })

  it("repairs a pre-existing tree's modes at startup", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mida-modes-"))
    const loose = join(dataDir, "objects")
    mkdirSync(loose, { recursive: true })
    chmodSync(dataDir, 0o755)
    chmodSync(loose, 0o755)
    const staleFile = join(loose, `${hexOf(randomBytes(32))}.json`)
    writeFileSync(staleFile, "{}")
    chmodSync(staleFile, 0o644)

    createContextApi({ reader: {} as RegistryReader, deployment, dataDir })
    expectLocked(dataDir)
  })
})
