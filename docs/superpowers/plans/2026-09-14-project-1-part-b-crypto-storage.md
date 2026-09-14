# Project 1 Plan — Part B: Crypto and storage (Tasks 6–9)

> Read `2026-09-14-project-1-protocol-core.md` first. Its Global Constraints and "Decisions" sections apply to every task here. Part B consumes only Part A names.

All code in this part was run before it was written here: 53 Vitest tests passing (derive 10, payload 9, wraps 11, object 10, storage 13) and `tsc` strict typecheck exiting 0 against `@noble/* 2.4.0`, `viem 2.56.3`, `canonicalize 4.0.0`, `vitest 4.1.11`, `fast-check 4.9.0`. Copy it verbatim.

Part B decisions where the spec is silent (binding):

1. **Epoch numbering starts at 1.** `deriveEpochKeyPair` rejects epoch `0` with `INVALID_WIRE`, matching §10.6 "the required epoch defaults to 1".
2. **The X25519 private key is the raw 32-byte HKDF epoch seed.** Noble clamps it inside every scalar operation, so the stored private key is the unclamped seed.
3. **`ZERO_KEY` covers every rejected key.** An all-zero or wrong-length PRF output, namespace secret, public key, or shared secret throws it. So does a low-order public key that noble rejects.
4. **Wrap metadata is checked before AEAD.** A wrap whose readable fields disagree with the caller's binding fails with `DECRYPT_FAILED`. The one exception is a reader wrap whose `agentKeyVersion` differs, which fails with `WRAP_KEY_VERSION_MISMATCH`. AEAD with the binding-derived AAD remains the real guard, so a wrap whose metadata was rewritten to match still fails with `DECRYPT_FAILED`.
5. **Decrypted payloads must be canonical v1 JSON.** Any other plaintext fails with `INVALID_WIRE`.
6. **`FsStorage` names each file by the hex content hash without `0x`.** It writes through a temporary file plus rename, so a crash never leaves a partial blob under a valid name.

---

### Task 6: PRF domains, namespace secrets and epoch keypairs

**Files:**
- Create: `packages/crypto/package.json`, `packages/crypto/src/bytes.ts`, `packages/crypto/src/derive.ts`, `packages/crypto/src/index.ts`
- Modify: root `package.json` (add `"@mida/crypto": "workspace:*"` under `dependencies`)
- Test: `packages/crypto/test/derive.test.ts`

**Interfaces:**
- Consumes: `MidaError`, `isMidaError`, `assertHex`, `isZeroBytes`, `encodeUint64` (Tasks 2–3); `namespaceId`, `type IsolationDomain` (Task 4); `type Hex` (Task 2).
- Produces:
  - `hexOf(bytes: Uint8Array): Hex`
  - `bytesOf(hex: string, byteLength: number): Uint8Array` — throws `INVALID_WIRE` on wrong length or case
  - `assertNonZeroKey(bytes: Uint8Array, label: string): void` — throws `ZERO_KEY` unless 32 non-zero bytes
  - `ISOLATION_DOMAINS: readonly IsolationDomain[]` — `["general", "financial", "relationships", "private"]`
  - `prfSalt(domain: IsolationDomain): Uint8Array`
  - `deriveNamespaceSecret(domainPrfOutput: Uint8Array, namespaceId: Hex): Uint8Array`
  - `uint64be(value: bigint): Uint8Array`
  - `interface X25519KeyPair { privateKey: Uint8Array; publicKey: Uint8Array }`
  - `interface EpochKeyPair extends X25519KeyPair { readEpoch: bigint }`
  - `deriveEpochKeyPair(namespaceSecret: Uint8Array, readEpoch: bigint): EpochKeyPair`
  - `x25519PublicKey(privateKey: Uint8Array): Uint8Array`
  - `generateX25519KeyPair(): X25519KeyPair`
  - `x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array`

- [ ] **Step 1: Write the failing test**

The golden vector freezes §6.2 and §7.1 derivation for Project 2, whose real passkey PRF path must reproduce these bytes from the same PRF output.

`packages/crypto/test/derive.test.ts`:
```ts
import fc from "fast-check"
import { sha256 } from "@noble/hashes/sha2.js"
import { utf8ToBytes } from "@noble/hashes/utils.js"
import { describe, expect, it } from "vitest"
import { isMidaError, namespaceId } from "@mida/protocol"
import {
  ISOLATION_DOMAINS,
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  generateX25519KeyPair,
  hexOf,
  prfSalt,
  uint64be,
  x25519PublicKey,
  x25519SharedSecret,
} from "@mida/crypto"

const failsWith = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const fakePrf = (fill: number) => new Uint8Array(32).fill(fill)
const career = namespaceId("goals.career")

const GOLDEN = {
  secret: "0x7bcd44384f94f98a5965ddec021c122212b41476bb5d9cd37efe446c6436307b",
  epoch1PrivateKey: "0xf5e549e7d4c9795b5d1bd798ba4acc22f96ad6037e011eea754a6dc9e9c58fc9",
  epoch1PublicKey: "0x547957f9bd11b33c378ad167350504e5becae07799e30b26d85601c83664fd0c",
  epoch2PublicKey: "0x1026462a273c38ccf967091089aff0deaf421f5f53e46437fabfa970240e7e4e",
}

describe("PRF isolation domains (§6.1)", () => {
  it("salts are SHA256 of the frozen domain strings", () => {
    expect(ISOLATION_DOMAINS).toEqual(["general", "financial", "relationships", "private"])
    for (const domain of ISOLATION_DOMAINS) {
      expect(prfSalt(domain)).toEqual(sha256(utf8ToBytes(`mida/context/prf/${domain}/v1`)))
    }
    expect(new Set(ISOLATION_DOMAINS.map((d) => hexOf(prfSalt(d)))).size).toBe(4)
  })

  it("different domain PRF outputs derive unrelated namespace secrets", () => {
    const general = deriveNamespaceSecret(fakePrf(0x01), namespaceId("financial.preferences"))
    const financial = deriveNamespaceSecret(fakePrf(0x02), namespaceId("financial.preferences"))
    expect(hexOf(general)).not.toBe(hexOf(financial))
  })
})

describe("namespace secrets and epoch keypairs (§6.2, §7.1)", () => {
  it("matches the frozen golden vector (PRF output = 32 bytes of 0x42, goals.career)", () => {
    const secret = deriveNamespaceSecret(fakePrf(0x42), career)
    const epoch1 = deriveEpochKeyPair(secret, 1n)
    expect(hexOf(secret)).toBe(GOLDEN.secret)
    expect(hexOf(epoch1.privateKey)).toBe(GOLDEN.epoch1PrivateKey)
    expect(hexOf(epoch1.publicKey)).toBe(GOLDEN.epoch1PublicKey)
    expect(hexOf(deriveEpochKeyPair(secret, 2n).publicKey)).toBe(GOLDEN.epoch2PublicKey)
  })

  it("is deterministic across fresh derivations (recovery seam)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.bigInt({ min: 1n, max: 1000n }), (prf, epoch) => {
        fc.pre(prf.some((b) => b !== 0))
        const first = deriveEpochKeyPair(deriveNamespaceSecret(prf, career), epoch)
        const second = deriveEpochKeyPair(deriveNamespaceSecret(prf.slice(), career), epoch)
        expect(hexOf(second.publicKey)).toBe(hexOf(first.publicKey))
      }),
      { numRuns: 50 },
    )
  })

  it("separates namespaces and epochs", () => {
    const prf = fakePrf(0x42)
    const careerSecret = deriveNamespaceSecret(prf, career)
    const learningSecret = deriveNamespaceSecret(prf, namespaceId("goals.learning"))
    expect(hexOf(careerSecret)).not.toBe(hexOf(learningSecret))
    expect(hexOf(deriveEpochKeyPair(careerSecret, 1n).publicKey)).not.toBe(hexOf(deriveEpochKeyPair(careerSecret, 2n).publicKey))
  })

  it("encodes the epoch salt as 8-byte big-endian uint64", () => {
    expect(uint64be(1n)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]))
    expect(uint64be(258n)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 1, 2]))
    expect(failsWith("INVALID_WIRE", () => uint64be(-1n))).toBe(true)
  })

  it("rejects zero inputs and epoch 0", () => {
    expect(failsWith("ZERO_KEY", () => deriveNamespaceSecret(new Uint8Array(32), career))).toBe(true)
    expect(failsWith("ZERO_KEY", () => deriveNamespaceSecret(new Uint8Array(16).fill(1), career))).toBe(true)
    expect(failsWith("ZERO_KEY", () => deriveEpochKeyPair(new Uint8Array(32), 1n))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => deriveEpochKeyPair(fakePrf(9), 0n))).toBe(true)
  })
})

describe("X25519 zero checks (§7.1)", () => {
  it("agrees on a shared secret between two parties", () => {
    const a = generateX25519KeyPair()
    const b = generateX25519KeyPair()
    expect(hexOf(x25519SharedSecret(a.privateKey, b.publicKey))).toBe(hexOf(x25519SharedSecret(b.privateKey, a.publicKey)))
    expect(hexOf(x25519PublicKey(a.privateKey))).toBe(hexOf(a.publicKey))
  })

  it("rejects an all-zero public key before calling the curve", () => {
    expect(failsWith("ZERO_KEY", () => x25519SharedSecret(generateX25519KeyPair().privateKey, new Uint8Array(32)))).toBe(true)
  })

  it("maps a low-order public key (all-zero shared secret) to ZERO_KEY", () => {
    const lowOrder = new Uint8Array(32)
    lowOrder[0] = 1
    expect(failsWith("ZERO_KEY", () => x25519SharedSecret(generateX25519KeyPair().privateKey, lowOrder))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/crypto/test/derive.test.ts`
