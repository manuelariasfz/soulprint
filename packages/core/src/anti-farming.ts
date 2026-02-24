/**
 * Soulprint Anti-Farming Module
 *
 * Detecta y penaliza intentos de farmeo de puntos de reputación.
 *
 * REGLAS INAMOVIBLES (definidas en PROTOCOL):
 *  - Un DID solo puede ganar MAX +1 punto por día en total (todos los validadores)
 *  - Velocidad máxima: +2 puntos en 7 días vía attestations positivas
 *  - Sesiones deben durar al menos MIN_SESSION_SECONDS para ser elegibles a reward
 *  - Patrones regulares (robot-like) → detectados como farming → -1
 *  - Nuevos DIDs (< PROBATION_DAYS) ganan 0 hasta acumular 2 attestations válidas
 */

import { BotAttestation } from "./index.js";
import { PROTOCOL } from "./protocol-constants.js";

// ── Anti-farming constants (parte del PROTOCOL) ──────────────────────────────

export const FARMING_RULES = Object.freeze({
  /** Max puntos que un DID puede ganar en 24h via attestations positivas */
  MAX_GAIN_PER_DAY: 1,

  /** Max puntos acumulados en 7 días */
  MAX_GAIN_PER_WEEK: 2,

  /** Segundos mínimos que debe durar una sesión para ser elegible a reward */
  MIN_SESSION_SECONDS: 30,

  /** Días de probación para DIDs nuevos (cuentan 0 hasta 2 attestations) */
  PROBATION_DAYS: 7,

  /** Max attestations positivas de un MISMO servicio a un DID en 24h */
  MAX_SAME_ISSUER_PER_DAY: 1,

  /** Entropía mínima del patrón de tools para no ser detectado como farming
   *  (número mínimo de tools distintos reales para reward) */
  MIN_TOOL_ENTROPY: 4,

  /** Tiempo mínimo entre dos calls a la misma tool (ms) para que no sea robot */
  MIN_TOOL_INTERVAL_MS: 2000,

  /** Si se detecta farming → emitir -1 automático en lugar de +1 */
  FARMING_PENALTY: -1 as const,
});

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface SessionEvent {
  tool:      string;
  timestamp: number;   // ms
}

export interface SessionContext {
  did:          string;
  startTime:    number;  // ms
  events:       SessionEvent[];
  issuerDid:    string;
}

export interface FarmingCheckResult {
  isFarming:   boolean;
  reason?:     string;
  penalty:     -1 | 0;
  details?:    Record<string, any>;
}

export interface DIDAuditEntry {
  dailyGain:     number;   // ganancia hoy
  weeklyGain:    number;   // ganancia en 7 días
  dayStart:      number;   // timestamp inicio del día (ms)
  weekStart:     number;   // timestamp inicio de la semana (ms)
  firstSeen:     number;   // cuando se registró por primera vez (ms)
  attestCount:   number;   // total attestations positivas recibidas
  farmingStrikes: number;  // veces que fue detectado farmeando
}

// ── In-memory audit store (el validator lo persiste en disco) ────────────────

const auditStore = new Map<string, DIDAuditEntry>();

export function getOrCreateAudit(did: string): DIDAuditEntry {
  if (!auditStore.has(did)) {
    const now = Date.now();
    auditStore.set(did, {
      dailyGain:     0,
      weeklyGain:    0,
      dayStart:      startOfDay(now),
      weekStart:     startOfWeek(now),
      firstSeen:     now,
      attestCount:   0,
      farmingStrikes: 0,
    });
  }
  return auditStore.get(did)!;
}

export function loadAuditStore(data: Record<string, DIDAuditEntry>) {
  for (const [did, entry] of Object.entries(data)) {
    auditStore.set(did, entry);
  }
}

export function exportAuditStore(): Record<string, DIDAuditEntry> {
  return Object.fromEntries(auditStore.entries());
}

// ── Core farming detection ────────────────────────────────────────────────────

/**
 * Analiza una sesión ANTES de emitir la attestation.
 * Si detecta farming, retorna isFarming=true con razón específica.
 *
 * El validator debe llamar esta función ANTES de applyAttestation().
 * Si isFarming=true, emitir -1 en lugar de +1.
 */
