import { decodeToken, SoulprintToken, TrustLevel, CredentialType } from "@soulprint/core";
import { verifySPT, SoulprintOptions }                              from "./verify.js";

export { verifySPT, SoulprintOptions };

// ── Express Middleware ────────────────────────────────────────────────────────

/**
 * soulprint() — Express/Connect middleware for Soulprint identity verification.
 *
 * USAGE:
 *
 * ```typescript
 * import express from "express";
 * import { soulprint } from "@soulprint/express";
 *
 * const app = express();
 *
 * // Protect entire API — require KYC verified humans
 * app.use(soulprint({ minScore: 60 }));
 *
 * // Protect specific route — require full biometric KYC
 * app.post("/sensitive", soulprint({ require: ["DocumentVerified", "FaceMatch"] }), handler);
 *
 * // Inside a handler — get the verified identity
 * app.get("/me", soulprint({ minScore: 20 }), (req, res) => {
 *   const identity = req.soulprint;  // SoulprintToken
 *   res.json({ nullifier: identity.nullifier, score: identity.score });
 * });
 * ```
 *
 * Token is read from:
 *   - HTTP header:   X-Soulprint: <SPT>
 *   - Query param:   ?spt=<SPT>
 *   - Bearer token:  Authorization: Bearer <SPT>
 */
export function soulprint(opts: SoulprintOptions = {}) {
  return function soulprintMiddleware(req: any, res: any, next: Function) {
    const spt = extractSPT(req);
    const result = verifySPT(spt, opts);

    if (!result.allowed) {
      opts.onRejected?.(result.reason!);
      res.status(403).json({
        error:   "soulprint_required",
        message: opts.rejectMessage ?? result.reason,
        docs:    "https://github.com/manuelariasfz/soulprint",
        required: {
          minScore: opts.minScore ?? 40,
          require:  opts.require,
        },
      });
      return;
    }

    opts.onVerified?.(result.token!);

    // Attach to req for downstream handlers
    req.soulprint = result.token;
    next();
  };
}

function extractSPT(req: any): string | undefined {
  // 1. Header dedicado
  const header = req.headers?.["x-soulprint"] ?? req.headers?.["X-Soulprint"];
  if (header) return header;

  // 2. Authorization: Bearer <SPT>
  const auth = req.headers?.authorization ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    // Solo si parece un SPT (base64url largo) — no interferir con JWTs normales
    if (token.length > 200) return token;
  }

  // 3. Query param: ?spt=...
  if (req.query?.spt) return req.query.spt;

  return undefined;
}

// ── Fastify Plugin ────────────────────────────────────────────────────────────

/**
 * soulprintFastify() — Fastify plugin for Soulprint verification.
 *
 * USAGE:
 *
 * ```typescript
 * import Fastify from "fastify";
 * import { soulprintFastify } from "@soulprint/express";
 *
 * const fastify = Fastify();
 * await fastify.register(soulprintFastify, { minScore: 60 });
 *
 * fastify.get("/me", async (request) => {
 *   const identity = request.soulprint;
 *   return { nullifier: identity?.nullifier };
 * });
 * ```
 */
export async function soulprintFastify(fastify: any, opts: SoulprintOptions = {}) {
  fastify.addHook("preHandler", async (request: any, reply: any) => {
    const spt    = extractSPT(request);
    const result = verifySPT(spt, opts);

    if (!result.allowed) {
      opts.onRejected?.(result.reason!);
      reply.status(403).send({
        error:    "soulprint_required",
        message:  opts.rejectMessage ?? result.reason,
        docs:     "https://github.com/manuelariasfz/soulprint",
      });
      return;
    }

    opts.onVerified?.(result.token!);
    request.soulprint = result.token;
  });
}

// ── Type augmentation for Express Request ─────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      soulprint?: SoulprintToken;
    }
  }
}

export { decodeToken, SoulprintToken, TrustLevel, CredentialType } from "@soulprint/core";
