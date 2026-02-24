/**
 * Soulprint Protocol Constants — SIP v0.1
 *
 * Estas constantes son INMUTABLES a nivel de protocolo.
 * Todos los nodos de la red deben operar con los mismos valores.
 * Cambiarlas requiere un nuevo SIP (Soulprint Improvement Proposal)
 * y una actualización de versión de protocolo.
 *
 * Object.freeze() garantiza que no se modifiquen en runtime.
 */

export const PROTOCOL = Object.freeze({
  // ── Versión del protocolo ──────────────────────────────────────────────────
  /** Versión del protocolo SIP. Nodos con versiones distintas se rechazan. */
  VERSION: "sip/0.1" as const,

  // ── Score limits ───────────────────────────────────────────────────────────
  /** Score máximo posible (identidad + reputación). */
  MAX_SCORE: 100,

  /** Máximo de la sub-puntuación de identidad humana. */
  IDENTITY_MAX: 80,

  /** Máximo de la sub-puntuación de reputación de bot. */
  REPUTATION_MAX: 20,

  /** Reputación neutral inicial para todo bot nuevo. */
  DEFAULT_REPUTATION: 10,

  // ── Score floors (INAMOVIBLES) ─────────────────────────────────────────────
  /**
   * PISO MÍNIMO DE SCORE — ningún threshold de servicio puede estar por debajo.
   * Si un servicio configura minScore < SCORE_FLOOR, se clampea a este valor.
   * Garantiza que endpoints protegidos siempre exigen identidad mínima.
   */
  SCORE_FLOOR: 65,

  /**
   * Piso de score para identidades con DocumentVerified.
   * Una persona con documento verificado nunca puede quedar por debajo de este
   * valor total, sin importar cuántas attestaciones negativas reciba.
   */
  VERIFIED_SCORE_FLOOR: 52,

  /**
   * Score mínimo de un servicio para poder emitir attestations.
   * Servicio sin este score no puede calificar el comportamiento de bots.
   */
  MIN_ATTESTER_SCORE: 65,

  // ── Retry logic ────────────────────────────────────────────────────────────
  /** Número máximo de reintentos al verificar un token con un nodo validador. */
  VERIFY_RETRY_MAX: 3,

  /** Delay base en ms para el backoff exponencial de reintentos. */
  VERIFY_RETRY_BASE_MS: 500,

  /** Delay máximo entre reintentos (cap del backoff). */
  VERIFY_RETRY_MAX_MS: 8000,

  /** Jitter máximo en ms para evitar thundering herd entre clientes. */
  VERIFY_RETRY_JITTER_MS: 200,

  // ── Attestation rules ──────────────────────────────────────────────────────
  /** Tiempo máximo que puede tener una attestation para ser aceptada (segundos). */
  ATT_MAX_AGE_SECONDS: 3600,

  /** Clock skew máximo permitido entre cliente y nodo validador (segundos). */
  CLOCK_SKEW_MAX_SECONDS: 300,

  // ── Token lifetime ─────────────────────────────────────────────────────────
  /** Tiempo de vida por defecto de un SPT token (6 meses en segundos). */
  TOKEN_DEFAULT_LIFETIME_SECONDS: 60 * 60 * 24 * 180,

  // ── Network ────────────────────────────────────────────────────────────────
  /** Puerto HTTP por defecto del nodo validador. */
  DEFAULT_HTTP_PORT: 4888,

  /** Puerto P2P por defecto del nodo validador (HTTP + 2000). */
  DEFAULT_P2P_PORT: 6888,

  /** Timeout en ms para el gossip HTTP entre nodos. */
  GOSSIP_TIMEOUT_MS: 3000,

  /** Requests máximos por minuto por IP en el nodo validador. */
  RATE_LIMIT_MAX: 100,

  /** Ventana de tiempo del rate limiter (ms). */
  RATE_LIMIT_WINDOW_MS: 60_000,

  // ── Biometric thresholds (INAMOVIBLES) ─────────────────────────────────────
  /**
   * Similitud mínima para verificación DOCUMENTO vs SELFIE.
   * Fotos de documentos son más antiguas/pequeñas que selfies en vivo.
   * Validado con cédula CO real: similitud 0.365 → VERIFICADO.
   * Una persona diferente obtiene < 0.15 con el mismo modelo.
   *
   * NO MODIFICAR en runtime. Cambiar requiere nuevo SIP + bump de versión.
   */
  FACE_SIM_DOC_SELFIE: 0.35,

  /**
   * Similitud mínima para verificación SELFIE vs SELFIE (re-verificación,
   * liveness check, o comparación entre sesiones del mismo usuario).
   * Umbral más estricto porque ambas fotos son recientes y de alta calidad.
   */
  FACE_SIM_SELFIE_SELFIE: 0.65,

  /**
   * Número de dimensiones del embedding usadas para derivar el face_key.
   * Las primeras 32 dims capturan suficiente identidad y son más robustas
   * ante variaciones de iluminación/ángulo.
   */
  FACE_KEY_DIMS: 32,

  /**
   * Decimales de precisión al redondear las dimensiones del embedding.
   * 1 decimal absorbe el ruido natural de InsightFace (±0.01).
   * Garantiza que la misma cara → mismo face_key aunque la foto varíe levemente.
   */
  FACE_KEY_PRECISION: 1,
} as const);