Expected: FAIL — Vitest cannot resolve `@mida/crypto`, because the package does not exist yet.

- [ ] **Step 3: Create the package**

`packages/crypto/package.json`:
```json
{
  "name": "@mida/crypto",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@mida/protocol": "workspace:*",
    "@noble/ciphers": "2.4.0",
    "@noble/curves": "2.4.0",
    "@noble/hashes": "2.4.0",
    "viem": "2.56.3"
  }
}
```

Add to the root `package.json` `dependencies`:
```json
    "@mida/crypto": "workspace:*"
```

- [ ] **Step 4: Implement `bytes.ts`**

`packages/crypto/src/bytes.ts`:
```ts
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { MidaError, assertHex, isZeroBytes } from "@mida/protocol"
import type { Hex } from "@mida/protocol"

export function hexOf(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}` as Hex
}

export function bytesOf(hex: string, byteLength: number): Uint8Array {
  return hexToBytes(assertHex(hex, byteLength).slice(2))
}

export function assertNonZeroKey(bytes: Uint8Array, label: string): void {
  if (bytes.length !== 32 || isZeroBytes(bytes)) {
    throw new MidaError("ZERO_KEY", `${label} must be 32 non-zero bytes`)
  }
}
```

- [ ] **Step 5: Implement `derive.ts`**

`packages/crypto/src/derive.ts`:
```ts
import { x25519 } from "@noble/curves/ed25519.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { utf8ToBytes } from "@noble/hashes/utils.js"
import { MidaError, encodeUint64, isZeroBytes } from "@mida/protocol"
import type { Hex, IsolationDomain } from "@mida/protocol"
import { assertNonZeroKey, bytesOf } from "./bytes.js"

export const ISOLATION_DOMAINS: readonly IsolationDomain[] = ["general", "financial", "relationships", "private"]

const NAMESPACE_SECRET_INFO = utf8ToBytes("mida/context/namespace-secret/v1")
const READ_EPOCH_INFO = utf8ToBytes("mida/context/read-epoch/x25519/v1")

/** §6.1: SHA256(UTF8("mida/context/prf/<domain>/v1")). */
export function prfSalt(domain: IsolationDomain): Uint8Array {
  return sha256(utf8ToBytes(`mida/context/prf/${domain}/v1`))
}

/** §6.2: HKDF-SHA256(ikm = PRF_D, salt = namespaceId, info, 32). */
export function deriveNamespaceSecret(domainPrfOutput: Uint8Array, namespaceId: Hex): Uint8Array {
  assertNonZeroKey(domainPrfOutput, "PRF output")
  return hkdf(sha256, domainPrfOutput, bytesOf(namespaceId, 32), NAMESPACE_SECRET_INFO, 32)
}

export function uint64be(value: bigint): Uint8Array {
  encodeUint64(value)
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, false)
  return out
}

export interface X25519KeyPair {
  privateKey: Uint8Array
  publicKey: Uint8Array
}

export interface EpochKeyPair extends X25519KeyPair {
  readEpoch: bigint
}

/** §7.1: epochSeed = HKDF-SHA256(namespaceSecret, uint64be(readEpoch), info, 32); noble clamps the scalar. */
export function deriveEpochKeyPair(namespaceSecret: Uint8Array, readEpoch: bigint): EpochKeyPair {
  assertNonZeroKey(namespaceSecret, "namespace secret")
  if (readEpoch < 1n) {
    throw new MidaError("INVALID_WIRE", "read epochs start at 1")
  }
  const privateKey = hkdf(sha256, namespaceSecret, uint64be(readEpoch), READ_EPOCH_INFO, 32)
  const publicKey = x25519.getPublicKey(privateKey)
  assertNonZeroKey(publicKey, "epoch public key")
  return { readEpoch, privateKey, publicKey }
}

export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  assertNonZeroKey(privateKey, "X25519 private key")
  return x25519.getPublicKey(privateKey)
}

export function generateX25519KeyPair(): X25519KeyPair {
  const privateKey = x25519.utils.randomSecretKey()
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

/** §7.1: reject an all-zero public key or shared secret before any HKDF. */
export function x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  assertNonZeroKey(privateKey, "X25519 private key")
  assertNonZeroKey(publicKey, "X25519 public key")
  let shared: Uint8Array
  try {
    shared = x25519.getSharedSecret(privateKey, publicKey)
  } catch {
    throw new MidaError("ZERO_KEY", "X25519 rejected a low-order public key")
  }
  if (isZeroBytes(shared)) {
    throw new MidaError("ZERO_KEY", "X25519 shared secret is all zero")
  }
  return shared
}
```

- [ ] **Step 6: Export**

`packages/crypto/src/index.ts`:
```ts
export * from "./bytes.js"
export * from "./derive.js"
```

- [ ] **Step 7: Run to verify it passes**

Run:
```bash
pnpm install
pnpm vitest run packages/crypto
pnpm typecheck
```
Expected: 10 tests PASS. Typecheck exits 0. If the golden-vector test fails, stop: do not edit the expected values. A mismatch means the derivation differs from §6.2/§7.1, and Project 2 recovery would silently break.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml packages/crypto
git commit -m "feat(crypto): PRF domain salts, namespace secrets and asymmetric read-epoch keys

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 7: Payload encryption with bound AAD

**Files:**
- Create: `packages/crypto/src/aead.ts`, `packages/crypto/src/payload.ts`
- Modify: `packages/crypto/src/index.ts`
- Test: `packages/crypto/test/payload.test.ts`

**Interfaces:**
- Consumes: `MidaError`, `canonicalBytes`, `canonicalJson`, `CRYPTO_VERSION`, `MAX_PAYLOAD_BYTES`, `type ContextPayload`, `type Address`, `type Hex` (Tasks 2–3); `namespaceId` (Task 4, tests only); `hexOf` (Task 6).
- Produces:
  - `KEY_BYTES = 32`, `NONCE_BYTES = 24`, `TAG_BYTES = 16`
  - `seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array`
  - `open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array` — throws `DECRYPT_FAILED`
  - `interface ObjectBinding { chainId: bigint; contextRegistry: Address; contextId: Hex; namespaceId: Hex; readEpoch: bigint }`
  - `payloadAad(binding: ObjectBinding): Uint8Array`
  - `epochDekWrapAad(binding: ObjectBinding): Uint8Array`
  - `encodePayload(payload: ContextPayload): Uint8Array` — throws `PAYLOAD_TOO_LARGE`
  - `decodePayload(bytes: Uint8Array): ContextPayload` — throws `INVALID_WIRE`
  - `interface EncryptedPayload { ciphertext: Uint8Array; nonce: Uint8Array; dek: Uint8Array }`
  - `encryptPayload(payload: ContextPayload, binding: ObjectBinding): EncryptedPayload`
  - `decryptPayload(encrypted: EncryptedPayload, binding: ObjectBinding): ContextPayload`

- [ ] **Step 1: Write the failing test**

The layout test hand-builds the ABI bytes word by word, independently of viem, so it checks types and field order.

`packages/crypto/test/payload.test.ts`:
```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { encodeAbiParameters, toHex } from "viem"
import type { Hex } from "viem"
import { isMidaError, namespaceId } from "@mida/protocol"
import type { ContextPayload } from "@mida/protocol"
import { decodePayload, decryptPayload, encodePayload, encryptPayload, epochDekWrapAad, hexOf, payloadAad } from "@mida/crypto"
import type { ObjectBinding } from "@mida/crypto"

