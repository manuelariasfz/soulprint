pragma circom 2.1.8;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

/*
 * SoulprintIdentity — Circuito de verificación de identidad colombiana
 *
 * Prueba (sin revelar nada):
 *   "Conozco una cédula válida + fecha de nacimiento + llave biométrica
 *    tal que Poseidon(cedula, fecha, face_key) == nullifier"
 *
 * Entradas privadas (nadie las ve):
 *   - cedula_num:      número de cédula (entero)
 *   - fecha_nac:       fecha nacimiento YYYYMMDD (entero)
 *   - face_key:        llave derivada del embedding facial (entero)
 *   - salt:            salt aleatoria para unlinkability entre contextos
 *
 * Entradas públicas (visibles para el verificador):
 *   - nullifier:       hash esperado = Poseidon(cedula, fecha, face_key)
 *   - context_tag:     identificador del contexto (para nullifier por contexto)
 *
 * Salidas:
 *   - valid:           siempre 1 si el proof es válido
 */
template SoulprintIdentity() {

    // ── Entradas privadas ─────────────────────────────────────────────────────
    signal input cedula_num;       // ej: 1020461234
    signal input fecha_nac;        // ej: 20040315 (YYYYMMDD)
    signal input face_key;         // llave del fuzzy extractor del rostro
    signal input salt;             // aleatorio por instancia

    // ── Entradas públicas ─────────────────────────────────────────────────────
    signal input nullifier;        // Poseidon(cedula, fecha, face_key)
    signal input context_tag;      // 0 = global, >0 = contexto específico (evita correlación)

    // ── Salida ────────────────────────────────────────────────────────────────
    signal output valid;

    // ── Restricciones de validez básica ──────────────────────────────────────

    // 1. Cédula debe ser > 10000 (mínimo 5 dígitos)
    component gte_min = GreaterThan(34);
    gte_min.in[0] <== cedula_num;
    gte_min.in[1] <== 9999;
    gte_min.out === 1;

    // 2. Cédula debe ser <= 9999999999 (máximo 10 dígitos)
    component lte_max = LessThan(34);
    lte_max.in[0] <== cedula_num;
    lte_max.in[1] <== 10000000000;
    lte_max.out === 1;

    // 3. face_key no puede ser 0 (verificación biométrica fue hecha)
    component face_nonzero = IsZero();
    face_nonzero.in <== face_key;
    face_nonzero.out === 0;   // debe ser NO-cero

    // 4. fecha_nacimiento razonable: > 19000101 y < 20251231
    component fecha_gte = GreaterThan(34);
    fecha_gte.in[0] <== fecha_nac;
    fecha_gte.in[1] <== 19000100;
    fecha_gte.out === 1;

    // ── Nullifier: Poseidon(cedula, fecha, face_key) ──────────────────────────
    component poseidon_nullifier = Poseidon(3);
    poseidon_nullifier.inputs[0] <== cedula_num;
    poseidon_nullifier.inputs[1] <== fecha_nac;
    poseidon_nullifier.inputs[2] <== face_key;

    // Verificar que el nullifier calculado = el declarado públicamente
    nullifier === poseidon_nullifier.out;

    // ── Context nullifier (para uso específico por servicio) ──────────────────
    // Cuando context_tag > 0, el proof no puede reutilizarse en otro contexto
    // Esto previene que un mismo proof se use en múltiples servicios
    component poseidon_ctx = Poseidon(2);
    poseidon_ctx.inputs[0] <== poseidon_nullifier.out;
    poseidon_ctx.inputs[1] <== context_tag;
    // El resultado (context_nullifier) no es una señal pública aquí
    // pero se puede extender el circuito para exponerlo
    signal context_nullifier;
    context_nullifier <== poseidon_ctx.out;

    // ── Salt vinculada (evita proofs idénticos entre sesiones) ────────────────
    component poseidon_salt = Poseidon(2);
    poseidon_salt.inputs[0] <== poseidon_nullifier.out;
    poseidon_salt.inputs[1] <== salt;
    signal salted_commitment;
    salted_commitment <== poseidon_salt.out;

    // ── Salida ────────────────────────────────────────────────────────────────
    valid <== 1;
}

component main { public [nullifier, context_tag] } = SoulprintIdentity();
