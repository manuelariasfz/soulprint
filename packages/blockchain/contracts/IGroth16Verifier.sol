// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IGroth16Verifier
 * @notice Interface del verificador Groth16 auto-generado por snarkjs.
 * El contrato real se genera con: snarkjs zkey export solidityverifier
 *
 * NOTA: 3 public signals → nullifier + context_tag + commitment
 * (match con soulprint_identity_final.zkey)
 */
interface IGroth16Verifier {
    function verifyProof(
        uint256[2]    calldata a,
        uint256[2][2] calldata b,
        uint256[2]    calldata c,
        uint256[3]    calldata pubSignals
    ) external view returns (bool);
}
