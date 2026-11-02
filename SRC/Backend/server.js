const http = require("http");
const path = require("path");
const fs = require("fs");
const { getEnvConfig, getPublicClientConfig } = require("./config/env");
const {
  approveRegistration,
  deleteOwnAccount,
  ensureAuthTables,
  getRegistrations,
  getSession,
  listCompanies,
  loginUser,
  rejectRegistration,
  requestRegistration,
  resetPassword,
  revokeSession,
  sendPasswordRecovery,
} = require("./config/db");
const { ensureRecordsTable, getDataset, saveDataset } = require("./modules/records");
const { ensureAccountingTables, getAccountingReport } = require("./modules/accounting");
const { createEmployee, deleteEmployee, ensureEmployeesTable, getEmployee, listEmployees, updateEmployee } = require("./modules/employees");
const { assertAllowedFields } = require("./config/validator");
const { stripBotFields, verifyBotProtection } = require("./config/security");
const { validateAndPrepareUpload } = require("./config/file-security");
const { listAuditLogs } = require("./config/audit");

const env = getEnvConfig();
const PORT = env.PORT;
const frontendPath = path.resolve(__dirname, "..", "Frontend");
const rateLimits = new Map();
const SESSION_COOKIE_MAX_AGE = 12 * 60 * 60; // 43200 segundos (12 horas)

const PUBLIC_API_ROUTES = new Set([
  "GET /api/health",
  "GET /api/companies",
  "GET /api/config/public",
  "POST /api/auth/register",
  "POST /api/auth/login",
  "POST /api/auth/recover",
  "POST /api/auth/reset",
]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".csv": "text/csv; charset=utf-8",
};

