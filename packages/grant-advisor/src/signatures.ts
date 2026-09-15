import { MidaError, accessRequestTypedData } from "@mida/protocol"
import type { AccessRequest, Address, Hex } from "@mida/protocol"
import { Secp256k1, Signature } from "ox"
import { hashTypedData, isAddressEqual } from "viem"
import type { TypedDataDefinition } from "viem"

const SECP256K1_HALF_N = BigInt("0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0")

/**
 * Synchronous EIP-712 signer recovery. viem's verifyTypedData is async, but adviseGrant is a pure
 * synchronous function (§14.5), so recovery uses viem's hashTypedData plus ox's secp256k1 recovery.
 * Tests cross-check the result against viem's verifyTypedData. EOA signers only; ERC-1271 is not supported.
 */
export function recoverTypedDataSigner(typedData: TypedDataDefinition, signature: Hex): Address | null {
  try {
    if (!/^0x[0-9a-f]{130}$/.test(signature)) return null
    if (BigInt(`0x${signature.slice(66, 130)}`) > SECP256K1_HALF_N) return null
    const v = parseInt(signature.slice(130, 132), 16)
    if (v !== 27 && v !== 28) return null
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
