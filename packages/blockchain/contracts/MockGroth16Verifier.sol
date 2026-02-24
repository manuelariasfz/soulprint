// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IGroth16Verifier.sol";

/**
 * @title MockGroth16Verifier
 * @notice Verifier MOCK para tests locales — NUNCA usar en producción.
 *
 * DIFERENCIA vs Groth16Verifier real:
 *   Mock:  acepta cualquier proof donde pubSignals[0] != 0
 *   Real:  verifica la matemática Groth16 completa on-chain
 *
 * Solo se despliega cuando SOULPRINT_NETWORK = "localhost" | "hardhat".
 * En base-sepolia y mainnet se usa Groth16Verifier (generado por snarkjs).
 */
contract MockGroth16Verifier is IGroth16Verifier {
    /// @notice Mock: válido si el nullifier (pubSignals[0]) no es cero.
    function verifyProof(
        uint256[2]    calldata,          // a — ignorado
        uint256[2][2] calldata,          // b — ignorado
        uint256[2]    calldata,          // c — ignorado
        uint256[3]    calldata pubSignals // [nullifier, context_tag, commitment]
    ) external pure returns (bool) {
        return pubSignals[0] != 0;
    }
}