function isEncryptedRequest(request) {
  if (request?.socket?.encrypted) return true;
  const proto = String(request?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return proto === "https";
}

function getClientIp(request) {
  const forwarded = String(request?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request?.socket?.remoteAddress || "local";
}

function buildSecurityHeaders(request, contentType = "application/json; charset=utf-8", extraHeaders = {}) {
  const currentEnv = getEnvConfig();
  const origin = String(request?.headers?.origin || "").trim();
  const headers = {
    "Content-Type": contentType,
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    ...extraHeaders,
  };

  if (origin && currentEnv.ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }

  return headers;
}

function buildSessionCookie(token, isSecure = true, maxAgeSeconds = SESSION_COOKIE_MAX_AGE) {
  const cookieName = isSecure ? "__Host-gestion_session" : "gestion_session";
  const parts = [
    `${cookieName}=${encodeURIComponent(token || "")}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${Math.max(0, Number(maxAgeSeconds) || 0)}`,
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

function sendJson(response, statusCode, payload, request = null, extraHeaders = {}) {
  response.writeHead(statusCode, buildSecurityHeaders(request, "application/json; charset=utf-8", extraHeaders));
  response.end(JSON.stringify(payload));
}

function enforceHttps(request, response, forceHttpsOverride = undefined) {
  const currentEnv = getEnvConfig();
  const mustEnforce = forceHttpsOverride !== undefined ? forceHttpsOverride : currentEnv.FORCE_HTTPS;
  if (!mustEnforce || isEncryptedRequest(request)) return false;

  const host = String(request?.headers?.host || "localhost").replace(/[^\w.:-]/g, "");
  if (request.method === "GET" || request.method === "HEAD") {
    response.writeHead(301, {
      ...buildSecurityHeaders(request, "text/plain; charset=utf-8"),
      Location: `https://${host}${request.url || "/"}`,
    });
    response.end("Redirigiendo a HTTPS seguro.");
    return true;
  }

  sendJson(response, 403, { message: "Se requiere conexion segura HTTPS para esta solicitud." }, request);
  return true;
}

function enforceRateLimit(request, scope, maximum, windowMs) {
  const address = getClientIp(request);
  const key = `${scope}:${address}`;
  const now = Date.now();
  const recent = (rateLimits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= maximum) {
    const error = new Error("Demasiados intentos. Espera unos minutos antes de volver a intentar.");
    error.statusCode = 429;
    error.retryAfterSeconds = Math.ceil(windowMs / 1000);
    throw error;
  }
  recent.push(now);
  rateLimits.set(key, recent);
}

function parseJsonBody(request, maxBytes = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers["content-type"] || "").toLowerCase();
    if (contentType && !contentType.includes("application/json")) {
      const error = new Error("Tipo de contenido no soportado. Se requiere application/json.");
      error.statusCode = 415;
      reject(error);
      return;
    }

    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("La solicitud excede el limite de tamano permitido.");
        error.statusCode = 413;
        request.destroy(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        const error = new Error("El cuerpo de la solicitud no contiene JSON valido.");
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function parseCookies(cookieHeader = "") {
  const cookies = {};
  for (const pair of String(cookieHeader || "").split(";")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const val = pair.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

function extractSessionToken(request) {
  const authorization = String(request?.headers?.authorization || "");
  if (authorization.startsWith("Bearer ")) {
    const bearer = authorization.slice(7).trim();
    if (bearer) return bearer;
  }
  const cookies = parseCookies(request?.headers?.cookie);
  return cookies["__Host-gestion_session"] || cookies.gestion_session || "";
}

async function requireSession(request) {
  const user = await getSession(extractSessionToken(request));
  if (!user) {
    const error = new Error("Tu sesion expiro o no es valida. Inicia sesion nuevamente.");
    error.statusCode = 401;
    throw error;
  }
  return user;
}

function serveStaticFile(requestUrl, response, request = null) {
  const requestPath = requestUrl.pathname === "/" ? "/login.html" : decodeURIComponent(requestUrl.pathname);
  if (requestPath.includes("\0")) {
    response.writeHead(400, buildSecurityHeaders(request, "text/plain; charset=utf-8"));
    response.end("Bad Request");
    return;
  }
  const filePath = path.resolve(frontendPath, `.${requestPath}`);
  if (filePath !== frontendPath && !filePath.startsWith(`${frontendPath}${path.sep}`)) {
    response.writeHead(403, buildSecurityHeaders(request, "text/plain; charset=utf-8"));
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, buildSecurityHeaders(request, "text/plain; charset=utf-8"));
      response.end("Not found");
      return;
    }
    const mime = contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    response.writeHead(200, buildSecurityHeaders(request, mime));
    response.end(content);
  });
}

async function handleApi(request, response, requestUrl) {
  const route = requestUrl.pathname;
  const routeSignature = `${request.method} ${route}`;
  const clientIp = getClientIp(request);
  const secureCookie = isEncryptedRequest(request) || getEnvConfig().IS_PRODUCTION;

  // PUNTO 6: Gateway de Autenticacion en Servidor (Deny-by-Default)
  // Toda ruta /api/* que no este en la lista blanca publica exige sesion activa verificada en DB.
  let sessionUser = null;
  if (!PUBLIC_API_ROUTES.has(routeSignature)) {
    sessionUser = await requireSession(request);
  }

  if (route === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true, service: "Gestion Empresarial", date: new Date().toISOString() }, request);
    return true;
  }
  if (route === "/api/config/public" && request.method === "GET") {
    sendJson(response, 200, getPublicClientConfig(), request);
    return true;
  }
  if (route === "/api/companies" && request.method === "GET") {
    sendJson(response, 200, { companies: await listCompanies() }, request);
    return true;
  }
  if (route === "/api/auth/register" && request.method === "POST") {
    enforceRateLimit(request, "register", 10, 60 * 60 * 1000);
    const body = await parseJsonBody(request);
    await verifyBotProtection(body, clientIp);
    const registration = await requestRegistration(body, clientIp);
    sendJson(response, 201, { registration, message: "Solicitud enviada. El administrador revisara tu acceso para la empresa seleccionada." }, request);
    return true;
  }
  if (route === "/api/auth/login" && request.method === "POST") {
    enforceRateLimit(request, "login", 10, 10 * 60 * 1000);
    const rawBody = await parseJsonBody(request);
    await verifyBotProtection(rawBody, clientIp);
    const cleanBody = stripBotFields(rawBody);
    assertAllowedFields(cleanBody, ["username", "password"], "inicio de sesion");
    const result = await loginUser(cleanBody.username, cleanBody.password, clientIp);
    if (!result) {
      sendJson(response, 401, { message: "Usuario o contrasena incorrectos, o la cuenta aun no ha sido aprobada." }, request);
      return true;
    }
    const cookieHeader = buildSessionCookie(result.token, secureCookie, SESSION_COOKIE_MAX_AGE);
    sendJson(response, 200, { ...result, message: "Sesion iniciada correctamente." }, request, {
      "Set-Cookie": cookieHeader,
    });
    return true;
  }
  if (route === "/api/auth/session" && request.method === "GET") {
    sendJson(response, 200, { user: sessionUser }, request);
    return true;
  }
  if (route === "/api/auth/logout" && request.method === "POST") {
    await revokeSession(extractSessionToken(request));
    const expiredCookie = buildSessionCookie("", secureCookie, 0);
    sendJson(response, 200, { message: "Sesion cerrada." }, request, {
      "Set-Cookie": expiredCookie,
    });
    return true;
  }
  if (route === "/api/auth/recover" && request.method === "POST") {
    enforceRateLimit(request, "recover", 5, 15 * 60 * 1000);
    const rawBody = await parseJsonBody(request);
    await verifyBotProtection(rawBody, clientIp);
    const cleanBody = stripBotFields(rawBody);
    assertAllowedFields(cleanBody, ["email"], "recuperacion de contrasena");
    const origin = getEnvConfig().APP_ORIGIN;
    await sendPasswordRecovery(cleanBody.email, origin, clientIp);
    sendJson(response, 200, { sent: true, message: "Si existe una cuenta activa con ese correo, enviaremos las instrucciones de recuperacion." }, request);
    return true;
  }
  if (route === "/api/auth/reset" && request.method === "POST") {
    enforceRateLimit(request, "reset", 5, 15 * 60 * 1000);
    const rawBody = await parseJsonBody(request);
    const cleanBody = stripBotFields(rawBody);
    assertAllowedFields(cleanBody, ["token", "password"], "restablecimiento de contrasena");
    sendJson(
      response,
      200,
      { message: "Contrasena actualizada. Ya puedes iniciar sesion.", ...(await resetPassword(cleanBody.token, cleanBody.password, clientIp)) },
      request
    );
    return true;
  }
  if (route === "/api/auth/account" && request.method === "DELETE") {
    enforceRateLimit(request, "delete-account", 5, 15 * 60 * 1000);
    const body = await parseJsonBody(request);
    assertAllowedFields(body, ["password", "confirmation"], "eliminacion de cuenta");
    const deleted = await deleteOwnAccount(sessionUser, body.password, body.confirmation, clientIp);
    const expiredCookie = buildSessionCookie("", secureCookie, 0);
    sendJson(response, 200, { ...deleted, message: "Tu cuenta fue eliminada correctamente." }, request, {
      "Set-Cookie": expiredCookie,
    });
    return true;
  }

  if (route === "/api/admin/registrations" && request.method === "GET") {
    const registrations = await getRegistrations(sessionUser, {
      status: requestUrl.searchParams.get("status") || "Pendiente",
      companyId: requestUrl.searchParams.get("companyId"),
      limit: requestUrl.searchParams.get("limit"),
      offset: requestUrl.searchParams.get("offset"),
    });
    sendJson(response, 200, { registrations }, request);
    return true;
  }
  if (route === "/api/admin/registrations/approve" && request.method === "POST") {
    const body = await parseJsonBody(request);
    assertAllowedFields(body, ["id"], "aprobacion de registro");
    sendJson(response, 200, { user: await approveRegistration(body.id, sessionUser, clientIp), message: "Cuenta aprobada correctamente." }, request);
    return true;
  }
  if (route === "/api/admin/registrations/reject" && request.method === "POST") {
    const body = await parseJsonBody(request);
    assertAllowedFields(body, ["id", "reason"], "rechazo de registro");
    await rejectRegistration(body.id, sessionUser, body.reason, clientIp);
    sendJson(response, 200, { message: "Solicitud rechazada correctamente." }, request);
    return true;
  }
  if (route === "/api/admin/audit-logs" && request.method === "GET") {
    const logs = await listAuditLogs(sessionUser, Object.fromEntries(requestUrl.searchParams));
    sendJson(response, 200, { logs }, request);
    return true;
  }

  if (route === "/api/employees" && request.method === "GET") {
    sendJson(response, 200, { employees: await listEmployees(sessionUser, Object.fromEntries(requestUrl.searchParams)) }, request);
    return true;
  }
  if (route === "/api/employees" && request.method === "POST") {
    sendJson(
      response,
      201,
      { employee: await createEmployee(sessionUser, await parseJsonBody(request), clientIp), message: "Empleado registrado correctamente." },
      request
    );
    return true;
  }
  const employeeMatch = route.match(/^\/api\/employees\/(\d+)$/);
  if (employeeMatch && request.method === "GET") {
    sendJson(response, 200, { employee: await getEmployee(sessionUser, employeeMatch[1]) }, request);
    return true;
  }
  if (employeeMatch && request.method === "PUT") {
    sendJson(
      response,
      200,
      { employee: await updateEmployee(sessionUser, employeeMatch[1], await parseJsonBody(request), clientIp), message: "Empleado actualizado correctamente." },
      request
    );
    return true;
  }
  if (employeeMatch && request.method === "DELETE") {
    const body = await parseJsonBody(request);
    assertAllowedFields(body, ["confirmation"], "baja de empleado");
    sendJson(
      response,
      200,
      { ...(await deleteEmployee(sessionUser, employeeMatch[1], body.confirmation, clientIp)), message: "Empleado eliminado correctamente." },
      request
    );
    return true;
  }

  if (route === "/api/records" && request.method === "GET") {
    sendJson(response, 200, await getDataset(sessionUser, Object.fromEntries(requestUrl.searchParams)), request);
    return true;
  }
  if (route === "/api/records" && request.method === "PUT") {
    sendJson(response, 200, await saveDataset(sessionUser, await parseJsonBody(request, 1024 * 1024)), request);
    return true;
  }
  if (route === "/api/accounting/reports" && request.method === "GET") {
    sendJson(response, 200, { report: await getAccountingReport(sessionUser, Object.fromEntries(requestUrl.searchParams)) }, request);
    return true;
  }
  if (route === "/api/uploads/validate" && request.method === "POST") {
    enforceRateLimit(request, "uploads", 20, 10 * 60 * 1000);
    const body = await parseJsonBody(request, 6 * 1024 * 1024);
    assertAllowedFields(body, ["filename", "contentBase64"], "validacion de archivo");
    const validated = validateAndPrepareUpload({
      filename: body.filename,
      buffer: Buffer.from(String(body.contentBase64 || ""), "base64"),
    });
    sendJson(response, 200, { valid: true, file: validated }, request);
    return true;
  }
  return false;
}

function sanitizeClientErrorMessage(error, statusCode) {
  if (statusCode >= 500) {
    return "No se pudo completar la solicitud por un error interno del servidor.";
  }
  const msg = String(error?.message || "No se pudo completar la solicitud.");
  // Evitar filtrar detalles internos de SQL o rutas de archivos del servidor
  if (/SELECT\s+|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|syntax error at or near|relation\s+".*"\s+does not exist/i.test(msg)) {
    return "Error al procesar los datos solicitados.";
  }
  return msg;
}

async function handleRequest(request, response) {
  if (enforceHttps(request, response)) return;

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {}, request);
    return;
  }
  const requestUrl = new URL(request.url, `http://${request.headers.host || `localhost:${PORT}`}`);
  try {
    if (requestUrl.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, requestUrl);
      if (!handled) sendJson(response, 404, { message: "La ruta solicitada no existe." }, request);
      return;
    }
    serveStaticFile(requestUrl, response, request);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    const extraHeaders = error?.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {};
    console.error(`[${request.method}] ${requestUrl.pathname} (${statusCode}):`, error.message);
    sendJson(
      response,
      statusCode,
      { message: sanitizeClientErrorMessage(error, statusCode) },
      request,
      extraHeaders
    );
  }
}

async function start() {
  await ensureAuthTables();
  await ensureRecordsTable();
  await ensureAccountingTables();
  await ensureEmployeesTable();
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
  });
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error("No se pudo iniciar el servidor:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  PUBLIC_API_ROUTES,
  buildSecurityHeaders,
  buildSessionCookie,
  enforceHttps,
  extractSessionToken,
  handleRequest,
  sanitizeClientErrorMessage,
  start,
};