const failsWith = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const uint = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0")
const word = (hex: string) => hex.slice(2).padStart(64, "0")
const stringTail = (value: string) => {
  const hex = Buffer.from(value, "utf8").toString("hex")
  return uint(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")
}

const binding: ObjectBinding = {
  chainId: 31337n,
  contextRegistry: "0x3333333333333333333333333333333333333333",
  contextId: `0x${"cc".repeat(32)}`,
  namespaceId: namespaceId("goals.career"),
  readEpoch: 1n,
}

const payload: ContextPayload = {
  v: 1,
  value: "Prioritize systems engineering",
  kind: "GOAL",
  provenance: { source: "USER_ASSERTED" },
}

describe("payload AAD layout (§8.2, plan decision 2)", () => {
  it("is abi.encode(string, uint256, address, bytes32, bytes32, uint64, string)", () => {
    const tag = stringTail("MIDA_CONTEXT_PAYLOAD_V1")
    const head = [
      uint(7 * 32),
      uint(binding.chainId),
      word(binding.contextRegistry),
      word(binding.contextId),
      word(binding.namespaceId),
      uint(binding.readEpoch),
      uint(7 * 32 + tag.length / 2),
    ]
    const expected = `0x${head.join("")}${tag}${stringTail("mida-crypto-v1")}`
    expect(hexOf(payloadAad(binding))).toBe(expected)
  })

  it("payload and epoch-DEK-wrap AADs differ only by tag", () => {
    const types = [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "string" }] as const
    const values = (tag: string) => [tag, binding.chainId, binding.contextRegistry, binding.contextId, binding.namespaceId, binding.readEpoch, "mida-crypto-v1"] as const
    expect(hexOf(epochDekWrapAad(binding))).toBe(encodeAbiParameters(types, values("MIDA_EPOCH_DEK_WRAP_V1")))
    expect(hexOf(payloadAad(binding))).not.toBe(hexOf(epochDekWrapAad(binding)))
  })
})

describe("payload encoding", () => {
  it("is canonical JSON and round-trips", () => {
    const reordered = { provenance: { source: "USER_ASSERTED" }, kind: "GOAL", value: payload.value, v: 1 } as ContextPayload
    expect(toHex(encodePayload(reordered))).toBe(toHex(encodePayload(payload)))
    expect(decodePayload(encodePayload(payload))).toEqual(payload)
  })

  it("caps the plaintext at 65,536 bytes", () => {
    const base = encodePayload({ ...payload, value: "" }).length
    expect(encodePayload({ ...payload, value: "x".repeat(65_536 - base) }).length).toBe(65_536)
    expect(failsWith("PAYLOAD_TOO_LARGE", () => encodePayload({ ...payload, value: "x".repeat(65_537 - base) }))).toBe(true)
  })

  it("rejects non-canonical, non-JSON and non-UTF-8 plaintext", () => {
    expect(failsWith("INVALID_WIRE", () => decodePayload(new TextEncoder().encode('{"v":1, "kind":"GOAL"}')))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => decodePayload(new TextEncoder().encode("not json")))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => decodePayload(new Uint8Array([0xff, 0xfe])))).toBe(true)
  })
})

describe("payload encryption (§8.2)", () => {
  it("decrypts with the same DEK and binding", () => {
    const sealed = encryptPayload(payload, binding)
    expect(sealed.dek).toHaveLength(32)
    expect(sealed.nonce).toHaveLength(24)
    expect(decryptPayload(sealed, binding)).toEqual(payload)
  })

  it("uses a fresh DEK and nonce every time", () => {
    const first = encryptPayload(payload, binding)
    const second = encryptPayload(payload, binding)
    expect(hexOf(first.dek)).not.toBe(hexOf(second.dek))
    expect(hexOf(first.nonce)).not.toBe(hexOf(second.nonce))
  })

  it("fails closed when any bound field changes", () => {
    const sealed = encryptPayload(payload, binding)
    const other: Hex = `0x${"dd".repeat(32)}`
    const variants: ObjectBinding[] = [
      { ...binding, chainId: 10143n },
      { ...binding, contextRegistry: "0x4444444444444444444444444444444444444444" },
      { ...binding, contextId: other },
      { ...binding, namespaceId: namespaceId("goals.learning") },
      { ...binding, readEpoch: 2n },
    ]
    for (const variant of variants) {
      expect(failsWith("DECRYPT_FAILED", () => decryptPayload(sealed, variant))).toBe(true)
    }
  })

  it("detects any single-bit ciphertext mutation", () => {
    const sealed = encryptPayload(payload, binding)
    fc.assert(
      fc.property(fc.nat({ max: sealed.ciphertext.length * 8 - 1 }), (bit) => {
        const mutated = sealed.ciphertext.slice()
        mutated[bit >> 3]! ^= 1 << (bit & 7)
        expect(failsWith("DECRYPT_FAILED", () => decryptPayload({ ...sealed, ciphertext: mutated }, binding))).toBe(true)
      }),
      { numRuns: 100 },
    )
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/crypto/test/payload.test.ts`
Expected: FAIL — `payloadAad` (and the other payload names) are not exported by `@mida/crypto`.

- [ ] **Step 3: Implement `aead.ts`**

`packages/crypto/src/aead.ts`:
```ts
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import { MidaError } from "@mida/protocol"

export const KEY_BYTES = 32
export const NONCE_BYTES = 24
export const TAG_BYTES = 16

function checkSizes(key: Uint8Array, nonce: Uint8Array): void {
  if (key.length !== KEY_BYTES || nonce.length !== NONCE_BYTES) {
    throw new MidaError("INVALID_WIRE", "XChaCha20-Poly1305 needs a 32-byte key and 24-byte nonce")
  }
}

export function seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  checkSizes(key, nonce)
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext)
}

export function open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  checkSizes(key, nonce)
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext)
  } catch {
    throw new MidaError("DECRYPT_FAILED", "authentication failed")
  }
}
```

- [ ] **Step 4: Implement `payload.ts`**

`packages/crypto/src/payload.ts`:
```ts
import { randomBytes } from "@noble/hashes/utils.js"
import { encodeAbiParameters, hexToBytes } from "viem"
import { CRYPTO_VERSION, MAX_PAYLOAD_BYTES, MidaError, canonicalBytes, canonicalJson } from "@mida/protocol"
import type { Address, ContextPayload, Hex } from "@mida/protocol"
import { KEY_BYTES, NONCE_BYTES, open, seal } from "./aead.js"

/** Values every object-level AAD binds (§8.2, §8.3). */
export interface ObjectBinding {
  chainId: bigint
  contextRegistry: Address
  contextId: Hex
  namespaceId: Hex
  readEpoch: bigint
}

const OBJECT_AAD_TYPES = [
  { type: "string" },
  { type: "uint256" },
  { type: "address" },
  { type: "bytes32" },
  { type: "bytes32" },
  { type: "uint64" },
  { type: "string" },
] as const

function objectAad(tag: string, binding: ObjectBinding): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(OBJECT_AAD_TYPES, [
      tag,
      binding.chainId,
      binding.contextRegistry,
      binding.contextId,
      binding.namespaceId,
      binding.readEpoch,
      CRYPTO_VERSION,
    ]),
  )
}

