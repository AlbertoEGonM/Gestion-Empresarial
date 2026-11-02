const crypto = require("crypto");
const path = require("path");
const { httpError } = require("./validator");

const ALLOWED_EXTENSIONS = new Set([".csv", ".pdf", ".png", ".jpg", ".jpeg"]);
const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// Firmas binarias (Magic Bytes) para evitar falsificacion de Content-Type
const MAGIC_SIGNATURES = {
  ".pdf": (buf) => buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-",
  ".png": (buf) =>
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a,
  ".jpg": (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  ".jpeg": (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  ".csv": (buf) => {
    if (buf.length === 0) return false;
    const sample = buf.subarray(0, Math.min(buf.length, 4096));
    // Prohibir bytes nulos o binarios ejecutables (MZ, ELF, PHP, scripts)
    for (let i = 0; i < sample.length; i += 1) {
      const byte = sample[i];
      if (byte === 0x00) return false;
    }
    const text = sample.toString("utf8");
    if (/^(MZ|\x7fELF|<\?php|<\s*script)/i.test(text.trim())) return false;
    return true;
  },
};

function sanitizeOriginalFilename(filename) {
  const raw = String(filename || "").trim();
  if (!raw) throw httpError("El nombre del archivo es obligatorio.", 400);
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    throw httpError("Nombre de archivo invalido (intento de Path Traversal bloqueado).", 400);
  }
  const base = path.basename(raw);
  // Bloquear doble extension sospechosa (.php.jpg, .exe.pdf, .js.csv)
  if (/\.(php|exe|sh|bat|cmd|ps1|js|mjs|cjs|jsp|asp|aspx|py|pl|rb|dll|so)\./i.test(base)) {
    throw httpError("Archivo bloqueado: doble extension ejecutable no permitida.", 400);
  }
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw httpError(`Extension de archivo no permitida (${ext || "sin extension"}). Solo se aceptan: ${[...ALLOWED_EXTENSIONS].join(", ")}.`, 400);
  }
  return { base, ext };
}

function validateAndPrepareUpload({ filename, buffer, maxBytes = MAX_UPLOAD_SIZE_BYTES }) {
  const { base, ext } = sanitizeOriginalFilename(filename);

  const fileBuffer = Buffer.isBuffer(buffer)
    ? buffer
    : typeof buffer === "string"
      ? Buffer.from(buffer, "base64")
      : null;

  if (!fileBuffer || fileBuffer.length === 0) {
    throw httpError("El contenido del archivo esta vacio o es invalido.", 400);
  }
  if (fileBuffer.length > maxBytes) {
    throw httpError(`El archivo excede el tamano maximo permitido (${Math.round(maxBytes / (1024 * 1024))} MB).`, 413);
  }

  const verifyMagic = MAGIC_SIGNATURES[ext];
  if (!verifyMagic || !verifyMagic(fileBuffer)) {
    throw httpError(`La firma binaria (Magic Bytes) del archivo no coincide con el formato declarado (${ext}).`, 400);
  }

  const safeStoredName = `${crypto.randomUUID()}${ext}`;
  const sha256Checksum = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  return {
    originalName: base,
    safeStoredName,
    extension: ext,
    sizeBytes: fileBuffer.length,
    sha256Checksum,
  };
}

module.exports = {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_SIZE_BYTES,
  sanitizeOriginalFilename,
  validateAndPrepareUpload,
};
