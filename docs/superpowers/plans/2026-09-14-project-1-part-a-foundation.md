# Project 1 Plan — Part A: Foundation (Tasks 1–5)

> Read `2026-09-14-project-1-protocol-core.md` first. Its Global Constraints and "Decisions" sections apply to every task here.

---

### Task 1: Repo scaffold and toolchain pins

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `.nvmrc`, `.gitignore`, `.env.example`
- Create: `packages/protocol/package.json`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: workspace package `@mida/protocol` exporting `PROTOCOL_VERSION = "mida-protocol-v1"`; root commands `pnpm test`, `pnpm typecheck`.

- [ ] **Step 1: Verify toolchain versions**

Run:
```bash
node --version
pnpm --version
~/.foundry/bin/forge --version | head -1
```
Expected: Node `v22` or newer, pnpm `12.4.1`, forge `Version: 1.8.1`. If forge is missing or a different version, run `foundryup --install 1.8.1` and re-check. If pnpm differs, run `npm install -g pnpm@12.4.1`.

- [ ] **Step 2: Create root files**

`package.json`:
```json
{
  "name": "mida-context",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.4.1",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "test:contracts": "cd contracts && forge test"
  },
  "devDependencies": {
    "@types/node": "22.20.1",
    "fast-check": "4.9.0",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["packages/*/src", "packages/*/test", "apps/*/src", "apps/*/test", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
})
```

`.nvmrc`:
```text
22
```

`.gitignore`:
```text
node_modules/
.env
.env.*
!.env.example
.mida-data/
contracts/out/
contracts/cache/
contracts/broadcast/*/31337/
coverage/
```

`.env.example`:
```text
# Monad testnet deployer and scenario keys. Never commit real values.
MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz
DEPLOYER_PRIVATE_KEY=
ALICE_PRIVATE_KEY=
AGENT_A_OPERATOR_PRIVATE_KEY=
AGENT_B_OPERATOR_PRIVATE_KEY=
AGENT_C_OPERATOR_PRIVATE_KEY=
AGENT_D_OPERATOR_PRIVATE_KEY=
FAKE_VAULT_SEED=
```

- [ ] **Step 3: Write the failing smoke test**

`packages/protocol/test/smoke.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { PROTOCOL_VERSION } from "@mida/protocol"

describe("@mida/protocol workspace wiring", () => {
  it("resolves the package through the workspace", () => {
    expect(PROTOCOL_VERSION).toBe("mida-protocol-v1")
  })
})
```

- [ ] **Step 4: Install and run to verify it fails**

Run:
```bash
pnpm install
pnpm test
```
Expected: FAIL with an import resolution error for `@mida/protocol`, because the package does not exist yet.

- [ ] **Step 5: Create the package**

`packages/protocol/package.json`:
```json
{
  "name": "@mida/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "canonicalize": "4.0.0",
    "viem": "2.56.3"
  }
}
```

`packages/protocol/src/index.ts`:
```ts
export const PROTOCOL_VERSION = "mida-protocol-v1" as const
```

Add a `"dependencies"` key to the root `package.json` so root-level tests resolve workspace packages. Later tasks add each new package here the same way:
```json
  "dependencies": {
    "@mida/protocol": "workspace:*"
  },
```

- [ ] **Step 6: Run to verify it passes**

Run:
```bash
pnpm install
pnpm test
pnpm typecheck
```
Expected: 1 test PASS. Typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json vitest.config.ts .nvmrc .gitignore .env.example packages/protocol
git commit -m "chore: scaffold pnpm workspace with pinned toolchain

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 2: Errors, constants and shared types

**Files:**
- Create: `packages/protocol/src/errors.ts`, `packages/protocol/src/constants.ts`, `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/errors-constants.test.ts`

**Interfaces:**
- Consumes: `@mida/protocol` package from Task 1.
- Produces:
  - `class MidaError extends Error { readonly code: MidaErrorCode; constructor(code: MidaErrorCode, detail?: string) }`
  - `isMidaError(value: unknown, code?: MidaErrorCode): value is MidaError`
  - `PERMISSION`, `PROVENANCE_POLICY`, `RECORD_TYPE`, `LINEAGE_POLICY`, `CONTEXT_KIND`, `PROVENANCE_SOURCE`, `RECORD_RELATION_CODE`, `KNOWN_PERMISSION_BITS = 15`, `KNOWN_PROVENANCE_BITS = 7`
  - Types `Permission`, `ProvenancePolicy`, `RecordType`, `LineagePolicy`, `ContextKind`, `ProvenanceSource`, `RecordRelation`
  - `POLICY_VERSION`, `NAMESPACE_TREE_VERSION`, `CRYPTO_VERSION`, `MAX_PAYLOAD_BYTES = 65536`
  - Every interface in `types.ts` below, by exact name.

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/errors-constants.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import {
  CONTEXT_KIND,
  CRYPTO_VERSION,
  KNOWN_PERMISSION_BITS,
  KNOWN_PROVENANCE_BITS,
  LINEAGE_POLICY,
  MAX_PAYLOAD_BYTES,
  MidaError,
  NAMESPACE_TREE_VERSION,
  PERMISSION,
  POLICY_VERSION,
  PROVENANCE_POLICY,
  PROVENANCE_SOURCE,
  RECORD_RELATION_CODE,
  RECORD_TYPE,
  isMidaError,
} from "@mida/protocol"

describe("MidaError", () => {
  it("carries a typed code and is detectable", () => {
    const error = new MidaError("STALE_PARENT", "lineage advanced")
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe("STALE_PARENT")
    expect(error.message).toBe("STALE_PARENT: lineage advanced")
    expect(isMidaError(error)).toBe(true)
    expect(isMidaError(error, "STALE_PARENT")).toBe(true)
    expect(isMidaError(error, "CAPABILITY_DENIED")).toBe(false)
    expect(isMidaError(new Error("x"))).toBe(false)
  })
})

