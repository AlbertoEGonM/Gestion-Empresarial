const crypto = require("crypto");
const { getEnvConfig } = require("./env");

const ENCRYPTION_PREFIX = "enc:v1:";
const BLIND_INDEX_PREFIX = "bidx:";

function encryptField(plaintext, customKeyBuffer = null) {
  if (plaintext === null || plaintext === undefined) return null;
  const text = String(plaintext).trim();
  if (!text) return "";
  if (text.startsWith(ENCRYPTION_PREFIX)) return text;

  const key = customKeyBuffer || getEnvConfig().DATA_ENCRYPTION_KEY;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptField(storedValue, customKeyBuffer = null) {
  if (storedValue === null || storedValue === undefined) return "";
  const raw = String(storedValue).trim();
  if (!raw) return "";
  if (!raw.startsWith(ENCRYPTION_PREFIX)) {
    return raw;
  }

  const payload = raw.slice(ENCRYPTION_PREFIX.length);
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Formato de campo cifrado invalido o corrupto.");
  }

  const [ivHex, authTagHex, cipherHex] = parts;
  const key = customKeyBuffer || getEnvConfig().DATA_ENCRYPTION_KEY;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(cipherHex, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

function blindIndex(value, customHmacKey = null) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toUpperCase().replace(/\s+/g, "");
  if (!normalized) return null;
  const hmacKey = customHmacKey || getEnvConfig().DATA_HMAC_KEY;
  const digest = crypto.createHmac("sha256", hmacKey).update(normalized).digest("hex");
  return `${BLIND_INDEX_PREFIX}${digest}`;
}

module.exports = {
  BLIND_INDEX_PREFIX,
  ENCRYPTION_PREFIX,
  blindIndex,
  decryptField,
  encryptField,
};