export function checkFarming(
  session:    SessionContext,
  existingAtts: BotAttestation[]
): FarmingCheckResult {
  const now = Date.now();
  const audit = getOrCreateAudit(session.did);
  resetDailyIfNeeded(audit, now);

  // ── Regla 1: Sesión demasiado corta ──────────────────────────────────────
  const sessionDuration = (now - session.startTime) / 1000;
  if (sessionDuration < FARMING_RULES.MIN_SESSION_SECONDS) {
    return farming(`Session too short: ${sessionDuration.toFixed(1)}s < ${FARMING_RULES.MIN_SESSION_SECONDS}s`, audit);
  }

  // ── Regla 2: Velocidad diaria excedida ───────────────────────────────────
  if (audit.dailyGain >= FARMING_RULES.MAX_GAIN_PER_DAY) {
    return farming(`Daily gain cap reached: +${audit.dailyGain} today (max ${FARMING_RULES.MAX_GAIN_PER_DAY})`, audit);
  }

  // ── Regla 3: Velocidad semanal excedida ──────────────────────────────────
  if (audit.weeklyGain >= FARMING_RULES.MAX_GAIN_PER_WEEK) {
    return farming(`Weekly gain cap reached: +${audit.weeklyGain} this week (max ${FARMING_RULES.MAX_GAIN_PER_WEEK})`, audit);
  }

  // ── Regla 4: Mismo emisor ya attestó hoy ─────────────────────────────────
  const todayStart = startOfDay(now);
  const sameIssuerToday = existingAtts.filter(a =>
    a.issuer_did === session.issuerDid &&
    a.value === 1 &&
    a.timestamp * 1000 >= todayStart
  ).length;
  if (sameIssuerToday >= FARMING_RULES.MAX_SAME_ISSUER_PER_DAY) {
    return farming(
      `Same issuer already attested today: ${session.issuerDid.slice(0,20)}... (max ${FARMING_RULES.MAX_SAME_ISSUER_PER_DAY}/day)`,
      audit
    );
  }

  // ── Regla 5: Entropía de herramientas insuficiente ───────────────────────
  const uniqueTools = new Set(session.events.map(e => e.tool));
  if (uniqueTools.size < FARMING_RULES.MIN_TOOL_ENTROPY) {
    return farming(
      `Tool entropy too low: ${uniqueTools.size} distinct tools (min ${FARMING_RULES.MIN_TOOL_ENTROPY})`,
      audit
    );
  }

  // ── Regla 6: Patrón robótico (intervalos demasiado regulares) ────────────
  if (isRoboticPattern(session.events)) {
    return farming("Robotic call pattern detected (regular intervals suggest automation)", audit);
  }

  // ── Regla 7: DID en probación con menos de 2 attestations ───────────────
  const daysOld = (now - audit.firstSeen) / (1000 * 60 * 60 * 24);
  if (daysOld < FARMING_RULES.PROBATION_DAYS && audit.attestCount < 2) {
    return farming(
      `DID in probation: ${daysOld.toFixed(1)} days old, ${audit.attestCount} attestations (need 2+ to earn points in first 7 days)`,
      audit
    );
  }

  // ── Sin farming detectado → OK ────────────────────────────────────────────
  return { isFarming: false, penalty: 0 };
}

/**
 * Registra una attestation positiva aprobada en el audit store.
 * Llamar DESPUÉS de confirmar que no es farming y aplicar el +1.
 */
export function recordApprovedGain(did: string) {
  const audit = getOrCreateAudit(did);
  resetDailyIfNeeded(audit, Date.now());
  audit.dailyGain++;
  audit.weeklyGain++;
  audit.attestCount++;
}

/**
 * Registra un strike de farming en el audit store.
 */
export function recordFarmingStrike(did: string) {
  const audit = getOrCreateAudit(did);
  audit.farmingStrikes++;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function farming(reason: string, audit: DIDAuditEntry): FarmingCheckResult {
  audit.farmingStrikes++;
  return {
    isFarming: true,
    reason,
    penalty:   FARMING_RULES.FARMING_PENALTY,
    details:   {
      dailyGain:      audit.dailyGain,
      weeklyGain:     audit.weeklyGain,
      farmingStrikes: audit.farmingStrikes,
    },
  };
}

/**
 * Detecta patrones robóticos: intervalos entre calls demasiado regulares.
 * Un humano real varía sus tiempos; un bot suele tener intervals constantes.
 */
function isRoboticPattern(events: SessionEvent[]): boolean {
  if (events.length < 4) return false;

  const intervals = [];
  for (let i = 1; i < events.length; i++) {
    intervals.push(events[i].timestamp - events[i - 1].timestamp);
  }

  // Si todos los intervalos son casi iguales (stddev < 10% de la media) → robótico
  const mean   = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const stddev = Math.sqrt(intervals.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / intervals.length);

  // Adicionalmente: intervalos muy cortos (< MIN_TOOL_INTERVAL_MS) → farming
  const tooFast = intervals.filter(i => i < FARMING_RULES.MIN_TOOL_INTERVAL_MS).length;
  if (tooFast > intervals.length * 0.5) return true;   // >50% calls muy rápidos

  return mean > 0 && (stddev / mean) < 0.10;  // coeficiente de variación < 10%
}

function resetDailyIfNeeded(audit: DIDAuditEntry, now: number) {
  const todayStart = startOfDay(now);
  if (audit.dayStart < todayStart) {
    audit.dailyGain = 0;
    audit.dayStart  = todayStart;
  }
  const weekStart = startOfWeek(now);
  if (audit.weekStart < weekStart) {
    audit.weeklyGain = 0;
    audit.weekStart  = weekStart;
  }
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ms: number): number {
  const d = new Date(ms);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