describe("protocol constants (§10.2, §11.2, §11.8)", () => {
  it("fixes permission and provenance bits", () => {
    expect(PERMISSION).toEqual({ READ: 1, CREATE: 2, SUPERSEDE_OWN: 4, SUPERSEDE_ANY: 8 })
    expect(PROVENANCE_POLICY).toEqual({ ALLOW_INFERENCE: 1, ALLOW_IMPORTED: 2, ALLOW_EXTERNAL_ATTESTATION: 4 })
    expect(KNOWN_PERMISSION_BITS).toBe(15)
    expect(KNOWN_PROVENANCE_BITS).toBe(7)
  })

  it("fixes enum ordinals that Solidity must mirror", () => {
    expect(RECORD_TYPE).toEqual({ CONTEXT: 0, EVIDENCE: 1 })
    expect(LINEAGE_POLICY).toEqual({ STANDARD: 0, OWNER_CONTROLLED: 1 })
    expect(CONTEXT_KIND).toEqual({
      NONE: 0, FACT: 1, PREFERENCE: 2, GOAL: 3, DECISION: 4,
      EPISODE: 5, INFERENCE: 6, CREDENTIAL: 7, OPEN_LOOP: 8,
    })
    expect(PROVENANCE_SOURCE).toEqual({
      NONE: 0, USER_ASSERTED: 1, USER_CONFIRMED: 2, AGENT_INFERRED: 3,
      IMPORTED: 4, EXTERNAL_ATTESTATION: 5,
    })
    expect(RECORD_RELATION_CODE).toEqual({ supports: 1, derived_from: 2, confirmed_from: 3 })
  })

  it("fixes version strings and payload cap", () => {
    expect(POLICY_VERSION).toBe("mida-grant-policy-v1")
    expect(NAMESPACE_TREE_VERSION).toBe("mida-namespace-tree-v1")
    expect(CRYPTO_VERSION).toBe("mida-crypto-v1")
    expect(MAX_PAYLOAD_BYTES).toBe(65_536)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/protocol/test/errors-constants.test.ts`
Expected: FAIL — `MidaError` and the other names are not exported.

- [ ] **Step 3: Implement `errors.ts`**

`packages/protocol/src/errors.ts`:
```ts
/** §12.6 typed failures, §14.8 advisor hard failures, then plan decision 3 implementation codes. */
export const MIDA_ERROR_CODES = [
  "CAPABILITY_DENIED",
  "CAPABILITY_EXPIRED",
  "CAPABILITY_REVOKED",
  "EPOCH_ROTATION_REQUIRED",
  "EPOCH_STALE",
  "NO_EPOCH_WRAP",
  "WRAP_KEY_VERSION_MISMATCH",
  "MANIFEST_MISMATCH",
  "CONTENT_HASH_MISMATCH",
  "COMMITMENT_MISMATCH",
  "DECRYPT_FAILED",
  "INVALID_NAMESPACE",
  "STALE_PARENT",
  "EVIDENCE_IMMUTABLE",
  "PROVENANCE_FORBIDDEN",
  "ANCHOR_OWNER_ONLY",
  "MANIFEST_NOT_FOUND",
  "MANIFEST_HASH_MISMATCH",
  "MANIFEST_SIGNATURE_INVALID",
  "MANIFEST_STALE",
  "AGENT_ID_MISMATCH",
  "PURPOSE_UNKNOWN",
  "REQUEST_SIGNATURE_INVALID",
  "NAMESPACE_TREE_VERSION_UNSUPPORTED",
  "POLICY_VERSION_UNSUPPORTED",
  "INVALID_WIRE",
  "PAYLOAD_TOO_LARGE",
  "ZERO_KEY",
  "AUTH_INVALID",
  "REPLAY",
  "REQUEST_EXPIRED",
  "REQUEST_CONSUMED",
  "RESPONSE_MISMATCH",
  "NOT_FOUND",
] as const

export type MidaErrorCode = (typeof MIDA_ERROR_CODES)[number]

export class MidaError extends Error {
  readonly code: MidaErrorCode

  constructor(code: MidaErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = "MidaError"
    this.code = code
  }
}

export function isMidaError(value: unknown, code?: MidaErrorCode): value is MidaError {
  return value instanceof MidaError && (code === undefined || value.code === code)
}
```

- [ ] **Step 4: Implement `constants.ts`**

`packages/protocol/src/constants.ts`:
```ts
export const PERMISSION = { READ: 1, CREATE: 2, SUPERSEDE_OWN: 4, SUPERSEDE_ANY: 8 } as const
export type Permission = keyof typeof PERMISSION
export const KNOWN_PERMISSION_BITS = 15

export const PROVENANCE_POLICY = {
  ALLOW_INFERENCE: 1,
  ALLOW_IMPORTED: 2,
  ALLOW_EXTERNAL_ATTESTATION: 4,
} as const
export type ProvenancePolicy = keyof typeof PROVENANCE_POLICY
export const KNOWN_PROVENANCE_BITS = 7

export const RECORD_TYPE = { CONTEXT: 0, EVIDENCE: 1 } as const
export type RecordType = keyof typeof RECORD_TYPE

export const LINEAGE_POLICY = { STANDARD: 0, OWNER_CONTROLLED: 1 } as const
export type LineagePolicy = keyof typeof LINEAGE_POLICY

export const CONTEXT_KIND = {
  NONE: 0, FACT: 1, PREFERENCE: 2, GOAL: 3, DECISION: 4,
  EPISODE: 5, INFERENCE: 6, CREDENTIAL: 7, OPEN_LOOP: 8,
} as const
export type ContextKind = keyof typeof CONTEXT_KIND

export const PROVENANCE_SOURCE = {
  NONE: 0, USER_ASSERTED: 1, USER_CONFIRMED: 2, AGENT_INFERRED: 3,
  IMPORTED: 4, EXTERNAL_ATTESTATION: 5,
} as const
export type ProvenanceSource = keyof typeof PROVENANCE_SOURCE

export const RECORD_RELATION_CODE = { supports: 1, derived_from: 2, confirmed_from: 3 } as const
export type RecordRelation = keyof typeof RECORD_RELATION_CODE

export const POLICY_VERSION = "mida-grant-policy-v1" as const
export const NAMESPACE_TREE_VERSION = "mida-namespace-tree-v1" as const
export const CRYPTO_VERSION = "mida-crypto-v1" as const
export const MAX_PAYLOAD_BYTES = 65_536
```

- [ ] **Step 5: Implement `types.ts`**

Shapes are copied from the spec. Field names and order must not change.

`packages/protocol/src/types.ts`:
```ts
import type { Address, Hex } from "viem"
import type {
  ContextKind,
  Permission,
  ProvenancePolicy,
  ProvenanceSource,
  RecordRelation,
} from "./constants.js"

export type { Address, Hex }

/** §4.3 */
export interface AgentRecord {
  agentId: Hex
  operator: Address
  signer: Address
  encryptionPublicKey: Hex
  encryptionKeyVersion: number
  callbackOriginHash: Hex
  capabilityManifestHash: Hex
  capabilityManifestVersion: number
  active: boolean
}

/** §7.2 */
export interface ReadEpochState {
  readEpoch: bigint
  publicKey: Hex
  writeDeadline: bigint
}

/** §8.2 */
export interface RecordReference {
  relation: RecordRelation
  recordId: Hex
}

export interface ContextPayload {
  v: 1
  value: string | Record<string, unknown>
  kind: ContextKind
  provenance: {
    source: ProvenanceSource
    extractionConfidence?: number
    references?: RecordReference[]
    sourceHash?: Hex
    sourceUri?: string
    retrievedAt?: number
    note?: string
  }
  tags?: string[]
}

/** §8.3 */
export interface EpochDEKWrap {
  v: 1
  contextId: Hex
  namespaceId: Hex
  readEpoch: string
  ephemeralPublicKey: Hex
  nonce: Hex
  wrappedDek: Hex
}

/** §8.4 */
export interface ReaderEpochWrap {
  v: 1
  owner: Address
  namespaceId: Hex
  readEpoch: string
  agentId: Hex
  agentKeyVersion: number
  ephemeralPublicKey: Hex
  nonce: Hex
  wrappedEpochPrivateKey: Hex
  createdAt: string
}

/** §9.1 */
export interface ObjectManifest {
  v: 1
  contextId: Hex
  ciphertextHash: Hex
  ciphertextSize: number
  payloadNonce: Hex
  cryptoVersion: "mida-crypto-v1"
  readEpoch: string
  epochDekWrap: EpochDEKWrap
}

/** §9.2 */
export interface StorageRef {
  provider: "memory" | "fs" | "mida-api" | "s3" | "ipfs"
  locator: string
}

/** §13.2. GrantScope (§10.4) has the same three fields. */
export interface RequestedScope {
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
}
export type GrantScope = RequestedScope

export type PurposeId =
  | "general_assistance"
  | "career_coaching"
  | "project_assistance"
  | "travel_planning"

export interface AccessRequest {
  v: 1
  chainId: string
  capabilityRegistry: Address
  requestId: Hex
  nonce: Hex
  agentId: Hex
  purposeId: PurposeId
  callbackOrigin: string
  manifestHash: Hex
  manifestVersion: number
  policyVersion: "mida-grant-policy-v1"
  namespaceTreeVersion: "mida-namespace-tree-v1"
  scopes: RequestedScope[]
  issuedAt: string
  requestExpiresAt: string
  capabilityExpiresAt: string
  agentSignature: Hex
}

export interface GrantedCapability {
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
  expiresAt: string
  capabilityId: Hex
  transactionHash: Hex
}

export interface AccessGrantResponse {
  v: 1
  chainId: string
  capabilityRegistry: Address
  requestId: Hex
  nonce: Hex
  requestHash: Hex
  owner: Address
  agentId: Hex
  manifestHash: Hex
  manifestVersion: number
  policyVersion: "mida-grant-policy-v1"
  namespaceTreeVersion: "mida-namespace-tree-v1"
  capabilities: GrantedCapability[]
}

/** §14.1 */
export interface PurposeDeclaration {
  id: PurposeId
  description: string
}

export interface ScopeDeclaration {
  purposeId: PurposeId
  namespace: string
  permissions: Permission[]
  provenancePolicies?: ProvenancePolicy[]
  reason: string
}

export interface AgentCapabilityManifestBody {
  v: 1
  agentId: Hex
  manifestVersion: number
  name: string
  purposes: PurposeDeclaration[]
  scopeDeclarations: ScopeDeclaration[]
  issuedAt: number
}

export interface SignedAgentCapabilityManifest {
  manifest: AgentCapabilityManifestBody
  operatorSignature: Hex
}

/** §14.5 */
export interface EffectiveAuthority {
  namespaceId: Hex
  permission: Permission
  provenancePolicy?: ProvenancePolicy
}

export interface OwnerAgentHistory {
  owner: Address
  agentId: Hex
  previouslyRevoked: boolean
  observedThroughBlock: bigint
}

/** §14.6 */
export type ScopeWarningCode =
  | "SCOPE_NOT_DECLARED"
  | "SCOPE_UNCLASSIFIED"
  | "SCOPE_ELEVATED"
  | "SCOPE_SUSPICIOUS"
  | "HIGH_SENSITIVITY"
  | "BROAD_PARENT_SCOPE"
  | "SUPERSEDE_ANY_EXPLICIT"
  | "PERMISSION_NARROWED"
  | "PROVENANCE_POLICY_NARROWED"
  | "DURATION_NARROWED"
  | "PREVIOUSLY_REVOKED"

export interface ScopeWarning {
  code: ScopeWarningCode
  namespaceId?: Hex
  relatedNamespaceIds?: Hex[]
  severity: "info" | "warning" | "critical"
  messageKey: string
}

export interface GrantAdvice {
  policyVersion: "mida-grant-policy-v1"
  namespaceTreeVersion: "mida-namespace-tree-v1"
  requestHash: Hex
  manifestHash: Hex
  manifestVersion: number
  recommended: RequestedScope[]
  recommendedExpiresAt: string
  warnings: ScopeWarning[]
  risk: "low" | "medium" | "high"
}
```

- [ ] **Step 6: Export everything**

`packages/protocol/src/index.ts`:
```ts
export const PROTOCOL_VERSION = "mida-protocol-v1" as const
export * from "./errors.js"
export * from "./constants.js"
export * from "./types.js"
```

- [ ] **Step 7: Run to verify it passes**

Run:
```bash
pnpm vitest run packages/protocol
pnpm typecheck
```
Expected: all tests PASS. Typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): typed errors, protocol constants and shared wire types

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 3: Wire encoding and canonical JSON

**Files:**
- Create: `packages/protocol/src/wire.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/wire.test.ts`

**Interfaces:**
- Consumes: `MidaError` (Task 2).
- Produces:
  - `MAX_UINT64: bigint`
  - `encodeUint64(value: bigint): string`
  - `decodeUint64(value: string): bigint`
  - `assertHex(value: string, byteLength: number): Hex` — returns the value typed as `Hex`, or throws `INVALID_WIRE`
  - `isZeroBytes(bytes: Uint8Array): boolean`
  - `canonicalJson(value: unknown): string`
  - `canonicalBytes(value: unknown): Uint8Array`

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/wire.test.ts`:
```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  MAX_UINT64,
  assertHex,
  canonicalBytes,
  canonicalJson,
  decodeUint64,
  encodeUint64,
  isMidaError,
  isZeroBytes,
} from "@mida/protocol"

const invalid = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, "INVALID_WIRE")
  }
  return false
}

describe("uint64 wire strings (§8)", () => {
  it("encodes canonical base-10", () => {
    expect(encodeUint64(0n)).toBe("0")
    expect(encodeUint64(7n)).toBe("7")
    expect(encodeUint64(MAX_UINT64)).toBe("18446744073709551615")
  })

  it("rejects out-of-range values on encode", () => {
    expect(invalid(() => encodeUint64(-1n))).toBe(true)
    expect(invalid(() => encodeUint64(MAX_UINT64 + 1n))).toBe(true)
  })

  it("rejects signs, leading zeros, whitespace, decimals and overflow on decode", () => {
    for (const bad of ["", "-1", "+1", "01", "00", " 1", "1 ", "1.0", "1e3", "0x1", "18446744073709551616"]) {
      expect(invalid(() => decodeUint64(bad)), bad).toBe(true)
    }
  })

  it("round-trips every uint64", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_UINT64 }), (value) => {
        expect(decodeUint64(encodeUint64(value))).toBe(value)
      }),
    )
  })
})

describe("fixed-size hex (§8)", () => {
  it("accepts lowercase 0x values of the exact length", () => {
    expect(assertHex("0x" + "ab".repeat(32), 32)).toBe("0x" + "ab".repeat(32))
  })

  it("rejects uppercase, missing prefix, odd length and wrong length", () => {
    expect(invalid(() => assertHex("0x" + "AB".repeat(32), 32))).toBe(true)
    expect(invalid(() => assertHex("ab".repeat(32), 32))).toBe(true)
    expect(invalid(() => assertHex("0x" + "a".repeat(63), 32))).toBe(true)
    expect(invalid(() => assertHex("0x" + "ab".repeat(31), 32))).toBe(true)
  })

  it("detects all-zero byte arrays", () => {
    expect(isZeroBytes(new Uint8Array(32))).toBe(true)
    const one = new Uint8Array(32)
    one[31] = 1
    expect(isZeroBytes(one)).toBe(false)
  })
})

describe("canonical JSON (RFC 8785)", () => {
  it("sorts keys recursively and strips whitespace", () => {
    expect(canonicalJson({ b: 1, a: [2, { z: 1, y: 2 }] })).toBe('{"a":[2,{"y":2,"z":1}],"b":1}')
  })

  it("is independent of key insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse())
        expect(canonicalJson(reversed)).toBe(canonicalJson(record))
      }),
    )
  })

  it("encodes UTF-8 bytes of the canonical string", () => {
    expect(new TextDecoder().decode(canonicalBytes({ x: "é" }))).toBe('{"x":"é"}')
  })

  it("rejects values that have no JSON form", () => {
    expect(invalid(() => canonicalJson(undefined))).toBe(true)
    expect(invalid(() => canonicalJson({ big: 1n }))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/protocol/test/wire.test.ts`
Expected: FAIL — `encodeUint64` is not exported.

- [ ] **Step 3: Implement `wire.ts`**

The explicit `bigint` walk exists because `canonicalize` is not guaranteed to reject BigInt values itself; the wire format forbids them (§8 says integers above JSON-safe range travel as strings).

`packages/protocol/src/wire.ts`:
```ts
import canonicalize from "canonicalize"
import type { Hex } from "viem"
import { MidaError } from "./errors.js"

export const MAX_UINT64 = (1n << 64n) - 1n
const UINT64_PATTERN = /^(0|[1-9][0-9]*)$/

export function encodeUint64(value: bigint): string {
  if (value < 0n || value > MAX_UINT64) {
    throw new MidaError("INVALID_WIRE", "uint64 out of range")
  }
  return value.toString(10)
}

export function decodeUint64(value: string): bigint {
  if (!UINT64_PATTERN.test(value)) {
    throw new MidaError("INVALID_WIRE", "uint64 must be canonical base-10")
  }
  const parsed = BigInt(value)
  if (parsed > MAX_UINT64) {
    throw new MidaError("INVALID_WIRE", "uint64 out of range")
  }
  return parsed
}

export function assertHex(value: string, byteLength: number): Hex {
  const pattern = new RegExp(`^0x[0-9a-f]{${byteLength * 2}}$`)
  if (!pattern.test(value)) {
    throw new MidaError("INVALID_WIRE", `expected lowercase 0x hex of ${byteLength} bytes`)
  }
  return value as Hex
}

export function isZeroBytes(bytes: Uint8Array): boolean {
  let accumulator = 0
  for (const byte of bytes) accumulator |= byte
  return accumulator === 0
}

function rejectBigInt(value: unknown): void {
  if (typeof value === "bigint") {
    throw new MidaError("INVALID_WIRE", "bigint must be encoded as a base-10 string")
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectBigInt(item)
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) rejectBigInt(item)
  }
}

export function canonicalJson(value: unknown): string {
  rejectBigInt(value)
  let result: string | undefined
  try {
    result = canonicalize(value)
  } catch (error) {
    throw new MidaError("INVALID_WIRE", `not canonicalizable: ${(error as Error).message}`)
  }
  if (result === undefined) {
    throw new MidaError("INVALID_WIRE", "value has no JSON representation")
  }
  return result
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}
```

- [ ] **Step 4: Export**

Append to `packages/protocol/src/index.ts`:
```ts
export * from "./wire.js"
```

- [ ] **Step 5: Run to verify it passes**

Run:
```bash
pnpm vitest run packages/protocol
pnpm typecheck
```
Expected: all tests PASS. Typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): canonical uint64, fixed hex and RFC 8785 JSON encoding

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 4: Namespace tree v1

**Files:**
- Create: `packages/protocol/src/namespaces.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/namespaces.test.ts`

**Interfaces:**
- Consumes: `MidaError` (Task 2).
- Produces:
  - `type IsolationDomain = "general" | "financial" | "relationships" | "private"`
  - `interface NamespaceNode { name: string; parent: string | null; domain: IsolationDomain; id: Hex }`
  - `NAMESPACE_TREE_V1: readonly NamespaceNode[]` — 22 frozen nodes in §5.2 order; Solidity `NamespaceTree` registers the same order
  - `namespaceId(canonicalNamespace: string): Hex` — `keccak256(abi.encode(string "MIDA_NAMESPACE_V1", string name))`; the caller passes an already-canonical name
  - `canonicalizeNamespace(input: string): string` — throws `INVALID_NAMESPACE`
  - `namespaceById(id: Hex): NamespaceNode` — throws `INVALID_NAMESPACE`
  - `expandNamespace(input: string): string[]` — the node plus every descendant, in tree order
  - `domainOf(input: string): IsolationDomain`

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/namespaces.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { zeroHash } from "viem"
import {
  NAMESPACE_TREE_V1,
  canonicalizeNamespace,
  domainOf,
  expandNamespace,
  isMidaError,
  namespaceById,
  namespaceId,
} from "@mida/protocol"

const invalidNamespace = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, "INVALID_NAMESPACE")
  }
  return false
}

