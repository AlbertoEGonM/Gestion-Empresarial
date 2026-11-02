process.env.SUPABASE_DB_URL = "local";
process.env.NODE_ENV = "test";
process.env.DATA_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DATA_HMAC_KEY = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
process.env.PASSWORD_PEPPER = "test-pepper-secret-2026";
process.env.ALLOWED_ORIGINS = "https://erp.vicmar.hn,http://localhost:3000";

const test = require("node:test");
const assert = require("node:assert/strict");
const { blindIndex, decryptField, encryptField } = require("../config/crypto-fields");
const { ensureAuthTables, hashPassword, verifyPassword } = require("../config/db");
const {
  assertAllowedFields,
  escapeHtml,
  parsePagination,
  sanitizeText,
  validateModuleAndView,
} = require("../config/validator");
const { canAccessModule, resolveTenantCompanyId } = require("../config/permissions");
const { getDataset, saveDataset } = require("../modules/records");
const {
  checkLoginLockout,
  recordFailedLoginAttempt,
  resetAllLockoutsForTest,
  verifyBotProtection,
} = require("../config/security");
const { validateAndPrepareUpload } = require("../config/file-security");
const { listAuditLogs, logSecurityEvent } = require("../config/audit");
const {
  buildSecurityHeaders,
  buildSessionCookie,
  enforceHttps,
  extractSessionToken,
  sanitizeClientErrorMessage,
} = require("../server");

test("Punto 5: Cifrado de campos en reposo AES-256-GCM e indice ciego HMAC-SHA256", () => {
  const curp = "GOMA900512HDFRRL09";
  const encrypted = encryptField(curp);
  assert.ok(encrypted.startsWith("enc:v1:"), "Debe incluir prefijo de version de cifrado");
  assert.notEqual(encrypted, curp, "El texto cifrado no debe coincidir con el texto plano");

  const decrypted = decryptField(encrypted);
  assert.equal(decrypted, curp, "El descifrado AES-256-GCM debe recuperar el valor exacto");

  const idx1 = blindIndex(curp);
  const idx2 = blindIndex("  goma900512hdfrrl09 ");
  assert.ok(idx1.startsWith("bidx:"));
  assert.equal(idx1, idx2, "El indice ciego debe ser determinista tras normalizacion");
});

test("Punto 7: Aislamiento Multi-tenant y proteccion Anti-IDOR", () => {
  const normalAdmin = { id: 10, companyId: 1, role: "Administrador", isGlobalAdmin: false };
  const globalAdmin = { id: 1, companyId: 1, role: "Administrador", isGlobalAdmin: true };

  assert.equal(resolveTenantCompanyId(normalAdmin, undefined), 1);
  assert.equal(resolveTenantCompanyId(normalAdmin, 1), 1);

  assert.throws(
    () => resolveTenantCompanyId(normalAdmin, 2),
    /Anti-IDOR/i,
    "Un administrador local no debe poder operar sobre otra empresa"
  );

  assert.equal(resolveTenantCompanyId(globalAdmin, 2), 2, "El administrador global puede alternar empresa");
});

test("Punto 8: Bloqueo de Mass Assignment y campos privilegiados", () => {
  assert.throws(
    () => assertAllowedFields({ username: "juan", is_global_admin: 1 }, ["username", "password"]),
    /prohibido/i
  );
  assert.throws(
    () => assertAllowedFields({ username: "juan", role: "Administrador" }, ["username", "password"]),
    /no permitido/i
  );
  const clean = assertAllowedFields({ username: "juan", password: "Password123" }, ["username", "password"]);
  assert.equal(clean.username, "juan");
});

test("Punto 9: Cookies de sesion HttpOnly, SameSite=Strict y Secure", () => {
  const secureCookie = buildSessionCookie("tok123", true, 43200);
  assert.match(secureCookie, /__Host-gestion_session=tok123/);
  assert.match(secureCookie, /HttpOnly/);
  assert.match(secureCookie, /SameSite=Strict/);
  assert.match(secureCookie, /Secure/);
  assert.match(secureCookie, /Max-Age=43200/);

  const reqWithCookie = { headers: { cookie: "__Host-gestion_session=abc987; other=1" } };
  assert.equal(extractSessionToken(reqWithCookie), "abc987");
});

