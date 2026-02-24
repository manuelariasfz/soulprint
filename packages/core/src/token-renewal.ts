/**
 * token-renewal.ts — Lógica de auto-renew del SPT
 *
 * Exportado desde soulprint-core para uso en:
 *  - soulprint-express (middleware automático)
 *  - soulprint-mcp (middleware MCP)
 *  - soulprint-cli (npx soulprint renew)
 *
 * FLUJO:
 *  1. El cliente incluye su SPT en la petición
 *  2. El middleware detecta que el token está próximo a expirar (< 1h) o expirado (< 7d)
 *  3. Llama a POST /token/renew en el nodo validador
 *  4. Devuelve el nuevo SPT en header X-Soulprint-Token-Renewed
 *  5. El cliente debe guardar el nuevo token (reemplaza al anterior)
 */

import { TOKEN_LIFETIME_SECONDS, TOKEN_RENEW_PREEMPTIVE_SECS, TOKEN_RENEW_GRACE_SECS } from "./protocol-constants.js";
import { decodeToken } from "./index.js";
import type { SoulprintToken } from "./index.js";

export interface RenewResult {
  renewed:    boolean;
  newToken?:  string;
  expiresIn?: number;
  method?:    "preemptive" | "grace_window";
  error?:     string;
}

export interface RenewOptions {
  /** URL del nodo validador. Default: http://localhost:4888 */
  nodeUrl?:   string;
  /** Timeout en ms para la petición de renew. Default: 5000 */
  timeoutMs?: number;
}

const DEFAULT_NODE = "http://localhost:4888";

/**
 * Verifica si un token necesita renovación.
 */
export function needsRenewal(spt: string): {
  needsRenew: boolean;
  reason: "preemptive" | "grace" | "too_old" | "still_valid" | "invalid";
  secsRemaining?: number;
  secsExpired?: number;
} {
  const token = decodeToken(spt);

  if (!token) {
    // Token inválido — intentar decodificar sin verificar expiración
    // para determinar si es demasiado viejo o simplemente inválido
    try {
      const raw  = spt.split(".")[0];
      const data = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      const nowSecs = Math.floor(Date.now() / 1000);
      const expired = nowSecs - (data.expires ?? 0);
      if (expired > 0 && expired <= (TOKEN_RENEW_GRACE_SECS)) {
        return { needsRenew: true, reason: "grace", secsExpired: expired };
      }
      return { needsRenew: false, reason: "too_old" };
    } catch {
      return { needsRenew: false, reason: "invalid" };
    }
  }

  const nowSecs      = Math.floor(Date.now() / 1000);
  const secsRemaining = token.expires - nowSecs;
  const renewThresh   = TOKEN_RENEW_PREEMPTIVE_SECS;

  if (secsRemaining <= 0) {
    const expired = -secsRemaining;
    if (expired <= (TOKEN_RENEW_GRACE_SECS)) {
      return { needsRenew: true, reason: "grace", secsExpired: expired };
    }
    return { needsRenew: false, reason: "too_old" };
  }

  if (secsRemaining <= renewThresh) {
    return { needsRenew: true, reason: "preemptive", secsRemaining };
  }

  return { needsRenew: false, reason: "still_valid", secsRemaining };
}

/**
 * Llama a POST /token/renew en el nodo validador.
 * Fire-and-forget seguro: nunca lanza excepción, retorna null si falla.
 */
export async function renewToken(
  currentSpt: string,
  opts: RenewOptions = {}
): Promise<RenewResult> {
  const nodeUrl  = opts.nodeUrl  ?? DEFAULT_NODE;
  const timeout  = opts.timeoutMs ?? 5_000;

  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeout);

    const resp = await fetch(`${nodeUrl}/token/renew`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ spt: currentSpt }),
      signal:  controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        renewed: false,
        error:   (body as any).error ?? `HTTP ${resp.status}`,
      };
    }

    const data = await resp.json() as {
      spt: string; expires_in: number; renewed: boolean; method: string;
    };
    return {
      renewed:   true,
      newToken:  data.spt,
      expiresIn: data.expires_in,
      method:    data.method as "preemptive" | "grace_window",
    };
  } catch (err: any) {
    return {
      renewed: false,
      error:   err.message ?? "Unknown renewal error",
    };
  }
}

/**
 * Intenta renovar el token si es necesario.
 * Combina needsRenewal + renewToken en una sola llamada.
 *
 * @returns { spt, renewed, expiresIn } — spt puede ser el mismo (si no necesitaba renew)
 */
export async function autoRenew(
  currentSpt: string,
  opts: RenewOptions & { force?: boolean } = {}
): Promise<{ spt: string; renewed: boolean; expiresIn?: number }> {
  const check = needsRenewal(currentSpt);

  if (!opts.force && !check.needsRenew) {
    return { spt: currentSpt, renewed: false };
  }

  const result = await renewToken(currentSpt, opts);

  if (result.renewed && result.newToken) {
    return {
      spt:       result.newToken,
      renewed:   true,
      expiresIn: result.expiresIn,
    };
  }

  // Renew falló — devolver el token original (puede estar en grace period)
  return { spt: currentSpt, renewed: false };
}
