import type { WebAuthnClient } from "@category-labs/mera"
import { toBytes } from "./bytes.js"

/**
 * The custom WebAuthnClient the check page hands to Mera. Mera's own client is a thin wrapper over
 * navigator.credentials that throws away exactly what our contract needs — the public key on create
 * and the raw assertion on get. This client performs the same two ceremonies, captures those values
 * as a side effect, and counts every browser invocation so the page can say how many prompts one
 * click really caused.
 *
 * One deliberate deviation: on `get` the page asks for a signature over OUR fixed test challenge
 * instead of the random challenge Mera generated. Mera never reads the assertion — it only wants
 * the PRF output — so substituting the challenge changes nothing Mera sees and gives the page an
 * assertion it can verify itself and on chain.
 */

export interface CredentialsContainerLike {
  create(options?: { publicKey?: unknown }): Promise<unknown>
  get(options?: { publicKey?: unknown }): Promise<unknown>
}

export interface InvocationCounts {
  create: number
  get: number
}

export interface CreateCapture {
  credentialId: Uint8Array
  algorithm: number | null
  spki: Uint8Array | null
  transports: string[] | null
  attachment: string | null
  prfEnabled: boolean
  prfOutput: Uint8Array | undefined
}

export interface GetCapture {
  credentialId: Uint8Array
  authenticatorData: Uint8Array | null
  clientDataJSON: Uint8Array | null
  signatureDer: Uint8Array | null
  attachment: string | null
  prfOutput: Uint8Array | undefined
}

export interface CheckClientDeps {
  credentials: CredentialsContainerLike
  /** The fixed test challenge substituted for Mera's random one on `get`. */
  challenge: Uint8Array
  counts: InvocationCounts
  /** Filled in as ceremonies complete. Never holds anything the report may not show — no PRF bytes land here. */
  capture: { create: CreateCapture | null; get: GetCapture | null }
}

interface PublicKeyCredentialLike {
  type: string
  rawId: ArrayBuffer | ArrayBufferView
  authenticatorAttachment?: string | null
  response: Record<string, unknown>
  getClientExtensionResults(): {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView | ArrayLike<number> } }
  }
}

function asPublicKeyCredential(credential: unknown): PublicKeyCredentialLike {
  const c = credential as PublicKeyCredentialLike | null | undefined
  if (c?.type !== "public-key" || !c.rawId || typeof c.getClientExtensionResults !== "function") {
    throw new Error("the browser did not return a passkey credential")
  }
  return c
}

function readPrf(c: PublicKeyCredentialLike): { enabled: boolean; output: Uint8Array | undefined } {
  const prf = c.getClientExtensionResults().prf
  return {
    enabled: prf?.enabled === true,
    output: prf?.results?.first !== undefined ? toBytes(prf.results.first) : undefined,
  }
}

export function makeCheckClient(deps: CheckClientDeps): WebAuthnClient {
  return {
    async createCredential(request) {
      deps.counts.create += 1
      const credential = asPublicKeyCredential(
        await deps.credentials.create({
          publicKey: {
            rp: { id: request.rp.id, name: request.rp.name },
            user: { id: request.user.id, name: request.user.name, displayName: request.user.displayName },
            challenge: request.challenge,
            pubKeyCredParams: request.algorithms.map((alg) => ({ type: "public-key", alg })),
            attestation: "none",
            authenticatorSelection: {
              residentKey: "required",
              requireResidentKey: true,
              userVerification: "required",
            },
            extensions: { prf: { eval: { first: request.prfSalt } } },
            ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
          },
        }),
      )

      const response = credential.response
      const getPublicKey = response["getPublicKey"] as (() => ArrayBuffer | null) | undefined
      const getAlgorithm = response["getPublicKeyAlgorithm"] as (() => number) | undefined
      const getTransports = response["getTransports"] as (() => string[]) | undefined
      const spki = typeof getPublicKey === "function" ? getPublicKey.call(response) : null
      const prf = readPrf(credential)

      deps.capture.create = {
        credentialId: toBytes(credential.rawId),
        algorithm: typeof getAlgorithm === "function" ? getAlgorithm.call(response) : null,
        spki: spki ? toBytes(spki) : null,
        transports: typeof getTransports === "function" ? getTransports.call(response) : null,
        attachment: credential.authenticatorAttachment ?? null,
        prfEnabled: prf.enabled,
        prfOutput: prf.output,
      }

      return {
        credentialId: toBytes(credential.rawId),
        prfEnabled: prf.enabled,
        ...(deps.capture.create.transports !== null ? { transports: deps.capture.create.transports } : {}),
        ...(prf.output !== undefined ? { prfOutput: prf.output } : {}),
      }
    },

    async getCredential(request) {
      deps.counts.get += 1
      const credential = asPublicKeyCredential(
        await deps.credentials.get({
          publicKey: {
            rpId: request.rpId,
            challenge: deps.challenge,
            userVerification: "required",
            extensions: { prf: { eval: { first: request.prfSalt } } },
            ...(request.allowCredential !== undefined
              ? {
                  allowCredentials: [
                    {
                      type: "public-key",
                      id: request.allowCredential.credentialId,
                      ...(request.allowCredential.transports !== undefined
                        ? { transports: request.allowCredential.transports }
                        : {}),
                    },
                  ],
                }
              : {}),
            ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
          },
        }),
      )

      const response = credential.response
      const prf = readPrf(credential)
      const authData = response["authenticatorData"]
      const clientData = response["clientDataJSON"]
      const signature = response["signature"]

      deps.capture.get = {
        credentialId: toBytes(credential.rawId),
        authenticatorData: authData !== undefined ? toBytes(authData as ArrayBuffer) : null,
        clientDataJSON: clientData !== undefined ? toBytes(clientData as ArrayBuffer) : null,
        signatureDer: signature !== undefined ? toBytes(signature as ArrayBuffer) : null,
        attachment: credential.authenticatorAttachment ?? null,
        prfOutput: prf.output,
      }

      return {
        credentialId: toBytes(credential.rawId),
        ...(prf.output !== undefined ? { prfOutput: prf.output } : {}),
      }
    },
  }
}
