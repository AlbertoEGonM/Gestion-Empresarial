const FORBIDDEN_MASS_ASSIGNMENT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "is_global_admin",
  "isGlobalAdmin",
  "password_hash",
  "passwordHash",
  "token_hash",
  "tokenHash",
  "deleted_at",
  "deletedAt",
  "deleted_by",
  "deletedBy",
  "created_by",
  "createdBy",
  "decided_by",
  "decidedBy",
  "decided_at",
  "decidedAt",
  "serial",
  "serialNumber",
]);

const ALLOWED_MODULE_VIEWS = Object.freeze({
  compras: ["proveedores", "requisiciones", "ordenes", "recepciones", "devoluciones", "pagos", "comparativo"],
  ventas: ["clientes", "cotizaciones", "pedidos", "facturas", "devoluciones", "cobranza", "vendedores", "pos"],
  inventarios: ["productos", "produccion", "kardex", "almacenes", "transferencias", "precios", "lotes", "categorias", "unidades", "colores"],
  contabilidad: ["movimientos", "bancos", "cierres", "estados"],
  costos: ["analisis", "hojas", "margenes"],
  reportes: ["reportes"],
  ayuda: ["ayuda"],
  administrador: ["configuracion"],
});

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertAllowedFields(payload, allowedFields, contextLabel = "solicitud") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(`El cuerpo de la ${contextLabel} debe ser un objeto JSON valido.`, 400);
  }
  const allowedSet = new Set(allowedFields);
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_MASS_ASSIGNMENT_KEYS.has(key)) {
      throw httpError(`Campo protegido o prohibido detectado (${key}). Operacion bloqueada por seguridad.`, 400);
    }
    if (!allowedSet.has(key)) {
      throw httpError(`Campo no permitido en ${contextLabel}: ${key}.`, 400);
    }
  }
  return payload;
}

function sanitizeText(value, maxLength = 500) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // Eliminar etiquetas <script>, <iframe>, <object>, <embed>, <style>
  text = text.replace(/<\s*(script|iframe|object|embed|style|svg|math|form|input|button)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  text = text.replace(/<\s*\/?\s*(script|iframe|object|embed|style|svg|math|form|input|button|img|link|meta)[^>]*>/gi, "");
  // Eliminar manejadores de eventos inline (onload=, onerror=, onclick=, etc.)
  text = text.replace(/\bon[a-z]+\s*=\s*(['"][^'"]*['"]|[^\s>]+)/gi, "");
  // Eliminar protocolos peligrosos (javascript:, vbscript:, data:text/html)
  text = text.replace(/\b(javascript|vbscript)\s*:/gi, "");
  text = text.replace(/\bdata\s*:\s*text\/html/gi, "");
  // Eliminar etiquetas HTML residuales
  text = text.replace(/<\/?[a-z][^>]*>/gi, "");
  // Normalizar espacios y caracteres de control
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  text = text.trim().replace(/\s+/g, " ");
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function validateModuleAndView(moduleKeyRaw, viewKeyRaw) {
  const moduleKey = String(moduleKeyRaw || "").trim().toLowerCase();
  const viewKey = String(viewKeyRaw || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(moduleKey)) {
    throw httpError("El modulo no es valido.", 400);
  }
  if (!/^[a-z0-9_-]{2,40}$/.test(viewKey)) {
    throw httpError("La vista no es valida.", 400);
  }
  const allowedViews = ALLOWED_MODULE_VIEWS[moduleKey];
  if (!allowedViews || !allowedViews.includes(viewKey)) {
    throw httpError(`La combinacion de modulo (${moduleKey}) y vista (${viewKey}) no esta autorizada.`, 400);
  }
  return { moduleKey, viewKey };
}

function validatePositiveAmount(value, fieldLabel = "El monto", allowZero = true) {
  const num = Number(value);
  if (!Number.isFinite(num) || (allowZero ? num < 0 : num <= 0) || num > 999_999_999_999) {
    throw httpError(`${fieldLabel} debe ser un numero positivo valido.`, 400);
  }
  return Math.round(num * 10000) / 10000;
}

function parsePagination(query = {}, defaultLimit = 100, maxLimit = 500) {
  let limit = defaultLimit;
  if (query.limit !== undefined && query.limit !== null && query.limit !== "") {
    const parsedLimit = Number(query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw httpError("El parametro 'limit' debe ser un entero positivo.", 400);
    }
    limit = Math.min(parsedLimit, maxLimit);
  }

  let offset = 0;
  if (query.offset !== undefined && query.offset !== null && query.offset !== "") {
    const parsedOffset = Number(query.offset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      throw httpError("El parametro 'offset' debe ser un entero mayor o igual a 0.", 400);
    }
    offset = Math.min(parsedOffset, 100_000);
  }

  return { limit, offset };
}

module.exports = {
  ALLOWED_MODULE_VIEWS,
  FORBIDDEN_MASS_ASSIGNMENT_KEYS,
  assertAllowedFields,
  escapeHtml,
  httpError,
  parsePagination,
  sanitizeText,
  validateModuleAndView,
  validatePositiveAmount,
};