// Tipo derivado — útil para tipado estricto en TypeScript
export type ProtocolConstants = typeof PROTOCOL;

/**
 * Verifica que este nodo es compatible con la versión de protocolo recibida.
 * Retorna true si son compatibles, false si hay que rechazar la conexión.
 */
export function isProtocolCompatible(remoteVersion: string): boolean {
  // Por ahora: solo aceptamos la misma versión exacta
  // En el futuro: parsear semver y aceptar minor patches compatibles
  return remoteVersion === PROTOCOL.VERSION;
}

/**
 * Clampea un minScore al floor del protocolo.
 * Ningún servicio puede exigir menos del SCORE_FLOOR.
 *
 * @example
 * clampMinScore(40)   // → 65  (clamped al floor)
 * clampMinScore(80)   // → 80  (ya está por encima del floor)
 * clampMinScore(0)    // → 65  (clamped al floor)
 */
export function clampMinScore(requested: number): number {
  return Math.max(PROTOCOL.SCORE_FLOOR, Math.min(PROTOCOL.MAX_SCORE, requested));
}

/**
 * Calcula el score total respetando el floor de identidad verificada.
 * Si el bot tiene DocumentVerified, su score total nunca puede bajar
 * de VERIFIED_SCORE_FLOOR sin importar las attestaciones negativas.
 */
export function computeTotalScoreWithFloor(
  identityScore: number,
  reputationScore: number,
  hasDocumentVerified: boolean
): number {
  const raw = Math.min(PROTOCOL.MAX_SCORE, identityScore + reputationScore);
  if (hasDocumentVerified) {
    return Math.max(PROTOCOL.VERIFIED_SCORE_FLOOR, raw);
  }
  return raw;
}

/**
 * Retry con backoff exponencial + jitter para llamadas a nodos validadores.
 * Respeta VERIFY_RETRY_MAX, VERIFY_RETRY_BASE_MS y VERIFY_RETRY_MAX_MS.
 *
 * @param fn     - Función async que puede fallar
 * @param label  - Label para logs
 * @returns      - Resultado de fn al tener éxito
 * @throws       - Error del último intento si todos fallan
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label = "soulprint-verify"
): Promise<T> {
  let lastError: Error = new Error("No attempts made");

  for (let attempt = 1; attempt <= PROTOCOL.VERIFY_RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === PROTOCOL.VERIFY_RETRY_MAX) break;

      // Backoff exponencial con jitter
      const baseDelay  = PROTOCOL.VERIFY_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      const jitter     = Math.random() * PROTOCOL.VERIFY_RETRY_JITTER_MS;
      const delay      = Math.min(baseDelay + jitter, PROTOCOL.VERIFY_RETRY_MAX_MS);

      console.warn(
        `[${label}] Attempt ${attempt}/${PROTOCOL.VERIFY_RETRY_MAX} failed: ${lastError.message}. Retrying in ${Math.round(delay)}ms...`
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error(
    `[${label}] All ${PROTOCOL.VERIFY_RETRY_MAX} attempts failed. Last error: ${lastError.message}`
  );
}
