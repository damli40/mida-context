import { MidaError, accessRequestTypedData } from "@mida/protocol"
import type { AccessRequest, Address, Hex } from "@mida/protocol"
import { Secp256k1, Signature } from "ox"
import { hashTypedData, isAddressEqual } from "viem"
import type { TypedDataDefinition } from "viem"

/**
 * Synchronous EIP-712 signer recovery. viem's verifyTypedData is async, but adviseGrant is a pure
 * synchronous function (§14.5), so recovery uses viem's hashTypedData plus ox's secp256k1 recovery.
 * Tests cross-check the result against viem's verifyTypedData. EOA signers only; ERC-1271 is not supported.
 */
export function recoverTypedDataSigner(typedData: TypedDataDefinition, signature: Hex): Address | null {
  try {
    return Secp256k1.recoverAddress({ payload: hashTypedData(typedData), signature: Signature.fromHex(signature) })
  } catch {
    return null
  }
}

export function isTypedDataSignedBy(typedData: TypedDataDefinition, signature: Hex, expected: Address): boolean {
  const recovered = recoverTypedDataSigner(typedData, signature)
  return recovered !== null && isAddressEqual(recovered, expected)
}

export function assertAccessRequestSignature(request: AccessRequest, signer: Address): void {
  const { agentSignature, ...unsigned } = request
  const typedData = accessRequestTypedData(unsigned)
  if (!isTypedDataSignedBy(typedData, agentSignature, signer)) {
    throw new MidaError("REQUEST_SIGNATURE_INVALID", "request is not signed by the registered agent signer")
  }
}
