// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Strict secp256k1 recovery for EIP-712 signatures from viem accounts: 65 bytes (r, s, v),
///         low-s only, v in {27, 28}. Returns address(0) for anything malformed; callers compare
///         the result with an expected non-zero signer.
library SignatureRecovery {
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    function recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (uint256(s) > HALF_ORDER) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