describe("namespace canonicalization (§5.1)", () => {
  it("trims and lowercases", () => {
    expect(canonicalizeNamespace("Goals.Career")).toBe("goals.career")
    expect(canonicalizeNamespace("  PROJECTS ")).toBe("projects")
  })

  it("rejects malformed, too-deep and unknown namespaces", () => {
    const bad = [
      "", ".", "goals..career", ".goals", "goals.", "goals-career", "goals career",
      "goals.career.extra", "goals.unknown", "custom",
    ]
    for (const input of bad) {
      expect(invalidNamespace(() => canonicalizeNamespace(input)), input).toBe(true)
    }
  })
})

describe("frozen tree v1 (§5.2)", () => {
  it("has 22 nodes, unique ids, depth ≤ 2, and parents listed before children", () => {
    expect(NAMESPACE_TREE_V1).toHaveLength(22)
    expect(new Set(NAMESPACE_TREE_V1.map((node) => node.id)).size).toBe(22)
    const seen = new Set<string>()
    for (const node of NAMESPACE_TREE_V1) {
      expect(node.name.split(".").length).toBeLessThanOrEqual(2)
      if (node.parent !== null) {
        expect(seen.has(node.parent)).toBe(true)
        expect(node.name.startsWith(`${node.parent}.`)).toBe(true)
      }
      seen.add(node.name)
    }
  })

  it("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(NAMESPACE_TREE_V1)).toBe(true)
    expect(Object.isFrozen(NAMESPACE_TREE_V1[0])).toBe(true)
  })

  it("derives namespaceId with ABI encoding (fixed vector)", () => {
    expect(namespaceId("goals.career")).toBe(
      "0x589f7a11985b453117a42b18c8c5a3783db67a59caa2b76beb33fd9ceb651c2a",
    )
  })

  it("resolves ids back to nodes and rejects unknown ids", () => {
    expect(namespaceById(namespaceId("projects.past")).name).toBe("projects.past")
    expect(invalidNamespace(() => namespaceById(zeroHash))).toBe(true)
  })
})