export function payloadAad(binding: ObjectBinding): Uint8Array {
  return objectAad("MIDA_CONTEXT_PAYLOAD_V1", binding)
}

export function epochDekWrapAad(binding: ObjectBinding): Uint8Array {
  return objectAad("MIDA_EPOCH_DEK_WRAP_V1", binding)
}

export function encodePayload(payload: ContextPayload): Uint8Array {
  const bytes = canonicalBytes(payload)
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new MidaError("PAYLOAD_TOO_LARGE", `${bytes.length} bytes exceeds ${MAX_PAYLOAD_BYTES}`)
  }
  return bytes
}

export function decodePayload(bytes: Uint8Array): ContextPayload {
  let text: string
  let parsed: ContextPayload
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    parsed = JSON.parse(text) as ContextPayload
  } catch {
    throw new MidaError("INVALID_WIRE", "payload is not UTF-8 JSON")
  }
  if (parsed === null || typeof parsed !== "object" || canonicalJson(parsed) !== text || parsed.v !== 1) {
    throw new MidaError("INVALID_WIRE", "payload is not canonical v1 JSON")
  }
  return parsed
}

export interface EncryptedPayload {
  ciphertext: Uint8Array
  nonce: Uint8Array
  dek: Uint8Array
}

/** §8.2: fresh random DEK and nonce for every object. */
export function encryptPayload(payload: ContextPayload, binding: ObjectBinding): EncryptedPayload {
  const plaintext = encodePayload(payload)
  const dek = randomBytes(KEY_BYTES)
  const nonce = randomBytes(NONCE_BYTES)
  return { ciphertext: seal(dek, nonce, payloadAad(binding), plaintext), nonce, dek }
}

export function decryptPayload(encrypted: EncryptedPayload, binding: ObjectBinding): ContextPayload {
  return decodePayload(open(encrypted.dek, encrypted.nonce, payloadAad(binding), encrypted.ciphertext))
}
```

- [ ] **Step 5: Export**

Append to `packages/crypto/src/index.ts`:
```ts
export * from "./aead.js"
export * from "./payload.js"
```

- [ ] **Step 6: Run to verify it passes**

Run:
```bash
pnpm vitest run packages/crypto
pnpm typecheck
```
Expected: all crypto tests PASS (10 from Task 6 plus 9 here). Typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/crypto
git commit -m "feat(crypto): XChaCha20-Poly1305 payload encryption with ABI-bound AAD

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 8: Epoch DEK wraps and reader epoch wraps

**Files:**
- Create: `packages/crypto/src/wraps.ts`
- Modify: `packages/crypto/src/index.ts`
- Test: `packages/crypto/test/wraps.test.ts`

**Interfaces:**
- Consumes: `MidaError`, `CRYPTO_VERSION`, `encodeUint64`, `decodeUint64`, `type EpochDEKWrap`, `type ReaderEpochWrap`, `type Address`, `type Hex` (Tasks 2–3); `namespaceId` (Task 4, tests only); `hexOf`, `bytesOf`, `generateX25519KeyPair`, `x25519SharedSecret`, `deriveNamespaceSecret`, `deriveEpochKeyPair` (Task 6); `seal`, `open`, `KEY_BYTES`, `NONCE_BYTES`, `TAG_BYTES`, `epochDekWrapAad`, `type ObjectBinding` (Task 7).
- Produces:
  - `wrapDekToEpoch(input: { dek: Uint8Array; epochPublicKey: Uint8Array; binding: ObjectBinding }): EpochDEKWrap`
  - `unwrapDekFromEpoch(input: { wrap: EpochDEKWrap; epochPrivateKey: Uint8Array; binding: ObjectBinding }): Uint8Array`
  - `interface ReaderBinding { chainId: bigint; capabilityRegistry: Address; owner: Address; namespaceId: Hex; readEpoch: bigint; agentId: Hex; agentKeyVersion: number }`
  - `readerEpochWrapAad(binding: ReaderBinding): Uint8Array`
  - `wrapEpochPrivateKeyToAgent(input: { epochPrivateKey: Uint8Array; agentEncryptionPublicKey: Uint8Array; binding: ReaderBinding; createdAt: bigint }): ReaderEpochWrap`
  - `unwrapEpochPrivateKey(input: { wrap: ReaderEpochWrap; agentEncryptionPrivateKey: Uint8Array; binding: ReaderBinding }): Uint8Array` — throws `WRAP_KEY_VERSION_MISMATCH` or `DECRYPT_FAILED`

These two functions are the whole CREATE-versus-READ split in §7.1. A writer calls `wrapDekToEpoch` with only the public epoch key. Only a holder of the epoch private key can call `unwrapDekFromEpoch`. The Vault is the only caller of `wrapEpochPrivateKeyToAgent`.

- [ ] **Step 1: Write the failing test**

`packages/crypto/test/wraps.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { encodeAbiParameters } from "viem"
import type { Hex } from "viem"
import { isMidaError, namespaceId } from "@mida/protocol"
import {
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  generateX25519KeyPair,
  hexOf,
  readerEpochWrapAad,
  unwrapDekFromEpoch,
  unwrapEpochPrivateKey,
  wrapDekToEpoch,
  wrapEpochPrivateKeyToAgent,
} from "@mida/crypto"
import type { ObjectBinding, ReaderBinding } from "@mida/crypto"

const failsWith = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const career = namespaceId("goals.career")
const secret = deriveNamespaceSecret(new Uint8Array(32).fill(0x42), career)
const epoch1 = deriveEpochKeyPair(secret, 1n)
const epoch2 = deriveEpochKeyPair(secret, 2n)
const dek = new Uint8Array(32).fill(0x07)

const objectBinding: ObjectBinding = {
  chainId: 31337n,
  contextRegistry: "0x3333333333333333333333333333333333333333",
  contextId: `0x${"cc".repeat(32)}`,
  namespaceId: career,
  readEpoch: 1n,
}

const agentA = generateX25519KeyPair()
const agentB = generateX25519KeyPair()
const readerBinding: ReaderBinding = {
  chainId: 31337n,
  capabilityRegistry: "0x1111111111111111111111111111111111111111",
  owner: "0x2222222222222222222222222222222222222222",
  namespaceId: career,
  readEpoch: 1n,
  agentId: `0x${"aa".repeat(32)}`,
  agentKeyVersion: 1,
}

describe("epoch DEK wrap (§8.3)", () => {
  it("round-trips with the matching epoch private key", () => {
    const wrap = wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: objectBinding })
    expect(wrap.readEpoch).toBe("1")
    expect(wrap.wrappedDek.length).toBe(2 + 48 * 2)
    expect(unwrapDekFromEpoch({ wrap, epochPrivateKey: epoch1.privateKey, binding: objectBinding })).toEqual(dek)
  })

  it("cannot be opened with another epoch's private key", () => {
    const wrap = wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: objectBinding })
    expect(failsWith("DECRYPT_FAILED", () => unwrapDekFromEpoch({ wrap, epochPrivateKey: epoch2.privateKey, binding: objectBinding }))).toBe(true)
  })

  it("cannot be opened with a different namespace secret", () => {
    const wrap = wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: objectBinding })
    const stranger = deriveEpochKeyPair(deriveNamespaceSecret(new Uint8Array(32).fill(0x43), career), 1n)
    expect(failsWith("DECRYPT_FAILED", () => unwrapDekFromEpoch({ wrap, epochPrivateKey: stranger.privateKey, binding: objectBinding }))).toBe(true)
  })

  it("cannot be transplanted to another object, even with rewritten metadata", () => {
    const wrap = wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: objectBinding })
    const otherObject: ObjectBinding = { ...objectBinding, contextId: `0x${"dd".repeat(32)}` }
    expect(failsWith("DECRYPT_FAILED", () => unwrapDekFromEpoch({ wrap, epochPrivateKey: epoch1.privateKey, binding: otherObject }))).toBe(true)
    const rewritten = { ...wrap, contextId: otherObject.contextId }
    expect(failsWith("DECRYPT_FAILED", () => unwrapDekFromEpoch({ wrap: rewritten, epochPrivateKey: epoch1.privateKey, binding: otherObject }))).toBe(true)
  })

  it("rejects malformed wrap fields", () => {
    const wrap = wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: objectBinding })
    expect(failsWith("INVALID_WIRE", () => unwrapDekFromEpoch({ wrap: { ...wrap, nonce: "0x00" as Hex }, epochPrivateKey: epoch1.privateKey, binding: objectBinding }))).toBe(true)
    expect(failsWith("ZERO_KEY", () => unwrapDekFromEpoch({ wrap: { ...wrap, ephemeralPublicKey: `0x${"00".repeat(32)}` }, epochPrivateKey: epoch1.privateKey, binding: objectBinding }))).toBe(true)
  })
})

