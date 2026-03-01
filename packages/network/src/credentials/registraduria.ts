/**
 * Registraduría Nacional del Estado Civil — cédula validation
 *
 * Verifies that a Colombian cédula is VIGENTE (active) by querying
 * the official Registraduría certificate service.
 *
 * Endpoint: GET /verify/cedula?numero=XXXXXXXX&fechaNac=YYYY-MM-DD
 */

import { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { URL } from "node:url";

const REGISTRADURIA_URL =
  "https://certvigenciacedula.registraduria.gov.co/Datos.aspx";

export interface RegistraduriaResult {
  vigente: boolean;
  status: "VIGENTE" | "NO_VIGENTE" | "NOT_FOUND" | "ERROR";
  raw?: string;
  error?: string;
}

/**
 * Validates a cédula against Registraduría Nacional.
 * @param numero  - Cédula number (digits only)
 * @param fechaNac - Birth date in YYYY-MM-DD format
 * @returns RegistraduriaResult
 */
export async function validateCedula(
  numero: string,
  fechaNac: string
): Promise<RegistraduriaResult> {
  // Convert fechaNac YYYY-MM-DD → DD/MM/YYYY expected by Registraduría
  const [year, month, day] = fechaNac.split("-");
  const fechaFormatted = `${day}/${month}/${year}`;

  const postBody = new URLSearchParams({
    NumeroDocumento: numero.trim(),
    FechaNacimiento: fechaFormatted,
    BtnConsultar: "Consultar",
  }).toString();

  return new Promise((resolve) => {
    const urlObj = new URL(REGISTRADURIA_URL);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postBody),
        "User-Agent":
          "Mozilla/5.0 (compatible; SoulprintValidator/0.5.0; +https://github.com/manuelariasfz/soulprint)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-CO,es;q=0.9",
      },
      timeout: 10_000,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > 500_000) {
          req.destroy();
          resolve({ vigente: false, status: "ERROR", error: "Response too large" });
        }
      });
      res.on("end", () => {
        try {
          const upper = data.toUpperCase();
          if (upper.includes("VIGENTE") && !upper.includes("NO VIGENTE") && !upper.includes("NO_VIGENTE")) {
            resolve({ vigente: true, status: "VIGENTE", raw: data.slice(0, 2000) });
          } else if (upper.includes("NO VIGENTE") || upper.includes("NO_VIGENTE") || upper.includes("CANCELADA") || upper.includes("ANULADA")) {
            resolve({ vigente: false, status: "NO_VIGENTE", raw: data.slice(0, 2000) });
          } else if (upper.includes("NO EXISTE") || upper.includes("NO SE ENCONTR") || upper.includes("NOT FOUND")) {
            resolve({ vigente: false, status: "NOT_FOUND", raw: data.slice(0, 2000) });
          } else {
            // Ambiguous response — treat as not found
            resolve({ vigente: false, status: "NOT_FOUND", raw: data.slice(0, 2000) });
          }
        } catch (e: any) {
          resolve({ vigente: false, status: "ERROR", error: e.message });
        }
      });
    });

    req.on("error", (err) => {
      resolve({ vigente: false, status: "ERROR", error: err.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ vigente: false, status: "ERROR", error: "Request timed out" });
    });

    req.write(postBody);
    req.end();
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function jsonResp(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Handle GET /verify/cedula?numero=...&fechaNac=...
 * Returns: { ok, vigente, status, numero, fechaNac }
 * Graceful degradation: if Registraduría is unreachable, returns ok=true with status=ERROR and a warning.
 */
export async function handleCedulaRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string
): Promise<boolean> {
  if (!url.startsWith("/verify/cedula")) return false;
  if ((req.method ?? "GET") !== "GET") return false;

  const qs = new URL(url, "http://localhost").searchParams;
  const numero = qs.get("numero");
  const fechaNac = qs.get("fechaNac");

  if (!numero) {
    jsonResp(res, 400, { ok: false, error: "Missing query param: numero" });
    return true;
  }
  if (!fechaNac || !/^\d{4}-\d{2}-\d{2}$/.test(fechaNac)) {
    jsonResp(res, 400, { ok: false, error: "Missing or invalid query param: fechaNac (expected YYYY-MM-DD)" });
    return true;
  }

  try {
    const result = await validateCedula(numero, fechaNac);

    if (result.status === "ERROR") {
      // Graceful degradation — Registraduría unreachable
      console.warn(`[Registraduría] Unreachable or error for cédula ${numero}: ${result.error}`);
      jsonResp(res, 200, {
        ok: true,
        vigente: null,
        status: "ERROR",
        warning: "Registraduría is currently unreachable. Verification skipped.",
        numero,
        fechaNac,
      });
    } else {
      jsonResp(res, 200, {
        ok: true,
        vigente: result.vigente,
        status: result.status,
        numero,
        fechaNac,
      });
    }
  } catch (e: any) {
    // Should not happen, but handle just in case
    console.warn(`[Registraduría] Unexpected error: ${e.message}`);
    jsonResp(res, 200, {
      ok: true,
      vigente: null,
      status: "ERROR",
      warning: "Registraduría verification failed unexpectedly. Verification skipped.",
      numero,
      fechaNac,
    });
  }

  return true;
}
