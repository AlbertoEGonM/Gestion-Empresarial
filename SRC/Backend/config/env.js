const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const envPath = path.resolve(__dirname, "..", ".env");

function loadDotEnv(filePath = envPath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value.startsWith("#")) continue;
    value = value.replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function deriveKey32(rawSecret, fallbackContext) {
  if (rawSecret && /^[0-9a-f]{64}$/i.test(rawSecret.trim())) {
    return Buffer.from(rawSecret.trim(), "hex");
  }
  if (rawSecret && rawSecret.trim().length >= 16) {
    return crypto.createHash("sha256").update(rawSecret.trim()).digest();
  }
  return crypto.createHash("sha256").update(`dev-ephemeral-${fallbackContext}`).digest();
}

function getEnvConfig() {
  const nodeEnv = String(process.env.NODE_ENV || "development").trim().toLowerCase();
  const isProduction = nodeEnv === "production";
  const port = Number(process.env.PORT || 3000);
  const appOrigin = String(process.env.APP_ORIGIN || `http://localhost:${port}`).trim();
  const allowedOrigins = String(process.env.ALLOWED_ORIGINS || `${appOrigin},http://localhost:${port},http://127.0.0.1:${port}`)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const dbUrl = String(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "").trim();
  const rawEncKey = String(process.env.DATA_ENCRYPTION_KEY || "").trim();
  const rawHmacKey = String(process.env.DATA_HMAC_KEY || rawEncKey || "").trim();
  const passwordPepper = String(process.env.PASSWORD_PEPPER || "").trim();

  if (isProduction) {
    const missing = [];
    if (!dbUrl || dbUrl === "local") missing.push("SUPABASE_DB_URL");
    if (!rawEncKey || rawEncKey.length < 32 || /0123456789abcdef/i.test(rawEncKey)) {
      missing.push("DATA_ENCRYPTION_KEY (32 bytes reales)");
    }
    if (!passwordPepper || /reemplaza-este-secreto/i.test(passwordPepper)) {
      missing.push("PASSWORD_PEPPER");
    }
    if (missing.length > 0) {
      throw new Error(`Configuracion de seguridad incompleta para produccion. Variables faltantes o inseguras: ${missing.join(", ")}`);
    }
  }

  return Object.freeze({
    NODE_ENV: nodeEnv,
    IS_PRODUCTION: isProduction,
    PORT: port,
    APP_ORIGIN: appOrigin,
    ALLOWED_ORIGINS: allowedOrigins,
    FORCE_HTTPS: isProduction || String(process.env.FORCE_HTTPS || "").toLowerCase() === "true",
    SUPABASE_DB_URL: dbUrl,
    SUPABASE_URL: String(process.env.SUPABASE_URL || "").trim(),
    SUPABASE_ANON_KEY: String(process.env.SUPABASE_ANON_KEY || "").trim(),
    DB_APP_ROLE: String(process.env.DB_APP_ROLE || "app_backend_user").trim(),
    DB_SSL: String(process.env.DB_SSL || "true").toLowerCase() !== "false",
    DB_POOL_MAX: Math.min(Math.max(Number(process.env.DB_POOL_MAX || 10), 1), 50),
    DB_CONNECTION_TIMEOUT_MS: Math.max(Number(process.env.DB_CONNECTION_TIMEOUT_MS || 15000), 1000),
    STATEMENT_TIMEOUT_MS: Math.max(Number(process.env.STATEMENT_TIMEOUT_MS || 10000), 1000),
    SLOW_QUERY_THRESHOLD_MS: Math.max(Number(process.env.SLOW_QUERY_THRESHOLD_MS || 500), 50),
    DATA_ENCRYPTION_KEY: deriveKey32(rawEncKey, "gestion-aes-key"),
    DATA_HMAC_KEY: deriveKey32(rawHmacKey, "gestion-hmac-key"),
    PASSWORD_PEPPER: passwordPepper,
    LOGIN_MAX_ATTEMPTS: Math.max(Number(process.env.LOGIN_MAX_ATTEMPTS || 5), 3),
    LOGIN_LOCKOUT_MINUTES: Math.max(Number(process.env.LOGIN_LOCKOUT_MINUTES || 15), 1),
    BOT_MIN_SUBMIT_TIME_MS: Math.max(Number(process.env.BOT_MIN_SUBMIT_TIME_MS || 800), 0),
    TURNSTILE_SECRET_KEY: String(process.env.TURNSTILE_SECRET_KEY || "").trim(),
    BOOTSTRAP_ADMIN_EMAIL: String(process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim(),
    BOOTSTRAP_ADMIN_USERNAME: String(process.env.BOOTSTRAP_ADMIN_USERNAME || "").trim(),
    BOOTSTRAP_ADMIN_PASSWORD: String(process.env.BOOTSTRAP_ADMIN_PASSWORD || "").trim(),
  });
}

function getPublicClientConfig() {
  const env = getEnvConfig();
  return {
    appOrigin: env.APP_ORIGIN,
    supabaseUrl: env.SUPABASE_URL || null,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || null,
    botProtectionEnabled: true,
    turnstileEnabled: Boolean(env.TURNSTILE_SECRET_KEY),
  };
}

module.exports = {
  deriveKey32,
  getEnvConfig,
  getPublicClientConfig,
  loadDotEnv,
};