describe("parent expansion (§5.3) and isolation domains (§6.1)", () => {
  it("expands a parent to itself plus every registered descendant", () => {
    expect(expandNamespace("projects")).toEqual(["projects", "projects.current", "projects.past"])
    expect(expandNamespace("Preferences")).toEqual([
      "preferences", "preferences.communication", "preferences.tools", "preferences.work",
    ])
    expect(expandNamespace("goals.career")).toEqual(["goals.career"])
    expect(expandNamespace("credentials")).toEqual(["credentials"])
  })

  it("assigns every namespace to exactly one domain", () => {
    expect(domainOf("credentials")).toBe("general")
    expect(domainOf("profile.identity")).toBe("general")
    expect(domainOf("financial")).toBe("financial")
    expect(domainOf("financial.preferences")).toBe("financial")
    expect(domainOf("relationships")).toBe("relationships")
    expect(domainOf("private")).toBe("private")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/protocol/test/namespaces.test.ts`
Expected: FAIL — `NAMESPACE_TREE_V1` is not exported.

- [ ] **Step 3: Implement `namespaces.ts`**

`packages/protocol/src/namespaces.ts`:
```ts
import { encodeAbiParameters, keccak256 } from "viem"
import type { Hex } from "viem"
import { MidaError } from "./errors.js"

export type IsolationDomain = "general" | "financial" | "relationships" | "private"

export interface NamespaceNode {
  name: string
  parent: string | null
  domain: IsolationDomain
  id: Hex
}

/** §5.2 order. Solidity NamespaceTree registers nodes in exactly this order. */
const TREE_SOURCE: ReadonlyArray<readonly [string, string | null, IsolationDomain]> = [
  ["profile", null, "general"],
  ["profile.identity", "profile", "general"],
  ["profile.skills", "profile", "general"],
  ["goals", null, "general"],
  ["goals.career", "goals", "general"],
  ["goals.learning", "goals", "general"],
  ["goals.personal", "goals", "general"],
  ["preferences", null, "general"],
  ["preferences.communication", "preferences", "general"],
  ["preferences.tools", "preferences", "general"],
  ["preferences.work", "preferences", "general"],
  ["projects", null, "general"],
  ["projects.current", "projects", "general"],
  ["projects.past", "projects", "general"],
  ["decisions", null, "general"],
  ["decisions.career", "decisions", "general"],
  ["decisions.projects", "decisions", "general"],
  ["credentials", null, "general"],
  ["financial", null, "financial"],
  ["financial.preferences", "financial", "financial"],
  ["relationships", null, "relationships"],
  ["private", null, "private"],
]

const SHAPE = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/

export function namespaceId(canonicalNamespace: string): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "string" }], ["MIDA_NAMESPACE_V1", canonicalNamespace]),
  )
}

export const NAMESPACE_TREE_V1: readonly NamespaceNode[] = Object.freeze(
  TREE_SOURCE.map(([name, parent, domain]) => Object.freeze({ name, parent, domain, id: namespaceId(name) })),
)

const BY_NAME = new Map(NAMESPACE_TREE_V1.map((node) => [node.name, node]))
const BY_ID = new Map(NAMESPACE_TREE_V1.map((node) => [node.id, node]))

export function canonicalizeNamespace(input: string): string {
  const candidate = input.trim().toLowerCase()
  if (!SHAPE.test(candidate) || !BY_NAME.has(candidate)) {
    throw new MidaError("INVALID_NAMESPACE", JSON.stringify(input))
  }
  return candidate
}

function nodeByName(input: string): NamespaceNode {
  const node = BY_NAME.get(canonicalizeNamespace(input))
  if (node === undefined) throw new MidaError("INVALID_NAMESPACE", JSON.stringify(input))
  return node
}

export function namespaceById(id: Hex): NamespaceNode {
  const node = BY_ID.get(id.toLowerCase() as Hex)
  if (node === undefined) throw new MidaError("INVALID_NAMESPACE", `unknown namespace id ${id}`)
  return node
}

/** Depth is at most two, so descendants are exactly the direct children. */
export function expandNamespace(input: string): string[] {
  const root = nodeByName(input)
  return NAMESPACE_TREE_V1.filter((node) => node.name === root.name || node.parent === root.name).map(
    (node) => node.name,
  )
}