describe("reader epoch wrap (§8.4)", () => {
  it("AAD is abi.encode(string, uint256, address, address, bytes32, uint64, bytes32, uint32, string)", () => {
    const expected = encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint32" }, { type: "string" }],
      ["MIDA_READER_EPOCH_WRAP_V1", 31337n, readerBinding.capabilityRegistry, readerBinding.owner, career, 1n, readerBinding.agentId, 1, "mida-crypto-v1"],
    )
    expect(hexOf(readerEpochWrapAad(readerBinding))).toBe(expected)
  })

  it("the registered agent key and version unwrap the epoch private key", () => {
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1_757_000_000n })
    expect(wrap.createdAt).toBe("1757000000")
    const recovered = unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentA.privateKey, binding: readerBinding })
    expect(hexOf(recovered)).toBe(hexOf(epoch1.privateKey))
  })

  it("a different agent's key cannot unwrap it", () => {
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1n })
    expect(failsWith("DECRYPT_FAILED", () => unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentB.privateKey, binding: readerBinding }))).toBe(true)
  })

  it("cannot be transplanted to another agent id", () => {
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1n })
    const otherAgent: ReaderBinding = { ...readerBinding, agentId: `0x${"bb".repeat(32)}` }
    expect(failsWith("DECRYPT_FAILED", () => unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentA.privateKey, binding: otherAgent }))).toBe(true)
    expect(failsWith("DECRYPT_FAILED", () => unwrapEpochPrivateKey({ wrap: { ...wrap, agentId: otherAgent.agentId }, agentEncryptionPrivateKey: agentA.privateKey, binding: otherAgent }))).toBe(true)
  })

  it("cannot be transplanted to another key version", () => {
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1n })
    const rotated: ReaderBinding = { ...readerBinding, agentKeyVersion: 2 }
    expect(failsWith("WRAP_KEY_VERSION_MISMATCH", () => unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentA.privateKey, binding: rotated }))).toBe(true)
    expect(failsWith("DECRYPT_FAILED", () => unwrapEpochPrivateKey({ wrap: { ...wrap, agentKeyVersion: 2 }, agentEncryptionPrivateKey: agentA.privateKey, binding: rotated }))).toBe(true)
  })

  it("cannot be replayed for another owner, namespace, epoch or registry", () => {
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1n })
    const variants: ReaderBinding[] = [
      { ...readerBinding, owner: "0x5555555555555555555555555555555555555555" },
      { ...readerBinding, namespaceId: namespaceId("goals.learning") },
      { ...readerBinding, readEpoch: 2n },
      { ...readerBinding, capabilityRegistry: "0x6666666666666666666666666666666666666666" },
    ]
    for (const variant of variants) {
      expect(failsWith("DECRYPT_FAILED", () => unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentA.privateKey, binding: variant }))).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/crypto/test/wraps.test.ts`
Expected: FAIL — `wrapDekToEpoch` (and the other wrap names) are not exported by `@mida/crypto`.

- [ ] **Step 3: Implement `wraps.ts`**

`packages/crypto/src/wraps.ts`:
```ts
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { encodeAbiParameters, hexToBytes } from "viem"
import { CRYPTO_VERSION, MidaError, decodeUint64, encodeUint64 } from "@mida/protocol"
import type { Address, EpochDEKWrap, Hex, ReaderEpochWrap } from "@mida/protocol"
import { KEY_BYTES, NONCE_BYTES, TAG_BYTES, open, seal } from "./aead.js"
import { bytesOf, hexOf } from "./bytes.js"
import { generateX25519KeyPair, x25519SharedSecret } from "./derive.js"
import { epochDekWrapAad } from "./payload.js"
import type { ObjectBinding } from "./payload.js"

const EPOCH_DEK_WRAP_INFO = utf8ToBytes("mida/context/epoch-dek-wrap/v1")
const READER_EPOCH_WRAP_INFO = utf8ToBytes("mida/context/reader-epoch-wrap/v1")
const WRAPPED_KEY_BYTES = KEY_BYTES + TAG_BYTES

function kek(sharedSecret: Uint8Array, salt: Hex, info: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, bytesOf(salt, 32), info, 32)
}

/** §8.3: wrap an object DEK to the namespace epoch public key. */
export function wrapDekToEpoch(input: { dek: Uint8Array; epochPublicKey: Uint8Array; binding: ObjectBinding }): EpochDEKWrap {
  const ephemeral = generateX25519KeyPair()
  const shared = x25519SharedSecret(ephemeral.privateKey, input.epochPublicKey)
  const nonce = randomBytes(NONCE_BYTES)
  const wrapped = seal(kek(shared, input.binding.contextId, EPOCH_DEK_WRAP_INFO), nonce, epochDekWrapAad(input.binding), input.dek)
  return {
    v: 1,
    contextId: input.binding.contextId,
    namespaceId: input.binding.namespaceId,
    readEpoch: encodeUint64(input.binding.readEpoch),
    ephemeralPublicKey: hexOf(ephemeral.publicKey),
    nonce: hexOf(nonce),
    wrappedDek: hexOf(wrapped),
  }
}

export function unwrapDekFromEpoch(input: { wrap: EpochDEKWrap; epochPrivateKey: Uint8Array; binding: ObjectBinding }): Uint8Array {
  const { wrap, binding } = input
  if (
    wrap.v !== 1 ||
    wrap.contextId !== binding.contextId ||
    wrap.namespaceId !== binding.namespaceId ||
    decodeUint64(wrap.readEpoch) !== binding.readEpoch
  ) {
    throw new MidaError("DECRYPT_FAILED", "epoch DEK wrap does not belong to this object")
  }
  const shared = x25519SharedSecret(input.epochPrivateKey, bytesOf(wrap.ephemeralPublicKey, 32))
  return open(
    kek(shared, binding.contextId, EPOCH_DEK_WRAP_INFO),
    bytesOf(wrap.nonce, NONCE_BYTES),
    epochDekWrapAad(binding),
    bytesOf(wrap.wrappedDek, WRAPPED_KEY_BYTES),
  )
}

/** Values the reader-wrap AAD binds (§8.4). */
export interface ReaderBinding {
  chainId: bigint
  capabilityRegistry: Address
  owner: Address
  namespaceId: Hex
  readEpoch: bigint
  agentId: Hex
  agentKeyVersion: number
}

export function readerEpochWrapAad(binding: ReaderBinding): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "uint32" },
        { type: "string" },
      ],
      [
        "MIDA_READER_EPOCH_WRAP_V1",
        binding.chainId,
        binding.capabilityRegistry,
        binding.owner,
        binding.namespaceId,
        binding.readEpoch,
        binding.agentId,
        binding.agentKeyVersion,
        CRYPTO_VERSION,
      ],
    ),
  )
}