test("Punto 10: Hashing de contrasenas con PBKDF2-HMAC-SHA512 (100k iteraciones, sal 32B y pepper)", () => {
  const hash = hashPassword("ClaveSegura2026");
  assert.match(hash, /^pbkdf2:100000:[0-9a-f]{64}:[0-9a-f]{128}$/);
  assert.equal(verifyPassword("ClaveSegura2026", hash), true);
  assert.equal(verifyPassword("ClaveIncorrecta99", hash), false);
});

test("Punto 11: Bloqueo progresivo Anti-Brute Force tras intentos fallidos", () => {
  resetAllLockoutsForTest();
  const user = "usuario_objetivo";
  const ip = "203.0.113.55";

  for (let i = 0; i < 5; i += 1) {
    recordFailedLoginAttempt(user, ip);
  }

  assert.throws(
    () => checkLoginLockout(user, ip),
    (err) => err.statusCode === 429 && err.retryAfterSeconds > 0,
    "Debe bloquear con HTTP 429 tras alcanzar el limite de fallos"
  );
  resetAllLockoutsForTest();
});

test("Punto 12: Proteccion Anti-Bots (Honeypot y tiempo minimo de envio)", async () => {
  await assert.rejects(
    () => verifyBotProtection({ website_url: "http://spambot.example.com" }, "127.0.0.1"),
    /Honeypot/i
  );

  await assert.rejects(
    () => verifyBotProtection({ website_url: "", _form_ts: Date.now() }, "127.0.0.1"),
    /demasiado rapido/i
  );

  await assert.doesNotReject(
    () => verifyBotProtection({ website_url: "", _form_ts: Date.now() - 2500 }, "127.0.0.1")
  );
});

test("Punto 14 y 15: Validacion de esquemas y sanitizacion XSS en backend/frontend", () => {
  const dirty = 'Hola <script>alert("xss")</script> <img src=x onerror="steal()"> mundo javascript:evil()';
  const clean = sanitizeText(dirty);
  assert.ok(!clean.includes("<script>"));
  assert.ok(!clean.includes("onerror"));
  assert.ok(!clean.includes("javascript:"));
  assert.equal(clean, "Hola mundo evil()");

  assert.equal(escapeHtml('<b onclick="x">"test"</b>'), "&lt;b onclick=&quot;x&quot;&gt;&quot;test&quot;&lt;/b&gt;");

  assert.throws(() => validateModuleAndView("modulo_inexistente", "ordenes"), /no esta autorizada/i);
  const validMod = validateModuleAndView("compras", "ordenes");
  assert.equal(validMod.moduleKey, "compras");
});

