/**
 * GitHub OAuth Credential Validator — native fetch only, no extra deps
 *
 * Usa el flujo estándar OAuth 2.0 de GitHub (open source, bien documentado).
 * No requiere librerías extra — solo fetch nativo (disponible en Node 18+).
 *
 * Flujo:
 *  1. GET /credentials/github/start?did=<did>
 *     → retorna { authUrl } — el cliente redirige al usuario a authUrl
 *       authUrl = "https://github.com/login/oauth/authorize?..."
 *
 *  2. GitHub redirige a /credentials/github/callback?code=<code>&state=<state>
 *     → intercambia code por access_token
 *     → obtiene perfil del usuario (id, login, email)
 *     → emite GitHubLinked credential
 *     → retorna { credential: "GitHubLinked", did, githubLogin }
 *
 * Configuración (env vars):
 *  GITHUB_CLIENT_ID      — GitHub OAuth App Client ID
 *  GITHUB_CLIENT_SECRET  — GitHub OAuth App Client Secret
 *  SOULPRINT_BASE_URL    — URL pública del nodo (para callback)
 *                          ej: "https://my-validator.example.com"
 *
 * Crear OAuth App: https://github.com/settings/applications/new
 *  - Homepage URL: tu dominio del nodo
 *  - Callback URL: https://tu-nodo/credentials/github/callback
 *
 * Para desarrollo sin GitHub App configurada:
 *  → el endpoint retorna instrucciones para crearla
 */

import { randomBytes } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;  // 10 minutos para completar OAuth

interface GitHubState {
  did:       string;
  expiresAt: number;
  used:      boolean;
}

const stateStore = new Map<string, GitHubState>();
setInterval(() => {
  const now = Date.now();
  for (const [s, v] of stateStore) {
    if (v.expiresAt < now) stateStore.delete(s);
  }
}, 5 * 60_000).unref();

function getConfig() {
  const clientId     = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const baseUrl      = process.env.SOULPRINT_BASE_URL ?? "http://localhost:4888";
  return { clientId, clientSecret, baseUrl, configured: !!(clientId && clientSecret) };
}

export function startGitHubOAuth(
  did: string
): { authUrl?: string; state?: string; error?: string; setup?: string } {
  const cfg = getConfig();

  if (!cfg.configured) {
    return {
      error: "GitHub OAuth not configured on this validator node.",
      setup: [
        "To enable GitHubLinked verification:",
        "1. Create a GitHub OAuth App at https://github.com/settings/applications/new",
        "   - Homepage URL: your validator's public URL",
        "   - Callback URL: <SOULPRINT_BASE_URL>/credentials/github/callback",
        "2. Set env vars: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SOULPRINT_BASE_URL",
        "3. Restart the validator node",
      ].join("\n"),
    };
  }

  const state = randomBytes(16).toString("hex");
  stateStore.set(state, { did, expiresAt: Date.now() + STATE_TTL_MS, used: false });

  const params = new URLSearchParams({
    client_id:    cfg.clientId!,
    redirect_uri: `${cfg.baseUrl}/credentials/github/callback`,
    scope:        "read:user user:email",
    state,
  });

  return {
    authUrl: `https://github.com/login/oauth/authorize?${params}`,
    state,
  };
}

export async function handleGitHubCallback(
  code:  string,
  state: string
): Promise<{
  ok:          boolean;
  did?:        string;
  githubId?:   number;
  githubLogin?: string;
  email?:      string;
  reason?:     string;
}> {
  const cfg = getConfig();
  if (!cfg.configured) return { ok: false, reason: "GitHub OAuth not configured" };

  // Verificar state
  const stored = stateStore.get(state);
  if (!stored)              return { ok: false, reason: "Invalid or expired state" };
  if (stored.used)          return { ok: false, reason: "State already used" };
  if (Date.now() > stored.expiresAt) { stateStore.delete(state); return { ok: false, reason: "State expired" }; }

  stored.used = true;

  // Intercambiar code por access_token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method:  "POST",
    headers: {
      "Accept":       "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri:  `${cfg.baseUrl}/credentials/github/callback`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!tokenRes.ok) return { ok: false, reason: `GitHub token exchange failed: HTTP ${tokenRes.status}` };

  const tokenData = await tokenRes.json() as any;
  if (tokenData.error) return { ok: false, reason: `GitHub OAuth error: ${tokenData.error_description ?? tokenData.error}` };

  const accessToken = tokenData.access_token;

  // Obtener perfil del usuario
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept":        "application/vnd.github+json",
      "User-Agent":    "Soulprint-Validator/0.2.1",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!userRes.ok) return { ok: false, reason: `GitHub user fetch failed: HTTP ${userRes.status}` };

  const user = await userRes.json() as any;

  // Opcionalmente obtener email privado
  let email: string | undefined;
  try {
    const emailRes = await fetch("https://api.github.com/user/emails", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept":        "application/vnd.github+json",
        "User-Agent":    "Soulprint-Validator/0.2.1",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (emailRes.ok) {
      const emails = await emailRes.json() as any[];
      email = emails.find(e => e.primary && e.verified)?.email;
    }
  } catch { /* email opcional */ }

  stateStore.delete(state);

  return {
    ok:          true,
    did:         stored.did,
    githubId:    user.id,
    githubLogin: user.login,
    email,
  };
}