/** §8.4: wrap an epoch private key to one agent's registered X25519 key and version. */
export function wrapEpochPrivateKeyToAgent(input: {
  epochPrivateKey: Uint8Array
  agentEncryptionPublicKey: Uint8Array
  binding: ReaderBinding
  createdAt: bigint
}): ReaderEpochWrap {
  const ephemeral = generateX25519KeyPair()
  const shared = x25519SharedSecret(ephemeral.privateKey, input.agentEncryptionPublicKey)
  const nonce = randomBytes(NONCE_BYTES)
  const wrapped = seal(
    kek(shared, input.binding.namespaceId, READER_EPOCH_WRAP_INFO),
    nonce,
    readerEpochWrapAad(input.binding),
    input.epochPrivateKey,
  )
  return {
    v: 1,
    owner: input.binding.owner,
    namespaceId: input.binding.namespaceId,
    readEpoch: encodeUint64(input.binding.readEpoch),
    agentId: input.binding.agentId,
    agentKeyVersion: input.binding.agentKeyVersion,
    ephemeralPublicKey: hexOf(ephemeral.publicKey),
    nonce: hexOf(nonce),
    wrappedEpochPrivateKey: hexOf(wrapped),
    createdAt: encodeUint64(input.createdAt),
  }
}

export function unwrapEpochPrivateKey(input: {
  wrap: ReaderEpochWrap
  agentEncryptionPrivateKey: Uint8Array
  binding: ReaderBinding
}): Uint8Array {
  const { wrap, binding } = input
  if (wrap.agentKeyVersion !== binding.agentKeyVersion) {
    throw new MidaError("WRAP_KEY_VERSION_MISMATCH", "wrap targets a different agent encryption key version")
  }
  if (
    wrap.v !== 1 ||
    wrap.owner.toLowerCase() !== binding.owner.toLowerCase() ||
    wrap.namespaceId !== binding.namespaceId ||
    wrap.agentId !== binding.agentId ||
    decodeUint64(wrap.readEpoch) !== binding.readEpoch
  ) {
    throw new MidaError("DECRYPT_FAILED", "reader wrap does not match this owner, namespace, epoch and agent")
  }
  const shared = x25519SharedSecret(input.agentEncryptionPrivateKey, bytesOf(wrap.ephemeralPublicKey, 32))
  return open(
    kek(shared, binding.namespaceId, READER_EPOCH_WRAP_INFO),
    bytesOf(wrap.nonce, NONCE_BYTES),
    readerEpochWrapAad(binding),
    bytesOf(wrap.wrappedEpochPrivateKey, WRAPPED_KEY_BYTES),
  )
}
```

- [ ] **Step 4: Export**

Append to `packages/crypto/src/index.ts`:
```ts
export * from "./wraps.js"
```

- [ ] **Step 5: Run to verify it passes**

Run:
```bash
pnpm vitest run packages/crypto
pnpm typecheck
```
Expected: all crypto tests PASS (Tasks 6–7 plus 11 here). Typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/crypto
git commit -m "feat(crypto): epoch DEK wraps and agent-bound reader epoch wraps

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 9: Object manifests and content-addressed storage

**Files:**
- Create: `packages/crypto/src/object.ts`
- Modify: `packages/crypto/src/index.ts`
- Create: `packages/storage/package.json`, `packages/storage/src/index.ts`
- Modify: root `package.json` (add `"@mida/storage": "workspace:*"` under `dependencies`)
- Test: `packages/crypto/test/object.test.ts`, `packages/storage/test/storage.test.ts`

**Interfaces:**
- Consumes: `MidaError`, `CRYPTO_VERSION`, `canonicalBytes`, `encodeUint64`, `decodeUint64`, `assertHex`, `type ObjectManifest`, `type EpochDEKWrap`, `type ContextPayload`, `type StorageRef`, `type Hex` (Tasks 2–3); `namespaceId` (Task 4, tests only); `hexOf`, `bytesOf`, `deriveNamespaceSecret`, `deriveEpochKeyPair`, `generateX25519KeyPair` (Task 6); `NONCE_BYTES`, `encryptPayload`, `decryptPayload`, `type ObjectBinding` (Task 7); `wrapDekToEpoch`, `unwrapDekFromEpoch`, `wrapEpochPrivateKeyToAgent`, `unwrapEpochPrivateKey` (Task 8).
- Produces, in `@mida/crypto`:
  - `ciphertextHash(ciphertext: Uint8Array): Hex` — SHA-256
  - `manifestHash(manifest: ObjectManifest): Hex` — keccak256 of RFC 8785 bytes
  - `buildObjectManifest(input: { contextId: Hex; ciphertext: Uint8Array; payloadNonce: Uint8Array; readEpoch: bigint; epochDekWrap: EpochDEKWrap }): ObjectManifest`
  - `verifyObjectManifest(input: { manifest: ObjectManifest; expectedManifestHash: Hex; ciphertext: Uint8Array }): void` — throws `MANIFEST_MISMATCH` then `CONTENT_HASH_MISMATCH`
  - `interface SealedContextObject { ciphertext: Uint8Array; manifest: ObjectManifest; manifestHash: Hex; ciphertextCommitment: Hex }`
  - `sealContextObject(input: { payload: ContextPayload; binding: ObjectBinding; epochPublicKey: Uint8Array }): SealedContextObject`
  - `openContextObject(input: { manifest: ObjectManifest; expectedManifestHash: Hex; ciphertext: Uint8Array; epochPrivateKey: Uint8Array; binding: ObjectBinding }): ContextPayload`
- Produces, in `@mida/storage`:
  - `interface ContextStorage { put(blob: Uint8Array): Promise<StorageRef[]>; get(hash: Hex, hints?: StorageRef[]): Promise<Uint8Array> }`
  - `contentHash(blob: Uint8Array): Hex`
  - `verifyContent(hash: Hex, blob: Uint8Array): Uint8Array` — throws `CONTENT_HASH_MISMATCH`
  - `class MemoryStorage implements ContextStorage { constructor(blobs?: Map<Hex, Uint8Array>) }`
  - `class FsStorage implements ContextStorage { constructor(directory: string); pathFor(hash: Hex): string }`

`sealContextObject` and `openContextObject` are what the FakeVault, SDK and API call in Part E. `ContextRegistry.register` receives `manifestHash` and `ciphertextCommitment` from `SealedContextObject`. `openContextObject` receives `expectedManifestHash` from the on-chain record, never from the API.

- [ ] **Step 1: Write the failing crypto object test**

`packages/crypto/test/object.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { keccak256 } from "viem"
import { sha256 } from "@noble/hashes/sha2.js"
import { canonicalBytes, isMidaError, namespaceId } from "@mida/protocol"
import type { ContextPayload } from "@mida/protocol"
import {
  ciphertextHash,
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  generateX25519KeyPair,
  hexOf,
  manifestHash,
  openContextObject,
  sealContextObject,
  unwrapEpochPrivateKey,
  wrapEpochPrivateKeyToAgent,
} from "@mida/crypto"
import type { ObjectBinding } from "@mida/crypto"

const failsWith = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const career = namespaceId("goals.career")
const generalPrf = new Uint8Array(32).fill(0x42)
const epoch1 = deriveEpochKeyPair(deriveNamespaceSecret(generalPrf, career), 1n)
const epoch2 = deriveEpochKeyPair(deriveNamespaceSecret(generalPrf, career), 2n)
const payload: ContextPayload = { v: 1, value: "Prioritize systems engineering", kind: "GOAL", provenance: { source: "USER_ASSERTED" } }
const binding: ObjectBinding = {
  chainId: 31337n,
  contextRegistry: "0x3333333333333333333333333333333333333333",
  contextId: `0x${"cc".repeat(32)}`,
  namespaceId: career,
  readEpoch: 1n,
}

describe("object manifest commitments (§9.1)", () => {
  it("commits ciphertext by SHA-256 and manifest by keccak256 of canonical JSON", () => {
    const sealed = sealContextObject({ payload, binding, epochPublicKey: epoch1.publicKey })
    expect(sealed.manifest.ciphertextHash).toBe(hexOf(sha256(sealed.ciphertext)))
    expect(sealed.ciphertextCommitment).toBe(ciphertextHash(sealed.ciphertext))
    expect(sealed.manifestHash).toBe(keccak256(canonicalBytes(sealed.manifest)))
    expect(sealed.manifest).toMatchObject({ v: 1, contextId: binding.contextId, cryptoVersion: "mida-crypto-v1", readEpoch: "1", ciphertextSize: sealed.ciphertext.length })
    expect(sealed.manifest.epochDekWrap.contextId).toBe(binding.contextId)
    expect(Object.keys(sealed.manifest)).not.toContain("storage")
  })
})

