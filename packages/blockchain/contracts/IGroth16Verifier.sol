// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IGroth16Verifier
 * @notice Interface del verificador Groth16 auto-generado por snarkjs.
 * El contrato real se genera con: snarkjs zkey export solidityverifier
 */
interface IGroth16Verifier {
    function verifyProof(
        uint256[2]    calldata a,
        uint256[2][2] calldata b,
        uint256[2]    calldata c,
        uint256[2]    calldata input
    ) external view returns (bool);
}
