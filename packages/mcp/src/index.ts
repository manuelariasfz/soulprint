import {
  decodeToken, SoulprintToken, TrustLevel, CredentialType,
  PROTOCOL, clampMinScore, withRetry,
} from "soulprint-core";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SoulprintOptions {
  /**
   * Trust score minimum (0-100).
   * ⚠️  PROTOCOL ENFORCEMENT: If this value is below PROTOCOL.SCORE_FLOOR (65),
   *     it will be automatically clamped up to 65. This is inamovible.
   */
  minScore?: number;

  /** Required trust level. If set, overrides minScore for level check. */
  minLevel?: TrustLevel;

  /** Required credentials. All must be present. */
  require?: CredentialType | CredentialType[];

  /** Custom rejection message */
  rejectMessage?: string;

  /**
   * Optional validator node URL.
   * If set, the token is also verified remotely with retry logic.
   * E.g.: "http://localhost:4888"
   */
  validatorUrl?: string;

  /** Called when a valid token is found (for logging, analytics, etc.) */
  onVerified?: (token: SoulprintToken) => void;

  /** Called when a request is rejected */
  onRejected?: (reason: string) => void;
}

const LEVEL_SCORES: Record<TrustLevel, number> = {
  Unverified:     0,
  EmailVerified:  10,
  PhoneVerified:  25,
  KYCLite:        45,
  KYCFull:        80,
};

// ── Core verification logic ───────────────────────────────────────────────────

export function verifySPT(
  spt:   string | undefined | null,
  opts:  SoulprintOptions = {}
): { allowed: boolean; token?: SoulprintToken; reason?: string } {

  if (!spt) {
    const r = { allowed: false, reason: "No Soulprint token provided" };
    opts.onRejected?.(r.reason);
    return r;
  }

  const token = decodeToken(spt);
  if (!token) {
    const r = { allowed: false, reason: "Invalid or expired Soulprint token" };
    opts.onRejected?.(r.reason);
    return r;
  }

  // ── PROTOCOL FLOOR ENFORCEMENT (inamovible) ───────────────────────────────
  // clampMinScore garantiza que ningún servicio puede exigir menos de SCORE_FLOOR.
  // Si alguien configura { minScore: 30 }, se clampea a 65 automáticamente.
  const effectiveMinScore = clampMinScore(opts.minScore ?? PROTOCOL.SCORE_FLOOR);

  if (token.score < effectiveMinScore) {
    const r = {
      allowed: false,
      reason: `Trust score too low: ${token.score} < ${effectiveMinScore} (protocol floor: ${PROTOCOL.SCORE_FLOOR})`
    };
    opts.onRejected?.(r.reason);
    return r;
  }

  if (opts.minLevel) {
    const required = LEVEL_SCORES[opts.minLevel] ?? 0;
    const actual   = LEVEL_SCORES[token.level]   ?? 0;
    if (actual < required) {
      const r = { allowed: false, reason: `Trust level too low: ${token.level} < ${opts.minLevel}` };
      opts.onRejected?.(r.reason);
      return r;
    }
  }

  if (opts.require) {
    const required = Array.isArray(opts.require) ? opts.require : [opts.require];
    const missing  = required.filter(c => !token.credentials.includes(c));
    if (missing.length > 0) {
      const r = { allowed: false, reason: `Missing credentials: ${missing.join(", ")}` };
      opts.onRejected?.(r.reason);
      return r;
    }
  }

  opts.onVerified?.(token);
  return { allowed: true, token };
}

/**
 * Verifica el token remotamente con un nodo validador.
 * Usa withRetry() para reintentar ante fallos transitorios.
 *
 * PROTOCOL: Hasta PROTOCOL.VERIFY_RETRY_MAX intentos con backoff exponencial.
 */