describe("CREATE vs READ (§7.1)", () => {
  it("a writer with only the epoch public key seals; a reader with the private key opens", () => {
    const sealed = sealContextObject({ payload, binding, epochPublicKey: epoch1.publicKey })
    expect(openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epoch1.privateKey, binding })).toEqual(payload)
  })

  it("a reader holding only the epoch-1 key cannot open an epoch-2 object (forward revocation)", () => {
    const epoch2Binding = { ...binding, contextId: `0x${"ee".repeat(32)}`, readEpoch: 2n } as ObjectBinding
    const sealed = sealContextObject({ payload, binding: epoch2Binding, epochPublicKey: epoch2.publicKey })
    expect(failsWith("DECRYPT_FAILED", () => openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epoch1.privateKey, binding: epoch2Binding }))).toBe(true)
  })

  it("a reader wrap delivers the epoch key to the agent end to end", () => {
    const agent = generateX25519KeyPair()
    const readerBinding = { chainId: 31337n, capabilityRegistry: "0x1111111111111111111111111111111111111111", owner: "0x2222222222222222222222222222222222222222", namespaceId: career, readEpoch: 1n, agentId: `0x${"aa".repeat(32)}`, agentKeyVersion: 1 } as const
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agent.publicKey, binding: readerBinding, createdAt: 1n })
    const epochKey = unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agent.privateKey, binding: readerBinding })
    const sealed = sealContextObject({ payload, binding, epochPublicKey: epoch1.publicKey })
    expect(openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epochKey, binding })).toEqual(payload)
  })
})

describe("recovery seam and domain isolation (§15)", () => {
  it("the same fake domain output in a fresh derivation opens the object", () => {
    const sealed = sealContextObject({ payload, binding, epochPublicKey: epoch1.publicKey })
    const recovered = deriveEpochKeyPair(deriveNamespaceSecret(new Uint8Array(32).fill(0x42), career), 1n)
    expect(openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: recovered.privateKey, binding })).toEqual(payload)
  })

  it("a different domain output (general used for financial) fails to decrypt", () => {
    const financial = namespaceId("financial.preferences")
    const financialBinding = { ...binding, namespaceId: financial } as ObjectBinding
    const financialEpoch = deriveEpochKeyPair(deriveNamespaceSecret(new Uint8Array(32).fill(0x77), financial), 1n)
    const sealed = sealContextObject({ payload, binding: financialBinding, epochPublicKey: financialEpoch.publicKey })
    const wrongDomain = deriveEpochKeyPair(deriveNamespaceSecret(generalPrf, financial), 1n)
    expect(failsWith("DECRYPT_FAILED", () => openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: wrongDomain.privateKey, binding: financialBinding }))).toBe(true)
  })
})