export function domainOf(input: string): IsolationDomain {
  return nodeByName(input).domain
}
```

- [ ] **Step 4: Export**

Append to `packages/protocol/src/index.ts`:
```ts
export * from "./namespaces.js"
```

- [ ] **Step 5: Run to verify it passes**

Run:
```bash
pnpm vitest run packages/protocol
pnpm typecheck
```
Expected: all tests PASS, including the fixed `goals.career` vector. Typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): frozen namespace tree v1 with ids, expansion and domains

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 5: Deterministic identifiers, origins and EIP-712 type definitions

This task fixes the exact ABI types and EIP-712 structs that Solidity must reproduce (plan decision 1). The layout tests hand-build the ABI bytes word by word so they check the types and field order independently of viem. Task 14 checks the same values against Solidity.

**Files:**
- Create: `packages/protocol/src/ids.ts`, `packages/protocol/src/typed-data.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/ids.test.ts`, `packages/protocol/test/typed-data.test.ts`

**Interfaces:**
- Consumes: `MidaError` (Task 2); `PERMISSION`-bit constants, `RECORD_RELATION_CODE`, version strings (Task 2); `assertHex`, `decodeUint64` (Task 3); `namespaceById` (Task 4).
- Produces, in `ids.ts` (every tuple begins with a `string` tag):
  - `OWNER_AUTHOR_ID: Hex` — `bytes32(0)`
  - `hashString(value: string): Hex` — `keccak256(UTF8(value))`
  - `POLICY_VERSION_HASH: Hex`, `NAMESPACE_TREE_VERSION_HASH: Hex`
  - `agentId({ chainId: bigint; capabilityRegistry: Address; operator: Address; agentSalt: Hex }): Hex` — `(string "MIDA_AGENT_V1", uint256, address, address, bytes32)`
  - `contextId({ chainId: bigint; contextRegistry: Address; owner: Address; authorId: Hex; namespaceId: Hex; objectNonce: Hex }): Hex` — `(string "MIDA_CONTEXT_OBJECT_V1", uint256, address, address, bytes32, bytes32, bytes32)`
  - `sortScopes<T extends RequestedScope>(scopes: readonly T[]): T[]` — ascending by `namespaceId`
  - `assertCanonicalScopes(scopes: readonly RequestedScope[]): void` — non-empty, strictly ascending, registered, non-zero known permission bits, known provenance bits
  - `scopesHash(scopes: readonly RequestedScope[]): Hex` — `keccak256(abi.encode((bytes32 namespaceId, uint8 permissions, uint8 provenancePolicy)[]))`, hashed in the order given
  - `capabilityId({ owner: Address; agentId: Hex; grantNonce: bigint; index: bigint; namespaceId: Hex; permissions: number; provenancePolicy: number; expiresAt: bigint }): Hex` — `(string "MIDA_CAPABILITY_V1", address, bytes32, uint256, uint256, bytes32, uint8, uint8, uint64)`
  - `grantDigest({ chainId: bigint; capabilityRegistry: Address; owner: Address; agentId: Hex; requestHash: Hex; manifestHash: Hex; manifestVersion: bigint; finalScopes: readonly GrantScope[]; expiresAt: bigint; grantNonce: bigint }): Hex` — `(string "MIDA_GRANT_V1", uint256, address, address, bytes32, bytes32, bytes32, uint64, bytes32 policyVersionHash, bytes32 treeVersionHash, bytes32 scopesHash, uint64, uint256)`
  - `interface CanonicalReference { relationCode: number; recordId: Hex }`
  - `canonicalReferences(references: readonly RecordReference[]): CanonicalReference[]` — sorted by `(relationCode, recordId)`, duplicates removed
  - `evidenceCommitment(references: readonly RecordReference[]): Hex` — `(string "MIDA_EVIDENCE_V1", (uint8 relation, bytes32 recordId)[])`
  - `p256RotationDigest({ chainId: bigint; capabilityRegistry: Address; owner: Address; newQx: bigint; newQy: bigint; nonce: bigint }): Hex` — `(string "MIDA_ROTATE_P256_V1", uint256, address, address, uint256, uint256, uint256)`
  - `cancelFastRevokeDigest({ chainId: bigint; capabilityRegistry: Address; owner: Address; revocationIntentId: Hex; apiCancellationNonce: bigint; expiresAt: bigint }): Hex` — `(string "MIDA_CANCEL_FAST_REVOKE_V1", uint256, address, address, bytes32, uint256, uint64)`
  - `canonicalizeOrigin(input: string, options?: { allowLocalhost?: boolean }): string`
  - `originHash(canonicalOrigin: string): Hex`
- Produces, in `typed-data.ts`:
  - `DOMAIN_NAMES = { capabilityRegistry: "Mida Capability Registry", accessRequest: "Mida Context", manifest: "Mida Agent Capability Manifest", httpRequest: "Mida Context API" }`
  - `midaDomain(name: string, chainId: bigint, verifyingContract: Address)` — `{ name, version: "1", chainId, verifyingContract }`
  - `ACCESS_REQUEST_TYPES`, `MANIFEST_BINDING_TYPES`, `HTTP_REQUEST_TYPES`, `AGENT_REGISTRATION_TYPES`, `SIGNER_ROTATION_TYPES` — exact field lists below
  - `type UnsignedAccessRequest = Omit<AccessRequest, "agentSignature">`
  - `accessRequestTypedData(request: UnsignedAccessRequest)`, `accessRequestHash(request: UnsignedAccessRequest): Hex` — `requestHash` everywhere is this full EIP-712 digest
  - `manifestBindingTypedData({ chainId; capabilityRegistry; bodyHash: Hex; agentId: Hex; manifestVersion: bigint })`
  - `canonicalTarget(pathname: string, query?: Record<string, string>): string`
  - `httpRequestTypedData({ chainId; capabilityRegistry; signer: Address; method: string; target: string; body: Uint8Array; timestamp: bigint; nonce: Hex })`
  - `agentRegistrationTypedData({ chainId; capabilityRegistry; agentId: Hex; operator: Address; signer: Address; encryptionPublicKey: Hex; encryptionKeyVersion: number; callbackOriginHash: Hex; capabilityManifestHash: Hex; capabilityManifestVersion: bigint })`
  - `signerRotationTypedData({ chainId; capabilityRegistry; agentId: Hex; newSigner: Address; rotationNonce: bigint })`

EIP-712 structs, which Solidity must hash with identical type strings:

```text
MidaAccessRequestV1(bytes32 requestId,bytes32 nonce,bytes32 agentId,bytes32 purposeIdHash,bytes32 callbackOriginHash,bytes32 manifestHash,uint64 manifestVersion,bytes32 policyVersionHash,bytes32 namespaceTreeVersionHash,bytes32 scopesHash,uint64 issuedAt,uint64 requestExpiresAt,uint64 capabilityExpiresAt)
ManifestBinding(bytes32 bodyHash,bytes32 agentId,uint64 manifestVersion)
MidaHttpRequestV1(address signer,bytes32 methodHash,bytes32 targetHash,bytes32 bodyHash,uint64 timestamp,bytes32 nonce)
MidaAgentRegistrationV1(bytes32 agentId,address operator,address signer,bytes32 encryptionPublicKey,uint32 encryptionKeyVersion,bytes32 callbackOriginHash,bytes32 capabilityManifestHash,uint64 capabilityManifestVersion)
MidaSignerRotationV1(bytes32 agentId,address newSigner,uint64 rotationNonce)
```

Domains: access requests use `"Mida Context"`; manifest bindings use `"Mida Agent Capability Manifest"`; HTTP requests use `"Mida Context API"`; agent registration and signer rotation use `"Mida Capability Registry"`. Every domain is version `"1"`, with the configured chain ID and the `CapabilityRegistry` address as `verifyingContract`.

- [ ] **Step 1: Write the failing identifier test**

`packages/protocol/test/ids.test.ts`:
```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { keccak256, zeroHash } from "viem"
import type { Hex } from "viem"
import {
  NAMESPACE_TREE_VERSION_HASH,
  OWNER_AUTHOR_ID,
  POLICY_VERSION_HASH,
  agentId,
  assertCanonicalScopes,
  canonicalReferences,
  canonicalizeOrigin,
  capabilityId,
  contextId,
  evidenceCommitment,
  grantDigest,
  hashString,
  isMidaError,
  namespaceId,
  originHash,
  scopesHash,
  sortScopes,
} from "@mida/protocol"

// Independent ABI builders: one 32-byte word per static value, then the string tail.
const uint = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0")
const word = (hex: string) => hex.slice(2).padStart(64, "0")
const stringTail = (value: string) => {
  const hex = Buffer.from(value, "utf8").toString("hex")
  return uint(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")
}
const leadingString = (tag: string, words: string[]): Hex =>
  `0x${uint((words.length + 1) * 32)}${words.join("")}${stringTail(tag)}`

const REGISTRY = "0x1111111111111111111111111111111111111111"
const OWNER = "0x2222222222222222222222222222222222222222"
const A32: Hex = `0x${"aa".repeat(32)}`
const B32: Hex = `0x${"bb".repeat(32)}`
const C32: Hex = `0x${"cc".repeat(32)}`

const failsWith = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

describe("object and agent identifiers (§4.3, §8.1)", () => {
  it("owner author id is bytes32(0)", () => {
    expect(OWNER_AUTHOR_ID).toBe(zeroHash)
  })

  it("contextId uses (string, uint256, address, address, bytes32, bytes32, bytes32)", () => {
    const nsId = namespaceId("goals.career")
    const expected = keccak256(
      leadingString("MIDA_CONTEXT_OBJECT_V1", [uint(31337), word(REGISTRY), word(OWNER), word(A32), word(nsId), word(B32)]),
    )
    expect(
      contextId({ chainId: 31337n, contextRegistry: REGISTRY, owner: OWNER, authorId: A32, namespaceId: nsId, objectNonce: B32 }),
    ).toBe(expected)
  })

  it("contextId changes when any nonce byte changes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        const nonce = `0x${Buffer.from(bytes).toString("hex")}` as Hex
        fc.pre(nonce !== B32)
        const base = { chainId: 31337n, contextRegistry: REGISTRY, owner: OWNER, authorId: zeroHash, namespaceId: A32 } as const
        expect(contextId({ ...base, objectNonce: nonce })).not.toBe(contextId({ ...base, objectNonce: B32 }))
      }),
    )
  })

  it("agentId uses (string, uint256, address, address, bytes32)", () => {
    const expected = keccak256(leadingString("MIDA_AGENT_V1", [uint(10143), word(REGISTRY), word(OWNER), word(C32)]))
    expect(agentId({ chainId: 10143n, capabilityRegistry: REGISTRY, operator: OWNER, agentSalt: C32 })).toBe(expected)
  })
})

