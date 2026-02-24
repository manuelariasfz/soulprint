// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IGroth16Verifier.sol";

/**
 * @title MockGroth16Verifier
 * @notice Verifier mock para tests — NUNCA usar en producción.
 * En producción usar el contrato generado por:
 *   snarkjs zkey export solidityverifier soulprint_identity_final.zkey verifier.sol
 */
contract MockGroth16Verifier is IGroth16Verifier {
    /**
     * @notice Acepta cualquier proof con publicInputs[0] != 0.
     * En producción, este contrato verifica la matemática Groth16 real.
     */
    function verifyProof(
        uint256[2]    calldata,    // a — ignorado en mock
        uint256[2][2] calldata,    // b — ignorado en mock
        uint256[2]    calldata,    // c — ignorado en mock
        uint256[2]    calldata input
    ) external pure returns (bool) {
        // Mock: válido si el nullifier (input[0]) no es cero
        return input[0] != 0;
    }
}