describe("mutation is detected before decryption (§15 Crypto)", () => {
  const sealed = sealContextObject({ payload, binding, epochPublicKey: epoch1.publicKey })

  it("mutated manifest fails its on-chain commitment", () => {
    const mutated = { ...sealed.manifest, payloadNonce: `0x${"00".repeat(24)}` as const }
    expect(failsWith("MANIFEST_MISMATCH", () => openContextObject({ manifest: mutated, ciphertext: sealed.ciphertext, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epoch1.privateKey, binding }))).toBe(true)
  })

  it("mutated ciphertext fails the content hash", () => {
    const ciphertext = sealed.ciphertext.slice()
    ciphertext[0]! ^= 1
    expect(failsWith("CONTENT_HASH_MISMATCH", () => openContextObject({ manifest: sealed.manifest, ciphertext, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epoch1.privateKey, binding }))).toBe(true)
  })

  it("manifest committed for another object cannot be used under this binding", () => {
    const other = { ...binding, contextId: `0x${"dd".repeat(32)}` } as ObjectBinding
    expect(failsWith("MANIFEST_MISMATCH", () => openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epoch1.privateKey, binding: other }))).toBe(true)
  })

  it("recomputing the hash over a mutated manifest still fails AEAD", () => {
    const mutated = { ...sealed.manifest, payloadNonce: `0x${"00".repeat(24)}` as const }
    expect(failsWith("DECRYPT_FAILED", () => openContextObject({ manifest: mutated, ciphertext: sealed.ciphertext, expectedManifestHash: manifestHash(mutated), epochPrivateKey: epoch1.privateKey, binding }))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/crypto/test/object.test.ts`
Expected: FAIL — `sealContextObject` (and the other object names) are not exported by `@mida/crypto`.

- [ ] **Step 3: Implement `object.ts`**

`packages/crypto/src/object.ts`:
```ts
import { sha256 } from "@noble/hashes/sha2.js"
import { keccak256 } from "viem"
import { CRYPTO_VERSION, MidaError, canonicalBytes, decodeUint64, encodeUint64 } from "@mida/protocol"
import type { ContextPayload, EpochDEKWrap, Hex, ObjectManifest } from "@mida/protocol"
import { NONCE_BYTES } from "./aead.js"
import { bytesOf, hexOf } from "./bytes.js"
import { decryptPayload, encryptPayload } from "./payload.js"
import type { ObjectBinding } from "./payload.js"
import { unwrapDekFromEpoch, wrapDekToEpoch } from "./wraps.js"

/** §9.1: ciphertextHash = SHA256(ciphertextBytes). */
export function ciphertextHash(ciphertext: Uint8Array): Hex {
  return hexOf(sha256(ciphertext))
}

/** §9.1: manifestHash = keccak256(RFC 8785 canonical manifest bytes). */
export function manifestHash(manifest: ObjectManifest): Hex {
  return keccak256(canonicalBytes(manifest))
}

export function buildObjectManifest(input: {
  contextId: Hex
  ciphertext: Uint8Array
  payloadNonce: Uint8Array
  readEpoch: bigint
  epochDekWrap: EpochDEKWrap
}): ObjectManifest {
  return {
    v: 1,
    contextId: input.contextId,
    ciphertextHash: ciphertextHash(input.ciphertext),
    ciphertextSize: input.ciphertext.length,
    payloadNonce: hexOf(input.payloadNonce),
    cryptoVersion: CRYPTO_VERSION,
    readEpoch: encodeUint64(input.readEpoch),
    epochDekWrap: input.epochDekWrap,
  }
}

/**
 * Checks, in order: the manifest matches its on-chain commitment, its embedded wrap belongs to the same
 * object and epoch, and the ciphertext bytes match the committed hash and size. Runs before any decryption.
 */
export function verifyObjectManifest(input: {
  manifest: ObjectManifest
  expectedManifestHash: Hex
  ciphertext: Uint8Array
}): void {
  const { manifest } = input
  if (manifestHash(manifest) !== input.expectedManifestHash) {
    throw new MidaError("MANIFEST_MISMATCH", "manifest does not match its commitment")
  }
  if (
    manifest.v !== 1 ||
    manifest.cryptoVersion !== CRYPTO_VERSION ||
    manifest.epochDekWrap.contextId !== manifest.contextId ||
    manifest.epochDekWrap.readEpoch !== manifest.readEpoch
  ) {
    throw new MidaError("MANIFEST_MISMATCH", "manifest fields are inconsistent")
  }
  if (manifest.ciphertextSize !== input.ciphertext.length || ciphertextHash(input.ciphertext) !== manifest.ciphertextHash) {
    throw new MidaError("CONTENT_HASH_MISMATCH", "ciphertext does not match the manifest")
  }
}

export interface SealedContextObject {
  ciphertext: Uint8Array
  manifest: ObjectManifest
  manifestHash: Hex
  ciphertextCommitment: Hex
}

/** Encrypts a payload and wraps its DEK to the epoch public key. Needs only the public key (§7.1 CREATE). */
export function sealContextObject(input: {
  payload: ContextPayload
  binding: ObjectBinding
  epochPublicKey: Uint8Array
}): SealedContextObject {
  const encrypted = encryptPayload(input.payload, input.binding)
  const epochDekWrap = wrapDekToEpoch({ dek: encrypted.dek, epochPublicKey: input.epochPublicKey, binding: input.binding })
  encrypted.dek.fill(0)
  const manifest = buildObjectManifest({
    contextId: input.binding.contextId,
    ciphertext: encrypted.ciphertext,
    payloadNonce: encrypted.nonce,
    readEpoch: input.binding.readEpoch,
    epochDekWrap,
  })
  return {
    ciphertext: encrypted.ciphertext,
    manifest,
    manifestHash: manifestHash(manifest),
    ciphertextCommitment: manifest.ciphertextHash,
  }
}

/** Verifies commitments, unwraps the DEK with the epoch private key, and decrypts (§7.1 READ). */
export function openContextObject(input: {
  manifest: ObjectManifest
  expectedManifestHash: Hex
  ciphertext: Uint8Array
  epochPrivateKey: Uint8Array
  binding: ObjectBinding
}): ContextPayload {
  verifyObjectManifest(input)
  if (input.manifest.contextId !== input.binding.contextId || decodeUint64(input.manifest.readEpoch) !== input.binding.readEpoch) {
    throw new MidaError("MANIFEST_MISMATCH", "manifest belongs to a different object or epoch")
  }
  const dek = unwrapDekFromEpoch({ wrap: input.manifest.epochDekWrap, epochPrivateKey: input.epochPrivateKey, binding: input.binding })
  try {
    return decryptPayload(
      { ciphertext: input.ciphertext, nonce: bytesOf(input.manifest.payloadNonce, NONCE_BYTES), dek },
      input.binding,
    )
  } finally {
    dek.fill(0)
  }
}
```

Append to `packages/crypto/src/index.ts`:
```ts
export * from "./object.js"
```

- [ ] **Step 4: Run to verify the crypto object test passes**

Run:
```bash
pnpm vitest run packages/crypto
pnpm typecheck
```
Expected: all crypto tests PASS (Tasks 6–8 plus 10 here). Typecheck exits 0.

- [ ] **Step 5: Write the failing storage test**

`packages/storage/test/storage.test.ts`:
```ts
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { isMidaError } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { FsStorage, MemoryStorage, contentHash } from "@mida/storage"
import type { ContextStorage } from "@mida/storage"

const rejectsWith = async (code: Parameters<typeof isMidaError>[1], promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const blob = new TextEncoder().encode("ciphertext bytes")
const hashOf = (bytes: Uint8Array) => `0x${bytesToHex(sha256(bytes))}` as Hex

function contract(name: string, make: () => Promise<ContextStorage>) {
  describe(`${name} satisfies ContextStorage (§9.2)`, () => {
    it("put returns a hint whose locator is the SHA-256 content hash", async () => {
      const storage = await make()
      const refs = await storage.put(blob)
      expect(refs).toHaveLength(1)
      expect(refs[0]!.locator).toBe(hashOf(blob))
      expect(contentHash(blob)).toBe(hashOf(blob))
    })

    it("get returns the same bytes", async () => {
      const storage = await make()
      await storage.put(blob)
      expect(await storage.get(hashOf(blob))).toEqual(blob)
    })

    it("put is idempotent for identical content", async () => {
      const storage = await make()
      await storage.put(blob)
      await storage.put(blob.slice())
      expect(await storage.get(hashOf(blob))).toEqual(blob)
    })

    it("missing content fails NOT_FOUND", async () => {
      const storage = await make()
      expect(await rejectsWith("NOT_FOUND", storage.get(hashOf(new Uint8Array([1]))))).toBe(true)
    })

    it("rejects a malformed hash", async () => {
      const storage = await make()
      expect(await rejectsWith("INVALID_WIRE", storage.get("0x1234" as Hex))).toBe(true)
    })
  })
}

contract("MemoryStorage", async () => new MemoryStorage())

let directory = ""
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mida-storage-"))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

contract("FsStorage", async () => new FsStorage(directory))

describe("providers returning the wrong bytes (§15 Storage)", () => {
  it("MemoryStorage fails CONTENT_HASH_MISMATCH before returning", async () => {
    const shared = new Map<Hex, Uint8Array>()
    const storage = new MemoryStorage(shared)
    await storage.put(blob)
    shared.set(hashOf(blob), new TextEncoder().encode("tampered"))
    expect(await rejectsWith("CONTENT_HASH_MISMATCH", storage.get(hashOf(blob)))).toBe(true)
  })

  it("FsStorage fails CONTENT_HASH_MISMATCH when the file on disk changes", async () => {
    const storage = new FsStorage(directory)
    await storage.put(blob)
    await writeFile(storage.pathFor(hashOf(blob)), "tampered")
    expect(await rejectsWith("CONTENT_HASH_MISMATCH", storage.get(hashOf(blob)))).toBe(true)
  })

  it("FsStorage leaves no temporary files after put", async () => {
    const storage = new FsStorage(directory)
    await storage.put(blob)
    expect(await readdir(directory)).toEqual([hashOf(blob).slice(2)])
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm vitest run packages/storage`
Expected: FAIL — Vitest cannot resolve `@mida/storage`, because the package does not exist yet.

- [ ] **Step 7: Create the storage package**

`packages/storage/package.json`:
```json
{
  "name": "@mida/storage",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@mida/protocol": "workspace:*",
    "@noble/hashes": "2.4.0"
  }
}
```

Add to the root `package.json` `dependencies`:
```json
    "@mida/storage": "workspace:*"
```

`packages/storage/src/index.ts`:
```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { MidaError, assertHex } from "@mida/protocol"
import type { Hex, StorageRef } from "@mida/protocol"

/** §9.2 */
export interface ContextStorage {
  put(blob: Uint8Array): Promise<StorageRef[]>
  get(hash: Hex, hints?: StorageRef[]): Promise<Uint8Array>
}

export function contentHash(blob: Uint8Array): Hex {
  return `0x${bytesToHex(sha256(blob))}` as Hex
}

/** Every get path calls this before returning bytes. */
export function verifyContent(hash: Hex, blob: Uint8Array): Uint8Array {
  if (contentHash(blob) !== hash) {
    throw new MidaError("CONTENT_HASH_MISMATCH", `bytes do not hash to ${hash}`)
  }
  return blob
}

export class MemoryStorage implements ContextStorage {
  readonly #blobs: Map<Hex, Uint8Array>

  /** Tests may pass a shared map to simulate a provider that returns the wrong bytes. */
  constructor(blobs: Map<Hex, Uint8Array> = new Map()) {
    this.#blobs = blobs
  }

  async put(blob: Uint8Array): Promise<StorageRef[]> {
    const hash = contentHash(blob)
    this.#blobs.set(hash, blob.slice())
    return [{ provider: "memory", locator: hash }]
  }

  async get(hash: Hex, _hints?: StorageRef[]): Promise<Uint8Array> {
    const blob = this.#blobs.get(assertHex(hash, 32))
    if (blob === undefined) {
      throw new MidaError("NOT_FOUND", `no blob ${hash}`)
    }
    return verifyContent(hash, blob.slice())
  }
}

export class FsStorage implements ContextStorage {
  readonly #directory: string

  constructor(directory: string) {
    this.#directory = directory
  }

  pathFor(hash: Hex): string {
    return join(this.#directory, assertHex(hash, 32).slice(2))
  }

  async put(blob: Uint8Array): Promise<StorageRef[]> {
    const hash = contentHash(blob)
    await mkdir(this.#directory, { recursive: true })
    const target = this.pathFor(hash)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, blob)
    await rename(temporary, target)
    return [{ provider: "fs", locator: hash }]
  }

  async get(hash: Hex, _hints?: StorageRef[]): Promise<Uint8Array> {
    let blob: Uint8Array
    try {
      blob = new Uint8Array(await readFile(this.pathFor(hash)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MidaError("NOT_FOUND", `no blob ${hash}`)
      }
      throw error
    }
    return verifyContent(hash, blob)
  }
}
```

- [ ] **Step 8: Run to verify everything passes**

Run:
```bash
pnpm install
pnpm vitest run packages/crypto packages/storage
pnpm typecheck
```
Expected: 13 storage tests PASS and every crypto test PASS. Typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml packages/crypto packages/storage
git commit -m "feat(crypto,storage): committed object manifests, seal/open, and hash-verified storage

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```