describe("scopes, capabilities and grant digest (§10.4)", () => {
  const career = namespaceId("goals.career")
  const financial = namespaceId("financial")
  const scopes = sortScopes([
    { namespaceId: career, permissions: 1, provenancePolicy: 0 },
    { namespaceId: financial, permissions: 3, provenancePolicy: 1 },
  ])

  it("sorts by namespaceId and validates canonical scope lists", () => {
    expect(scopes[0]!.namespaceId < scopes[1]!.namespaceId).toBe(true)
    expect(() => assertCanonicalScopes(scopes)).not.toThrow()
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([...scopes].reverse()))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([scopes[0]!, scopes[0]!]))).toBe(true)
    expect(failsWith("INVALID_NAMESPACE", () => assertCanonicalScopes([{ namespaceId: A32, permissions: 1, provenancePolicy: 0 }]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([{ namespaceId: career, permissions: 0, provenancePolicy: 0 }]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([{ namespaceId: career, permissions: 16, provenancePolicy: 0 }]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([{ namespaceId: career, permissions: 1, provenancePolicy: 8 }]))).toBe(true)
  })

  it("scopesHash encodes a dynamic array of (bytes32, uint8, uint8)", () => {
    const body = scopes.map((s) => word(s.namespaceId) + uint(s.permissions) + uint(s.provenancePolicy)).join("")
    expect(scopesHash(scopes)).toBe(keccak256(`0x${uint(32)}${uint(scopes.length)}${body}`))
  })

  it("capabilityId uses (string, address, bytes32, uint256, uint256, bytes32, uint8, uint8, uint64)", () => {
    const expected = keccak256(
      leadingString("MIDA_CAPABILITY_V1", [word(OWNER), word(A32), uint(3), uint(1), word(career), uint(1), uint(0), uint(86_400)]),
    )
    expect(
      capabilityId({ owner: OWNER, agentId: A32, grantNonce: 3n, index: 1n, namespaceId: career, permissions: 1, provenancePolicy: 0, expiresAt: 86_400n }),
    ).toBe(expected)
  })

  it("grantDigest binds every §10.4 field in order", () => {
    const expected = keccak256(
      leadingString("MIDA_GRANT_V1", [
        uint(31337), word(REGISTRY), word(OWNER), word(A32), word(B32), word(C32), uint(2),
        word(POLICY_VERSION_HASH), word(NAMESPACE_TREE_VERSION_HASH), word(scopesHash(scopes)),
        uint(7_000), uint(9),
      ]),
    )
    expect(
      grantDigest({
        chainId: 31337n, capabilityRegistry: REGISTRY, owner: OWNER, agentId: A32, requestHash: B32,
        manifestHash: C32, manifestVersion: 2n, finalScopes: scopes, expiresAt: 7_000n, grantNonce: 9n,
      }),
    ).toBe(expected)
  })

  it("version hashes are keccak256 of the version strings", () => {
    expect(POLICY_VERSION_HASH).toBe(hashString("mida-grant-policy-v1"))
    expect(NAMESPACE_TREE_VERSION_HASH).toBe(hashString("mida-namespace-tree-v1"))
  })
})

describe("evidence commitments (§11.8)", () => {
  it("sorts by (relation code, record id) and removes duplicate pairs", () => {
    const refs = canonicalReferences([
      { relation: "confirmed_from", recordId: A32 },
      { relation: "supports", recordId: C32 },
      { relation: "supports", recordId: B32 },
      { relation: "supports", recordId: C32 },
    ])
    expect(refs).toEqual([
      { relationCode: 1, recordId: B32 },
      { relationCode: 1, recordId: C32 },
      { relationCode: 3, recordId: A32 },
    ])
  })

  it("encodes (string, (uint8, bytes32)[]) and binds the relation", () => {
    const tag = stringTail("MIDA_EVIDENCE_V1")
    const arrayOffset = 0x40 + tag.length / 2
    const expected = keccak256(`0x${uint(0x40)}${uint(arrayOffset)}${tag}${uint(1)}${uint(2)}${word(A32)}`)
    expect(evidenceCommitment([{ relation: "derived_from", recordId: A32 }])).toBe(expected)
    expect(evidenceCommitment([{ relation: "supports", recordId: A32 }])).not.toBe(expected)
  })
})

describe("callback origins (§4.3)", () => {
  it("canonicalizes to a lowercase origin without default port", () => {
    expect(canonicalizeOrigin("https://Vault.Mida.XYZ")).toBe("https://vault.mida.xyz")
    expect(canonicalizeOrigin("https://vault.mida.xyz:443")).toBe("https://vault.mida.xyz")
    expect(canonicalizeOrigin("https://vault.mida.xyz:8443")).toBe("https://vault.mida.xyz:8443")
    expect(canonicalizeOrigin("http://localhost:5173", { allowLocalhost: true })).toBe("http://localhost:5173")
  })

  it("rejects paths, queries, fragments, credentials and non-local http", () => {
    for (const bad of [
      "https://vault.mida.xyz/", "https://vault.mida.xyz/x", "https://vault.mida.xyz?a=1",
      "https://vault.mida.xyz#f", "https://u:p@vault.mida.xyz", "http://vault.mida.xyz",
      "http://localhost:5173", "ftp://vault.mida.xyz", "not a url",
    ]) {
      expect(failsWith("INVALID_WIRE", () => canonicalizeOrigin(bad)), bad).toBe(true)
    }
  })

  it("hashes the UTF-8 canonical origin", () => {
    expect(originHash("https://vault.mida.xyz")).toBe(hashString("https://vault.mida.xyz"))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/protocol/test/ids.test.ts`
Expected: FAIL — `agentId` is not exported.

- [ ] **Step 3: Implement `ids.ts`**

`packages/protocol/src/ids.ts`:
```ts
import { encodeAbiParameters, keccak256, stringToBytes, zeroHash } from "viem"
import type { Address, Hex } from "viem"
import {
  KNOWN_PERMISSION_BITS,
  KNOWN_PROVENANCE_BITS,
  NAMESPACE_TREE_VERSION,
  POLICY_VERSION,
  RECORD_RELATION_CODE,
} from "./constants.js"
import { MidaError } from "./errors.js"
import { namespaceById } from "./namespaces.js"
import type { GrantScope, RecordReference, RequestedScope } from "./types.js"
import { assertHex } from "./wire.js"

export const OWNER_AUTHOR_ID: Hex = zeroHash

export const hashString = (value: string): Hex => keccak256(stringToBytes(value))
export const POLICY_VERSION_HASH: Hex = hashString(POLICY_VERSION)
export const NAMESPACE_TREE_VERSION_HASH: Hex = hashString(NAMESPACE_TREE_VERSION)

export function agentId(input: {
  chainId: bigint
  capabilityRegistry: Address
  operator: Address
  agentSalt: Hex
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
      ["MIDA_AGENT_V1", input.chainId, input.capabilityRegistry, input.operator, input.agentSalt],
    ),
  )
}

export function contextId(input: {
  chainId: bigint
  contextRegistry: Address
  owner: Address
  authorId: Hex
  namespaceId: Hex
  objectNonce: Hex
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      ],
      [
        "MIDA_CONTEXT_OBJECT_V1", input.chainId, input.contextRegistry, input.owner,
        input.authorId, input.namespaceId, input.objectNonce,
      ],
    ),
  )
}

const SCOPE_ARRAY = {
  type: "tuple[]",
  components: [
    { name: "namespaceId", type: "bytes32" },
    { name: "permissions", type: "uint8" },
    { name: "provenancePolicy", type: "uint8" },
  ],
} as const

export function sortScopes<T extends RequestedScope>(scopes: readonly T[]): T[] {
  return [...scopes].sort((a, b) => (a.namespaceId < b.namespaceId ? -1 : a.namespaceId > b.namespaceId ? 1 : 0))
}

export function assertCanonicalScopes(scopes: readonly RequestedScope[]): void {
  if (scopes.length === 0) throw new MidaError("INVALID_WIRE", "scopes must be non-empty")
  let previous: string | undefined
  for (const scope of scopes) {
    assertHex(scope.namespaceId, 32)
    namespaceById(scope.namespaceId)
    if (previous !== undefined && scope.namespaceId <= previous) {
      throw new MidaError("INVALID_WIRE", "scopes must be strictly ascending by namespaceId")
    }
    const { permissions, provenancePolicy } = scope
    if (!Number.isInteger(permissions) || permissions <= 0 || (permissions & ~KNOWN_PERMISSION_BITS) !== 0) {
      throw new MidaError("INVALID_WIRE", "permissions must be non-zero known bits")
    }
    if (!Number.isInteger(provenancePolicy) || provenancePolicy < 0 || (provenancePolicy & ~KNOWN_PROVENANCE_BITS) !== 0) {
      throw new MidaError("INVALID_WIRE", "provenancePolicy must be known bits")
    }
    previous = scope.namespaceId
  }
}

/** Hashes in the order given. Call sortScopes and assertCanonicalScopes first. */
export function scopesHash(scopes: readonly RequestedScope[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [SCOPE_ARRAY],
      [scopes.map((s) => ({ namespaceId: s.namespaceId, permissions: s.permissions, provenancePolicy: s.provenancePolicy }))],
    ),
  )
}

export function capabilityId(input: {
  owner: Address
  agentId: Hex
  grantNonce: bigint
  index: bigint
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
  expiresAt: bigint
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" },
        { type: "bytes32" }, { type: "uint8" }, { type: "uint8" }, { type: "uint64" },
      ],
      [
        "MIDA_CAPABILITY_V1", input.owner, input.agentId, input.grantNonce, input.index,
        input.namespaceId, input.permissions, input.provenancePolicy, input.expiresAt,
      ],
    ),
  )
}