export async function verifySPTRemote(
  spt:          string,
  validatorUrl: string
): Promise<{ valid: boolean; reputation?: any; reason?: string }> {
  return withRetry(async () => {
    const res = await fetch(`${validatorUrl}/protocol`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Validator health check failed: HTTP ${res.status}`);

    const protocol = await res.json() as any;
    // Verificar compatibilidad de protocolo
    if (protocol.protocol_version && protocol.protocol_version !== PROTOCOL.VERSION) {
      throw new Error(
        `Protocol version mismatch: remote=${protocol.protocol_version}, local=${PROTOCOL.VERSION}`
      );
    }

    // Verificar que el nodo no ha bajado el floor
    if (protocol.score_floor && protocol.score_floor < PROTOCOL.SCORE_FLOOR) {
      throw new Error(
        `Validator has invalid score_floor: ${protocol.score_floor} < ${PROTOCOL.SCORE_FLOOR} (inamovible)`
      );
    }

    // Obtener reputación del DID del token
    const token = decodeToken(spt);
    if (!token) return { valid: false, reason: "Invalid token" };

    const repRes = await fetch(
      `${validatorUrl}/reputation/${encodeURIComponent(token.did)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!repRes.ok) throw new Error(`Reputation check failed: HTTP ${repRes.status}`);

    const reputation = await repRes.json();
    return { valid: true, reputation };
  }, "soulprint-mcp-remote-verify");
}

// ── MCP Middleware — requireSoulprint ─────────────────────────────────────────

/**
 * requireSoulprint() — MCP tool middleware factory.
 *
 * USAGE (MCP Server SDK):
 * ```typescript
 * import { requireSoulprint } from "soulprint-mcp";
 *
 * server.tool(
 *   "premium-tool",
 *   { query: z.string() },
 *   requireSoulprint({ minScore: 60 }),
 *   async (args, ctx) => {
 *     const { did, score } = ctx.soulprint;
 *     // minScore 60 → clamped to 65 by protocol
 *   }
 * );
 * ```
 *
 * Token is read from:
 *  1. MCP capabilities: `clientCapabilities.identity.soulprint`
 *  2. HTTP header: `x-soulprint-token`
 *  3. HTTP header: `X-Soulprint`
 *  4. Authorization: `Bearer <token>`
 *
 * ⚠️  minScore is clamped to PROTOCOL.SCORE_FLOOR (65) if set lower.
 */
export function requireSoulprint(opts: SoulprintOptions = {}) {
  const effectiveMinScore = clampMinScore(opts.minScore ?? PROTOCOL.SCORE_FLOOR);

  return async (context: any, next: () => Promise<any>) => {
    const spt = extractSPT(context);
    const result = verifySPT(spt, { ...opts, minScore: effectiveMinScore });

    if (!result.allowed) {
      opts.onRejected?.(result.reason!);
      throw new MCPError(
        opts.rejectMessage ?? `Soulprint: ${result.reason}`,
        "FORBIDDEN",
        {
          required:  effectiveMinScore,
          floor:     PROTOCOL.SCORE_FLOOR,
          actual:    spt ? (decodeToken(spt)?.score ?? 0) : 0,
        }
      );
    }

    // Remote validator check con retries (si validatorUrl está configurado)
    if (opts.validatorUrl && spt) {
      try {
        const remote = await verifySPTRemote(spt, opts.validatorUrl);
        if (!remote.valid) {
          throw new MCPError(`Soulprint remote: ${remote.reason}`, "FORBIDDEN");
        }
        // Actualizar reputación en el contexto si el nodo la devuelve
        if (remote.reputation && result.token) {
          (result.token as any).bot_rep = remote.reputation;
        }
      } catch (err: any) {
        // Si el validador está caído y ya agotó los reintentos, pasar en modo offline
        console.warn(`[soulprint-mcp] Remote verify failed after retries: ${err.message}. Falling back to offline mode.`);
      }
    }

    opts.onVerified?.(result.token!);

    // Adjuntar al contexto para uso downstream: ctx.soulprint
    if (context && typeof context === "object") {
      context.soulprint = {
        did:         result.token!.did,
        score:       result.token!.score,
        identity:    result.token!.identity_score,
        reputation:  result.token!.bot_rep?.score ?? PROTOCOL.DEFAULT_REPUTATION,
        credentials: result.token!.credentials,
        country:     result.token!.country,
        expiresAt:   new Date(result.token!.expires * 1000).toISOString(),
        verified:    true,
      };
    }

    return next();
  };
}

// Alias for backward compatibility
export const soulprint = requireSoulprint;

function extractSPT(context: any): string | undefined {
  if (!context) return undefined;

  // 1. MCP capabilities
  const cap = context?.clientCapabilities?.identity?.soulprint;
  if (cap) return cap;

  // 2. Meta/headers
  const headers = context?.meta?.headers ?? {};
  return (
    headers["x-soulprint-token"] ??
    headers["X-Soulprint"]       ??
    headers["x-soulprint"]       ??
    extractBearer(headers["authorization"])
  );
}

function extractBearer(authHeader?: string): string | undefined {
  if (!authHeader?.startsWith("Bearer ")) return undefined;
  return authHeader.slice(7);
}

// ── Standalone verifier ───────────────────────────────────────────────────────

export function verifyRequest(
  request: any,
  opts:    SoulprintOptions = {}
): SoulprintToken | null {
  const spt = extractSPT(request);
  const result = verifySPT(spt, opts);
  return result.allowed ? result.token! : null;
}

export function getSoulprint(context: any): SoulprintToken | undefined {
  return context?._soulprint ?? context?.soulprint;
}

// ── withTracking — behavior tracking for bot reputation ──────────────────────

export interface TrackingOptions extends SoulprintOptions {
  toolName:       string;
  validatorUrl?:  string;
  serviceSpt?:    string;
}

/**
 * withTracking() — wraps a tool with Soulprint identity gate + behavior tracking.
 * Automatically issues +1 attestations for good behavior (≥3 distinct tools).
 * Issues -1 attestations for spam (>5 requests in 60s).
 */
export function withTracking(opts: TrackingOptions) {
  const sessionCounts = new Map<string, { tools: Set<string>; calls: number; lastReset: number }>();

  return async (context: any, next: () => Promise<any>) => {
    const spt = extractSPT(context);
    const result = verifySPT(spt, opts);

    if (!result.allowed) {
      opts.onRejected?.(result.reason!);
      throw new MCPError(`Soulprint: ${result.reason}`, "FORBIDDEN");
    }

    const did = result.token!.did;
    const now = Date.now();

    // Track session behavior
    let session = sessionCounts.get(did);
    if (!session || now - session.lastReset > 60_000) {
      session = { tools: new Set(), calls: 0, lastReset: now };
      sessionCounts.set(did, session);
    }
    session.tools.add(opts.toolName);
    session.calls++;

    // Spam detection: >5 calls in 60s
    if (session.calls > 5 && opts.validatorUrl && opts.serviceSpt) {
      fetch(`${opts.validatorUrl}/reputation/attest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attestation: {
            issuer_did: result.token!.did, // will be overridden by service_spt
            target_did: did,
            value: -1,
            context: "spam-detected",
            timestamp: Math.floor(now / 1000),
            sig: "", // server will re-sign
          },
          service_spt: opts.serviceSpt,
        }),
      }).catch(() => {});
    }

    // Reward: ≥3 distinct tools + ≥3 completions + no spam
    const outcome = await next();
    session.calls > 0 && session.tools.size >= 3 && session.calls >= 3 && session.calls <= 5
      && opts.validatorUrl && opts.serviceSpt
      && fetch(`${opts.validatorUrl}/reputation/attest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attestation: { target_did: did, value: 1, context: "diverse_tool_use", timestamp: Math.floor(now / 1000), sig: "" },
            service_spt: opts.serviceSpt,
          }),
        }).catch(() => {});

    return outcome;
  };
}

// ── Minimal type stubs ────────────────────────────────────────────────────────

class MCPError extends Error {
  code:    string;
  details: any;
  constructor(message: string, code: string, details?: any) {
    super(message);
    this.name    = "MCPError";
    this.code    = code;
    this.details = details;
  }
}

// ── Re-exports ────────────────────────────────────────────────────────────────
export {
  decodeToken, SoulprintToken, TrustLevel, CredentialType,
  PROTOCOL, clampMinScore, withRetry,
} from "soulprint-core";