test("Punto 16: Restriccion de subida de archivos (Magic Bytes, Path Traversal y doble extension)", () => {
  assert.throws(
    () => validateAndPrepareUpload({ filename: "../../etc/passwd.csv", buffer: Buffer.from("a,b\n1,2") }),
    /Path Traversal/i
  );

  assert.throws(
    () => validateAndPrepareUpload({ filename: "malware.php.jpg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) }),
    /doble extension/i
  );

  assert.throws(
    () => validateAndPrepareUpload({ filename: "falso.pdf", buffer: Buffer.from("MZ_EXECUTABLE_FAKE_PDF") }),
    /Magic Bytes/i
  );

  const validPdf = validateAndPrepareUpload({
    filename: "factura_proveedor.pdf",
    buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"),
  });
  assert.equal(validPdf.extension, ".pdf");
  assert.match(validPdf.safeStoredName, /^[0-9a-f-]{36}\.pdf$/);
});

test("Punto 17: Paginacion acotada y ocultamiento de errores SQL internos", () => {
  const page = parsePagination({ limit: "25", offset: "50" }, 100, 500);
  assert.equal(page.limit, 25);
  assert.equal(page.offset, 50);

  const clamped = parsePagination({ limit: "999999", offset: "0" }, 100, 500);
  assert.equal(clamped.limit, 500);

  const sqlErr = new Error('syntax error at or near "SELECT * FROM users"');
  assert.equal(sanitizeClientErrorMessage(sqlErr, 400), "Error al procesar los datos solicitados.");
  assert.equal(
    sanitizeClientErrorMessage(new Error("Fallo critico"), 500),
    "No se pudo completar la solicitud por un error interno del servidor."
  );
});

test("Punto 18 y 19: Cabeceras HTTP de seguridad completas, CORS estricto y forzado de HTTPS", () => {
  const reqAllowed = { headers: { origin: "https://erp.vicmar.hn" } };
  const headersAllowed = buildSecurityHeaders(reqAllowed);
  assert.equal(headersAllowed["X-Frame-Options"], "DENY");
  assert.equal(headersAllowed["X-Content-Type-Options"], "nosniff");
  assert.match(headersAllowed["Content-Security-Policy"], /default-src 'self'/);
  assert.match(headersAllowed["Strict-Transport-Security"], /max-age=63072000/);
  assert.equal(headersAllowed["Access-Control-Allow-Origin"], "https://erp.vicmar.hn");

  const reqDisallowed = { headers: { origin: "https://attacker.evil.com" } };
  const headersDisallowed = buildSecurityHeaders(reqDisallowed);
  assert.equal(headersDisallowed["Access-Control-Allow-Origin"], undefined);

  let redirectedStatus = 0;
  let redirectedLocation = "";
  const mockResponse = {
    writeHead(status, hdrs) {
      redirectedStatus = status;
      redirectedLocation = hdrs.Location;
    },
    end() {},
  };
  const insecureGet = { method: "GET", url: "/dashboard.html", headers: { host: "erp.vicmar.hn" }, socket: {} };
  const handled = enforceHttps(insecureGet, mockResponse, true);
  assert.equal(handled, true);
  assert.equal(redirectedStatus, 301);
  assert.equal(redirectedLocation, "https://erp.vicmar.hn/dashboard.html");
});

test("Punto 20: Bitacora de auditoria consultable por empresa y bloqueo RBAC a no administradores", async () => {
  await logSecurityEvent({
    companyId: 1,
    userId: 1,
    action: "DATASET_UPDATED",
    severity: "INFO",
    ipAddress: "127.0.0.1",
    details: { moduleKey: "inventarios", viewKey: "productos", totalRows: 4, username: "gabrielh" },
  });

  const adminActor = { id: 1, username: "gabrielh", role: "Administrador", companyId: 1, isGlobalAdmin: true };
  const logs = await listAuditLogs(adminActor, { companyId: 1, limit: 10 });
  assert.ok(Array.isArray(logs));
  assert.ok(logs.length >= 1);
  assert.equal(logs[0].action, "DATASET_UPDATED");

  const nonAdminActor = { id: 5, username: "vendedor1", role: "Ventas", companyId: 1, isGlobalAdmin: false };
  await assert.rejects(() => listAuditLogs(nonAdminActor, { companyId: 1 }), /Se requiere rol de Administrador/);
});

test("UI/UX & Refactor: RBAC alineado entre cliente/servidor y persistencia de catalogos y configuracion", async () => {
  // Validacion de vista configuracion en modulo administrador
  const validatedConfig = validateModuleAndView("administrador", "configuracion");
  assert.equal(validatedConfig.moduleKey, "administrador");
  assert.equal(validatedConfig.viewKey, "configuracion");

  // Alineacion RBAC para Finanzas y Contabilidad sobre contabilidad, reportes y pos
  assert.equal(canAccessModule("Finanzas", "contabilidad"), true);
  assert.equal(canAccessModule("Finanzas", "reportes"), true);
  assert.equal(canAccessModule("Finanzas", "pos"), true);
  assert.equal(canAccessModule("Contabilidad", "reportes"), true);
  assert.equal(canAccessModule("Ventas", "administrador"), false);

  await ensureAuthTables();
  const adminActor = { id: 1, username: "gabrielh", role: "Administrador", companyId: 1, isGlobalAdmin: true };
  const savedCatalog = await saveDataset(adminActor, {
    moduleKey: "inventarios",
    viewKey: "categorias",
    companyId: 1,
    rows: [["Lino Belga", "100% Lino", "Activo", "", "Asignando..."]],
  });
  assert.equal(savedCatalog.rows.length, 1);
  assert.match(savedCatalog.rows[0].at(-1), /^SER-INV-CAT-\d{6}$/);

  const fetchedCatalog = await getDataset(adminActor, { module: "inventarios", view: "categorias", companyId: 1 });
  assert.equal(fetchedCatalog.rows.length, 1);
  assert.equal(fetchedCatalog.rows[0][0], "Lino Belga");
});