export function grantDigest(input: {
  chainId: bigint
  capabilityRegistry: Address
  owner: Address
  agentId: Hex
  requestHash: Hex
  manifestHash: Hex
  manifestVersion: bigint
  finalScopes: readonly GrantScope[]
  expiresAt: bigint
  grantNonce: bigint
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint256" },
      ],
      [
        "MIDA_GRANT_V1", input.chainId, input.capabilityRegistry, input.owner,
        input.agentId, input.requestHash, input.manifestHash, input.manifestVersion,
        POLICY_VERSION_HASH, NAMESPACE_TREE_VERSION_HASH, scopesHash(input.finalScopes), input.expiresAt, input.grantNonce,
      ],
    ),
  )
}

export interface CanonicalReference {
  relationCode: number
  recordId: Hex
}

export function canonicalReferences(references: readonly RecordReference[]): CanonicalReference[] {
  const mapped = references.map((reference) => {
    if (!Object.hasOwn(RECORD_RELATION_CODE, reference.relation)) {
      throw new MidaError("INVALID_WIRE", `unknown relation ${String(reference.relation)}`)
    }
    return { relationCode: RECORD_RELATION_CODE[reference.relation], recordId: assertHex(reference.recordId, 32) }
  })
  mapped.sort((a, b) => a.relationCode - b.relationCode || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
  return mapped.filter((reference, index) => {
    const prior = mapped[index - 1]
    return prior === undefined || prior.relationCode !== reference.relationCode || prior.recordId !== reference.recordId
  })
}

export function evidenceCommitment(references: readonly RecordReference[]): Hex {
  const canonical = canonicalReferences(references)
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "tuple[]", components: [{ name: "relation", type: "uint8" }, { name: "recordId", type: "bytes32" }] },
      ],
      ["MIDA_EVIDENCE_V1", canonical.map((r) => ({ relation: r.relationCode, recordId: r.recordId }))],
    ),
  )
}

export function p256RotationDigest(input: {
  chainId: bigint
  capabilityRegistry: Address
  owner: Address
  newQx: bigint
  newQy: bigint
  nonce: bigint
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      ],
      ["MIDA_ROTATE_P256_V1", input.chainId, input.capabilityRegistry, input.owner, input.newQx, input.newQy, input.nonce],
    ),
  )
}

export function cancelFastRevokeDigest(input: {
  chainId: bigint
  capabilityRegistry: Address
  owner: Address
  revocationIntentId: Hex
  apiCancellationNonce: bigint
  expiresAt: bigint
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
        { type: "bytes32" }, { type: "uint256" }, { type: "uint64" },
      ],
      [
        "MIDA_CANCEL_FAST_REVOKE_V1", input.chainId, input.capabilityRegistry, input.owner,
        input.revocationIntentId, input.apiCancellationNonce, input.expiresAt,
      ],
    ),
  )
}

const ORIGIN_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@]+$/i

export function canonicalizeOrigin(input: string, options: { allowLocalhost?: boolean } = {}): string {
  const trimmed = input.trim()
  if (!ORIGIN_SHAPE.test(trimmed)) {
    throw new MidaError("INVALID_WIRE", "origin must have no path, query, fragment or credentials")
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new MidaError("INVALID_WIRE", "origin is not a URL")
  }
  if (url.protocol === "https:") return url.origin
  if (url.protocol === "http:" && options.allowLocalhost === true && url.hostname === "localhost" && url.port !== "") {
    return url.origin
  }
  throw new MidaError("INVALID_WIRE", "origin must be https, or http://localhost:<port> in local development")
}

export const originHash = (canonicalOrigin: string): Hex => hashString(canonicalOrigin)
```

- [ ] **Step 4: Run the identifier test to verify it passes**

Append to `packages/protocol/src/index.ts`:
```ts
export * from "./ids.js"
```

Run: `pnpm vitest run packages/protocol/test/ids.test.ts`
Expected: PASS. If a layout test fails, the ABI types or field order in `ids.ts` differ from this task's Interfaces block. Fix `ids.ts`; never change the test's expected layout.

- [ ] **Step 5: Write the failing typed-data test**

`packages/protocol/test/typed-data.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { hashTypedData, keccak256, recoverTypedDataAddress } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Hex } from "viem"
import {
  ACCESS_REQUEST_TYPES,
  AGENT_REGISTRATION_TYPES,
  DOMAIN_NAMES,
  HTTP_REQUEST_TYPES,
  MANIFEST_BINDING_TYPES,
  SIGNER_ROTATION_TYPES,
  accessRequestHash,
  accessRequestTypedData,
  canonicalTarget,
  hashString,
  httpRequestTypedData,
  namespaceId,
  sortScopes,
} from "@mida/protocol"
import type { UnsignedAccessRequest } from "@mida/protocol"

const REGISTRY = "0x1111111111111111111111111111111111111111"
const A32: Hex = `0x${"aa".repeat(32)}`
const B32: Hex = `0x${"bb".repeat(32)}`
const C32: Hex = `0x${"cc".repeat(32)}`

const request: UnsignedAccessRequest = {
  v: 1,
  chainId: "31337",
  capabilityRegistry: REGISTRY,
  requestId: A32,
  nonce: B32,
  agentId: C32,
  purposeId: "career_coaching",
  callbackOrigin: "https://career.example",
  manifestHash: A32,
  manifestVersion: 1,
  policyVersion: "mida-grant-policy-v1",
  namespaceTreeVersion: "mida-namespace-tree-v1",
  scopes: sortScopes([
    { namespaceId: namespaceId("goals.career"), permissions: 1, provenancePolicy: 0 },
    { namespaceId: namespaceId("financial"), permissions: 1, provenancePolicy: 0 },
  ]),
  issuedAt: "1000",
  requestExpiresAt: "1600",
  capabilityExpiresAt: "0",
}

const fields = (list: ReadonlyArray<{ name: string; type: string }>) => list.map((f) => `${f.type} ${f.name}`)

describe("EIP-712 struct definitions are frozen (plan Task 5)", () => {
  it("matches the Solidity type strings field for field", () => {
    expect(fields(ACCESS_REQUEST_TYPES.MidaAccessRequestV1)).toEqual([
      "bytes32 requestId", "bytes32 nonce", "bytes32 agentId", "bytes32 purposeIdHash", "bytes32 callbackOriginHash",
      "bytes32 manifestHash", "uint64 manifestVersion", "bytes32 policyVersionHash", "bytes32 namespaceTreeVersionHash",
      "bytes32 scopesHash", "uint64 issuedAt", "uint64 requestExpiresAt", "uint64 capabilityExpiresAt",
    ])
    expect(fields(MANIFEST_BINDING_TYPES.ManifestBinding)).toEqual([
      "bytes32 bodyHash", "bytes32 agentId", "uint64 manifestVersion",
    ])
    expect(fields(HTTP_REQUEST_TYPES.MidaHttpRequestV1)).toEqual([
      "address signer", "bytes32 methodHash", "bytes32 targetHash", "bytes32 bodyHash", "uint64 timestamp", "bytes32 nonce",
    ])
    expect(fields(AGENT_REGISTRATION_TYPES.MidaAgentRegistrationV1)).toEqual([
      "bytes32 agentId", "address operator", "address signer", "bytes32 encryptionPublicKey", "uint32 encryptionKeyVersion",
      "bytes32 callbackOriginHash", "bytes32 capabilityManifestHash", "uint64 capabilityManifestVersion",
    ])
    expect(fields(SIGNER_ROTATION_TYPES.MidaSignerRotationV1)).toEqual([
      "bytes32 agentId", "address newSigner", "uint64 rotationNonce",
    ])
    expect(DOMAIN_NAMES).toEqual({
      capabilityRegistry: "Mida Capability Registry",
      accessRequest: "Mida Context",
      manifest: "Mida Agent Capability Manifest",
      httpRequest: "Mida Context API",
    })
  })
})

describe("access request signing (§13.2)", () => {
  it("round-trips a signature and binds the domain to chain and registry", async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const typedData = accessRequestTypedData(request)
    expect(typedData.domain).toEqual({ name: "Mida Context", version: "1", chainId: 31337n, verifyingContract: REGISTRY })
    const signature = await account.signTypedData(typedData)
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(account.address)
    expect(accessRequestHash(request)).toBe(hashTypedData(typedData))
  })

  it("changes the request hash when authority or expiry changes", () => {
    const base = accessRequestHash(request)
    const broader = { ...request, scopes: request.scopes.map((s) => ({ ...s, permissions: 3 })) }
    expect(accessRequestHash(broader)).not.toBe(base)
    expect(accessRequestHash({ ...request, capabilityExpiresAt: "5000" })).not.toBe(base)
    expect(accessRequestHash({ ...request, chainId: "10143" })).not.toBe(base)
  })
})

