const https = require("https");
const { getEnvConfig } = require("./env");
const { httpError } = require("./validator");

const loginAttempts = new Map();

function normalizeIdentifier(identifier) {
  return String(identifier || "").trim().toLowerCase();
}

function getAttemptRecord(key, now) {
  const env = getEnvConfig();
  const windowMs = env.LOGIN_LOCKOUT_MINUTES * 60 * 1000;
  const current = loginAttempts.get(key);
  if (!current) {
    return { failures: [], lockedUntil: 0, lockCount: 0 };
  }
  const activeFailures = current.failures.filter((ts) => now - ts < windowMs);
  return {
    failures: activeFailures,
    lockedUntil: current.lockedUntil > now ? current.lockedUntil : 0,
    lockCount: current.lockCount || 0,
  };
}

function checkLoginLockout(identifier, ipAddress = "local") {
  const now = Date.now();
  const accountKey = `acct:${normalizeIdentifier(identifier)}`;
  const ipKey = `ip:${String(ipAddress || "local").trim()}`;

  for (const key of [accountKey, ipKey]) {
    const record = getAttemptRecord(key, now);
    if (record.lockedUntil > now) {
      const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
      const error = httpError(
        `Cuenta o direccion IP bloqueada temporalmente por multiples intentos fallidos. Intenta de nuevo en ${Math.ceil(remainingSeconds / 60)} minuto(s).`,
        429
      );
      error.retryAfterSeconds = remainingSeconds;
      throw error;
    }
  }
}

function recordFailedLoginAttempt(identifier, ipAddress = "local") {
  const now = Date.now();
  const env = getEnvConfig();
  const maxAttempts = env.LOGIN_MAX_ATTEMPTS;
  const baseLockoutMs = env.LOGIN_LOCKOUT_MINUTES * 60 * 1000;

  const keys = [
    `acct:${normalizeIdentifier(identifier)}`,
    `ip:${String(ipAddress || "local").trim()}`,
  ];

  for (const key of keys) {
    const record = getAttemptRecord(key, now);
    record.failures.push(now);
    if (record.failures.length >= maxAttempts) {
      record.lockCount += 1;
      // Bloqueo progresivo: 15m, 30m, 60m...
      const multiplier = Math.min(Math.pow(2, record.lockCount - 1), 8);
      record.lockedUntil = now + baseLockoutMs * multiplier;
    }
    loginAttempts.set(key, record);
  }
}

function clearLoginAttempts(identifier, ipAddress = "local") {
  const accountKey = `acct:${normalizeIdentifier(identifier)}`;
  const ipKey = `ip:${String(ipAddress || "local").trim()}`;
  loginAttempts.delete(accountKey);
  loginAttempts.delete(ipKey);
}

function resetAllLockoutsForTest() {
  loginAttempts.clear();
}

function verifyTurnstileToken(token, remoteIp, secretKey) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      secret: secretKey,
      response: String(token || ""),
      remoteip: String(remoteIp || ""),
    }).toString();

    const req = https.request(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(Boolean(parsed.success));
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.write(postData);
    req.end();
  });
}

async function verifyBotProtection(body = {}, remoteIp = "local") {
  if (!body || typeof body !== "object") return;
  const env = getEnvConfig();

  // 1. Verificacion de campo Honeypot (debe estar estrictamente vacio)
  const honeypotValue = String(body.website_url || body.hp_field || "").trim();
  if (honeypotValue.length > 0) {
    throw httpError("Solicitud rechazada por el sistema de proteccion anti-bots (Honeypot).", 403);
  }

  // 2. Verificacion de tiempo minimo de interaccion humana (_form_ts)
  if (body._form_ts !== undefined && body._form_ts !== null && body._form_ts !== "") {
    const renderedAt = Number(body._form_ts);
    const elapsedMs = Date.now() - renderedAt;
    if (!Number.isFinite(renderedAt) || elapsedMs < env.BOT_MIN_SUBMIT_TIME_MS) {
      throw httpError("Envio de formulario demasiado rapido. Actividad automatizada bloqueada.", 403);
    }
  }

  // 3. Verificacion de token Cloudflare Turnstile / CAPTCHA si esta activo en entorno
  if (env.TURNSTILE_SECRET_KEY) {
    const captchaToken = String(body.cf_turnstile_response || body.captchaToken || "").trim();
    if (!captchaToken) {
      throw httpError("Completa la verificacion de seguridad anti-bots (CAPTCHA).", 403);
    }
    const validCaptcha = await verifyTurnstileToken(captchaToken, remoteIp, env.TURNSTILE_SECRET_KEY);
    if (!validCaptcha) {
      throw httpError("La verificacion anti-bots (CAPTCHA) fallo o expiro.", 403);
    }
  }
}

function stripBotFields(body = {}) {
  if (!body || typeof body !== "object") return {};
  const clone = { ...body };
  delete clone.website_url;
  delete clone.hp_field;
  delete clone._form_ts;
  delete clone.cf_turnstile_response;
  delete clone.captchaToken;
  return clone;
}

module.exports = {
  checkLoginLockout,
  clearLoginAttempts,
  recordFailedLoginAttempt,
  resetAllLockoutsForTest,
  stripBotFields,
  verifyBotProtection,
};
