import { decodeToken, SoulprintToken, TrustLevel, CredentialType, needsRenewal, autoRenew } from "soulprint-core";
import { verifySPT, SoulprintOptions } from "./verify.js";

export { verifySPT, SoulprintOptions };

// ── Express Middleware ────────────────────────────────────────────────────────

/**
 * soulprint() — Express/Connect middleware for Soulprint identity verification.
 *
 * USAGE:
 *
 * ```typescript
 * import express from "express";
 * import { soulprint } from "soulprint-express";
 *
 * const app = express();
 *
 * // Basic — require verified bots
 * app.use(soulprint({ minScore: 40 }));
 *
 * // Con auto-renew: el middleware renueva el SPT automáticamente
 * // cuando queda < 1h o expiró hace < 7 días.
 * // El nuevo token llega en el header X-Soulprint-Token-Renewed.
 * app.use(soulprint({ minScore: 40, nodeUrl: "https://my-validator.example.com" }));
 *
 * // El cliente debe leer el header y guardar el nuevo token:
 * // X-Soulprint-Token-Renewed: <nuevo_spt>
 * ```
 *
 * Token is read from:
 *   - HTTP header:   X-Soulprint: <SPT>
 *   - Query param:   ?spt=<SPT>
 *   - Bearer token:  Authorization: Bearer <SPT>
 *
 * Auto-renew header response:
 *   - X-Soulprint-Token-Renewed: <nuevo_spt>     (solo cuando se renovó)
 *   - X-Soulprint-Expires-In: <segundos>         (tiempo restante del nuevo token)
 */

export interface SoulprintMiddlewareOptions extends SoulprintOptions {
  /**
   * URL del nodo validador para auto-renew.
   * Si no se provee, el auto-renew está desactivado.
   * Ejemplo: "https://validator.soulprint.digital"
   */
  nodeUrl?:    string;
  /** Timeout para la petición de renew. Default: 5000ms */
  renewTimeoutMs?: number;
}

export function soulprint(opts: SoulprintMiddlewareOptions = {}) {
  return async function soulprintMiddleware(req: any, res: any, next: Function) {
    const spt = extractSPT(req);

    // ── Auto-renew preemptivo ────────────────────────────────────────────
    // Si el token está próximo a expirar y hay nodeUrl → intentar renovar
    let activeSpt = spt;
    if (spt && opts.nodeUrl) {
      const check = needsRenewal(spt);
      if (check.needsRenew) {
        const renewal = await autoRenew(spt, {
          nodeUrl:   opts.nodeUrl,
          timeoutMs: opts.renewTimeoutMs ?? 5_000,
        });
        if (renewal.renewed && renewal.spt !== activeSpt) {
          activeSpt = renewal.spt;
          // Entregar nuevo token al cliente via header
          res.setHeader("X-Soulprint-Token-Renewed", renewal.spt);
          res.setHeader("X-Soulprint-Expires-In",    String(renewal.expiresIn ?? 86400));
          res.setHeader("X-Soulprint-Renew-Method",  "auto");
        }
      }
    }

    const result = verifySPT(activeSpt, opts);

    if (!result.allowed) {
      opts.onRejected?.(result.reason!);
      res.status(403).json({
        error:   "soulprint_required",
        message: opts.rejectMessage ?? result.reason,
        docs:    "https://github.com/manuelariasfz/soulprint",
        hint:    opts.nodeUrl
          ? "Auto-renew activado — verifica que el token no tenga más de 7 días de expirado"
          : "Configura nodeUrl en el middleware para habilitar auto-renew",
        required: { minScore: opts.minScore ?? 40, require: opts.require },
      });
      return;
    }

    opts.onVerified?.(result.token!);
    req.soulprint = result.token;
    next();
  };
}

function extractSPT(req: any): string | undefined {
  const header = req.headers?.["x-soulprint"] ?? req.headers?.["X-Soulprint"];
  if (header) return header;

  const auth = req.headers?.authorization ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (token.length > 200) return token;
  }

  if (req.query?.spt) return req.query.spt;
  return undefined;
}