describe("HTTP request authentication (§12.1)", () => {
  it("builds a canonical target with sorted query parameters", () => {
    expect(canonicalTarget("/epoch-wraps", { readEpoch: "2", owner: "0xab", agentId: "0x01" })).toBe(
      "/epoch-wraps?agentId=0x01&owner=0xab&readEpoch=2",
    )
    expect(canonicalTarget("/objects")).toBe("/objects")
  })

  it("uppercases the method and hashes an empty body as keccak256 of no bytes", () => {
    const typed = httpRequestTypedData({
      chainId: 31337n, capabilityRegistry: REGISTRY, signer: REGISTRY, method: "get",
      target: "/objects", body: new Uint8Array(), timestamp: 1_000n, nonce: A32,
    })
    expect(typed.message.methodHash).toBe(hashString("GET"))
    expect(typed.message.bodyHash).toBe(keccak256(new Uint8Array()))
    expect(typed.message.bodyHash).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
    expect(typed.domain.name).toBe("Mida Context API")
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm vitest run packages/protocol/test/typed-data.test.ts`
Expected: FAIL — `ACCESS_REQUEST_TYPES` is not exported.

- [ ] **Step 7: Implement `typed-data.ts`**

`packages/protocol/src/typed-data.ts`:
```ts
import { hashTypedData, keccak256 } from "viem"
import type { Address, Hex } from "viem"
import { hashString, originHash, scopesHash } from "./ids.js"
import type { AccessRequest } from "./types.js"
import { decodeUint64 } from "./wire.js"

export type UnsignedAccessRequest = Omit<AccessRequest, "agentSignature">

export const DOMAIN_NAMES = {
  capabilityRegistry: "Mida Capability Registry",
  accessRequest: "Mida Context",
  manifest: "Mida Agent Capability Manifest",
  httpRequest: "Mida Context API",
} as const

export function midaDomain(name: string, chainId: bigint, verifyingContract: Address) {
  return { name, version: "1", chainId, verifyingContract }
}

export const ACCESS_REQUEST_TYPES = {
  MidaAccessRequestV1: [
    { name: "requestId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "agentId", type: "bytes32" },
    { name: "purposeIdHash", type: "bytes32" },
    { name: "callbackOriginHash", type: "bytes32" },
    { name: "manifestHash", type: "bytes32" },
    { name: "manifestVersion", type: "uint64" },
    { name: "policyVersionHash", type: "bytes32" },
    { name: "namespaceTreeVersionHash", type: "bytes32" },
    { name: "scopesHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "requestExpiresAt", type: "uint64" },
    { name: "capabilityExpiresAt", type: "uint64" },
  ],
} as const

export const MANIFEST_BINDING_TYPES = {
  ManifestBinding: [
    { name: "bodyHash", type: "bytes32" },
    { name: "agentId", type: "bytes32" },
    { name: "manifestVersion", type: "uint64" },
  ],
} as const

export const HTTP_REQUEST_TYPES = {
  MidaHttpRequestV1: [
    { name: "signer", type: "address" },
    { name: "methodHash", type: "bytes32" },
    { name: "targetHash", type: "bytes32" },
    { name: "bodyHash", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const

export const AGENT_REGISTRATION_TYPES = {
  MidaAgentRegistrationV1: [
    { name: "agentId", type: "bytes32" },
    { name: "operator", type: "address" },
    { name: "signer", type: "address" },
    { name: "encryptionPublicKey", type: "bytes32" },
    { name: "encryptionKeyVersion", type: "uint32" },
    { name: "callbackOriginHash", type: "bytes32" },
    { name: "capabilityManifestHash", type: "bytes32" },
    { name: "capabilityManifestVersion", type: "uint64" },
  ],
} as const

export const SIGNER_ROTATION_TYPES = {
  MidaSignerRotationV1: [
    { name: "agentId", type: "bytes32" },
    { name: "newSigner", type: "address" },
    { name: "rotationNonce", type: "uint64" },
  ],
} as const

export function accessRequestTypedData(request: UnsignedAccessRequest) {
  return {
    domain: midaDomain(DOMAIN_NAMES.accessRequest, decodeUint64(request.chainId), request.capabilityRegistry),
    types: ACCESS_REQUEST_TYPES,
    primaryType: "MidaAccessRequestV1" as const,
    message: {
      requestId: request.requestId,
      nonce: request.nonce,
      agentId: request.agentId,
      purposeIdHash: hashString(request.purposeId),
      callbackOriginHash: originHash(request.callbackOrigin),
      manifestHash: request.manifestHash,
      manifestVersion: BigInt(request.manifestVersion),
      policyVersionHash: hashString(request.policyVersion),
      namespaceTreeVersionHash: hashString(request.namespaceTreeVersion),
      scopesHash: scopesHash(request.scopes),
      issuedAt: decodeUint64(request.issuedAt),
      requestExpiresAt: decodeUint64(request.requestExpiresAt),
      capabilityExpiresAt: decodeUint64(request.capabilityExpiresAt),
    },
  }
}

export const accessRequestHash = (request: UnsignedAccessRequest): Hex =>
  hashTypedData(accessRequestTypedData(request))

export function manifestBindingTypedData(input: {
  chainId: bigint
  capabilityRegistry: Address
  bodyHash: Hex
  agentId: Hex
  manifestVersion: bigint
}) {
  return {
    domain: midaDomain(DOMAIN_NAMES.manifest, input.chainId, input.capabilityRegistry),
    types: MANIFEST_BINDING_TYPES,
    primaryType: "ManifestBinding" as const,
    message: { bodyHash: input.bodyHash, agentId: input.agentId, manifestVersion: input.manifestVersion },
  }
}

export function canonicalTarget(pathname: string, query: Record<string, string> = {}): string {
  const keys = Object.keys(query).sort()
  if (keys.length === 0) return pathname
  const pairs = keys.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key]!)}`)
  return `${pathname}?${pairs.join("&")}`
}

export function httpRequestTypedData(input: {
  chainId: bigint
  capabilityRegistry: Address
  signer: Address
  method: string
  target: string
  body: Uint8Array
  timestamp: bigint
  nonce: Hex
}) {
  return {
    domain: midaDomain(DOMAIN_NAMES.httpRequest, input.chainId, input.capabilityRegistry),
    types: HTTP_REQUEST_TYPES,
    primaryType: "MidaHttpRequestV1" as const,
    message: {
      signer: input.signer,
      methodHash: hashString(input.method.toUpperCase()),
      targetHash: hashString(input.target),
      bodyHash: keccak256(input.body),
      timestamp: input.timestamp,
      nonce: input.nonce,
    },
  }
}

export function agentRegistrationTypedData(input: {
  chainId: bigint
  capabilityRegistry: Address
  agentId: Hex
  operator: Address
  signer: Address
  encryptionPublicKey: Hex
  encryptionKeyVersion: number
  callbackOriginHash: Hex
  capabilityManifestHash: Hex
  capabilityManifestVersion: bigint
}) {
  return {
    domain: midaDomain(DOMAIN_NAMES.capabilityRegistry, input.chainId, input.capabilityRegistry),
    types: AGENT_REGISTRATION_TYPES,
    primaryType: "MidaAgentRegistrationV1" as const,
    message: {
      agentId: input.agentId,
      operator: input.operator,
      signer: input.signer,
      encryptionPublicKey: input.encryptionPublicKey,
      encryptionKeyVersion: input.encryptionKeyVersion,
      callbackOriginHash: input.callbackOriginHash,
      capabilityManifestHash: input.capabilityManifestHash,
      capabilityManifestVersion: input.capabilityManifestVersion,
    },
  }
}

export function signerRotationTypedData(input: {
  chainId: bigint
  capabilityRegistry: Address
  agentId: Hex
  newSigner: Address
  rotationNonce: bigint
}) {
  return {
    domain: midaDomain(DOMAIN_NAMES.capabilityRegistry, input.chainId, input.capabilityRegistry),
    types: SIGNER_ROTATION_TYPES,
    primaryType: "MidaSignerRotationV1" as const,
    message: { agentId: input.agentId, newSigner: input.newSigner, rotationNonce: input.rotationNonce },
  }
}
```

- [ ] **Step 8: Export and run to verify everything passes**

Append to `packages/protocol/src/index.ts`:
```ts
export * from "./typed-data.js"
```

Run:
```bash
pnpm vitest run packages/protocol
pnpm typecheck
```
Expected: every protocol test PASS. Typecheck exits 0. If `account.signTypedData(typedData)` fails typechecking because viem cannot narrow `domain.name` from `string`, change `midaDomain`'s return to `as const` and re-run; do not loosen the struct definitions.

- [ ] **Step 9: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): deterministic ids, origins and EIP-712 definitions shared with Solidity

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```
```
