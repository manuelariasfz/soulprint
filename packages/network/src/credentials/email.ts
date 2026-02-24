/**
 * Email OTP Credential Validator
 *
 * Flujo:
 *  1. POST /credentials/email/start  { did, email }
 *     → genera OTP de 6 dígitos, válido 10 min
 *     → envía email via SMTP (nodemailer)
 *     → retorna { sessionId }
 *
 *  2. POST /credentials/email/verify { sessionId, otp }
 *     → si el OTP coincide → emite attestation "EmailVerified" sobre el DID
 *     → retorna { credential: "EmailVerified", did }
 *
 * Configuración (env vars):
 *  SMTP_HOST     — servidor SMTP (ej: smtp.gmail.com)
 *  SMTP_PORT     — puerto (default 587)
 *  SMTP_USER     — usuario SMTP
 *  SMTP_PASS     — contraseña SMTP
 *  SMTP_FROM     — remitente (default "noreply@soulprint.digital")
 *
 * En desarrollo sin SMTP configurado: usa Ethereal (catch-all fake SMTP)
 * para testing — los emails no se envían pero son capturables.
 */

import nodemailer         from "nodemailer";
import { randomBytes, randomInt } from "node:crypto";

// TTL de la sesión OTP (10 minutos)
const OTP_TTL_MS = 10 * 60 * 1000;

interface EmailSession {
  did:       string;
  email:     string;
  otp:       string;   // OTP de 6 dígitos
  expiresAt: number;   // timestamp ms
  attempts:  number;   // intentos de verificación
}

// Sessions en memoria (el nodo limpia las expiradas cada 5 min)
const emailSessions = new Map<string, EmailSession>();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of emailSessions) {
    if (s.expiresAt < now) emailSessions.delete(id);
  }
}, 5 * 60_000).unref();

// Transportador SMTP (lazy init)
let transport: nodemailer.Transporter | null = null;

async function getTransport(): Promise<nodemailer.Transporter> {
  if (transport) return transport;

  if (process.env.SMTP_HOST) {
    transport = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT ?? "587"),
      secure: process.env.SMTP_PORT === "465",
      auth: {
        user: process.env.SMTP_USER!,
        pass: process.env.SMTP_PASS!,
      },
    });
  } else {
    // Dev: usa Ethereal (emails no se envían, se loguean)
    const testAccount = await nodemailer.createTestAccount();
    transport = nodemailer.createTransport({
      host:   "smtp.ethereal.email",
      port:   587,
      secure: false,
      auth:   { user: testAccount.user, pass: testAccount.pass },
    });
    console.log("[email-cred] Dev mode — usando Ethereal SMTP");
  }

  return transport;
}

export async function startEmailVerification(
  did:   string,
  email: string
): Promise<{ sessionId: string; preview?: string }> {
  // Validar email básico
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Invalid email address");
  }

  // Generar OTP de 6 dígitos con crypto.randomInt (CSPRNG)
  const otp       = randomInt(100000, 999999).toString();
  const sessionId = randomBytes(16).toString("hex");

  emailSessions.set(sessionId, {
    did, email, otp,
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
  });

  const transporter = await getTransport();
  const info = await transporter.sendMail({
    from:    process.env.SMTP_FROM ?? "noreply@soulprint.digital",
    to:      email,
    subject: "Soulprint — Your verification code",
    text:    `Your Soulprint verification code is: ${otp}\n\nExpires in 10 minutes. Do not share this code.`,
    html:    `<p>Your Soulprint verification code is: <strong style="font-size:1.5em">${otp}</strong></p><p>Expires in 10 minutes. Do not share this code.</p>`,
  });

  const preview = nodemailer.getTestMessageUrl(info) || undefined;
  if (preview) console.log(`[email-cred] Preview: ${preview}`);

  return { sessionId, preview };
}

export function verifyEmailOTP(
  sessionId: string,
  otp:       string
): { ok: boolean; did?: string; email?: string; reason?: string } {
  const session = emailSessions.get(sessionId);

  if (!session)               return { ok: false, reason: "Session not found or expired" };
  if (Date.now() > session.expiresAt) { emailSessions.delete(sessionId); return { ok: false, reason: "OTP expired" }; }

  session.attempts++;
  if (session.attempts > 5) { emailSessions.delete(sessionId); return { ok: false, reason: "Too many attempts" }; }

  if (otp.trim() !== session.otp) return { ok: false, reason: "Invalid OTP" };

  // OTP correcto — limpiar sesión y retornar
  emailSessions.delete(sessionId);
  return { ok: true, did: session.did, email: session.email };
}
