const crypto = require("crypto");
const pool = require("./connection");
const { sendRecoveryEmail } = require("./mailer");
const { getEnvConfig } = require("./env");
const { assertAllowedFields, parsePagination, sanitizeText } = require("./validator");
const { checkLoginLockout, clearLoginAttempts, recordFailedLoginAttempt, stripBotFields } = require("./security");
const { ensureAuditTable, logSecurityEvent } = require("./audit");
const { normalizePermissions } = require("./permissions");

const COMPANIES = [
  { legacyCode: "TEXTILES_GH", code: "VICMAR_HN", name: "Vicmar", legalName: "Telas Americanas Vicmar, S. de R.L.", countryCode: "HN", countryName: "Honduras", locale: "es-HN", currencyCode: "HNL", currencySymbol: "L", taxIdLabel: "RTN", taxId: "0801-2024-166420", taxRate: 15, city: "Villanueva, Cortes" },
  { legacyCode: "SALDOS_OLIMPICA_5", code: "TELAS_OLIMPICA_MX", name: "Telas Olímpica", legalName: "Telas Olímpica, S.A. de C.V.", countryCode: "MX", countryName: "México", locale: "es-MX", currencyCode: "MXN", currencySymbol: "$", taxIdLabel: "RFC", taxId: "TELAS", taxRate: 16, city: "Ciudad de México" },
  { legacyCode: "GRUPO_CIRSA", code: "GRUPO_CIRSA_HN", name: "Grupo Cirsa", legalName: "Grupo Cirsa, S. de R.L.", countryCode: "HN", countryName: "Honduras", locale: "es-HN", currencyCode: "HNL", currencySymbol: "L", taxIdLabel: "RTN", taxId: "0801-2026-104521", taxRate: 15, city: "Tegucigalpa, Francisco Morazan" },
];
const ALLOWED_ROLES = ["Empleado", "Ventas", "Compras", "Inventarios", "Contabilidad"];
const SESSION_HOURS = 12;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = "sha512";

const COMPANY_COLUMNS = "id, code, name, legal_name, rtn, country_code, country_name, locale, currency_code, currency_symbol, tax_id_label, tax_id, tax_rate, city, active";

function normalizeLoginValue(value = "") {
  return String(value).trim().toLowerCase();
}

function cleanText(value = "") {
  return sanitizeText(value, 500);
}

function validateEmailAddress(value) {
  const email = normalizeLoginValue(value);
  if (!email || email.length > 180) throw new Error("Ingresa un correo electronico valido.");
  const parts = email.split("@");
  if (parts.length !== 2) throw new Error("Ingresa un correo electronico valido.");
  const [localPart, domain] = parts;
  if (!localPart || localPart.length > 64 || localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) {
    throw new Error("Revisa el nombre del correo antes del signo @.");
  }
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(localPart)) {
    throw new Error("El correo contiene caracteres no permitidos.");
  }
  const labels = domain.split(".");
  const domainIsValid = labels.length >= 2 && labels.every((label) => (
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
  const topLevelDomain = labels.at(-1) || "";
  if (!domainIsValid || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(topLevelDomain)) {
    throw new Error("Revisa el dominio del correo electronico.");
  }
  if (["example", "invalid", "localhost", "test"].includes(topLevelDomain)) {
    throw new Error("Utiliza un correo real al que puedas acceder.");
  }
  const commonTypos = {
    "gmial.com": "gmail.com",
    "gmai.com": "gmail.com",
    "hotnail.com": "hotmail.com",
    "outlok.com": "outlook.com",
    "yaho.com": "yahoo.com",
  };
  if (commonTypos[domain]) throw new Error(`Revisa el dominio. Quisiste escribir ${commonTypos[domain]}?`);
  return email;
}

function applyPepper(password, pepperOverride = undefined) {
  const env = getEnvConfig();
  const pepper = pepperOverride !== undefined ? pepperOverride : env.PASSWORD_PEPPER;
  if (!pepper) return String(password);
  return crypto.createHmac("sha256", pepper).update(String(password)).digest("hex");
}

function hashPassword(password, salt = crypto.randomBytes(32).toString("hex"), pepperOverride = undefined) {
  const material = applyPepper(password, pepperOverride);
  const hash = crypto.pbkdf2Sync(material, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return `pbkdf2:${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

function verifyPassword(password, storedHash, legacyPassword, pepperOverride = undefined) {
  if (!storedHash) {
    if (getEnvConfig().IS_PRODUCTION) return false;
    return Boolean(legacyPassword) && String(legacyPassword) === String(password || "");
  }

  if (storedHash.startsWith("pbkdf2:")) {
    const [, iterStr, salt, expected] = storedHash.split(":");
    const iterations = Number(iterStr) || PBKDF2_ITERATIONS;
    const expectedBuffer = Buffer.from(expected || "", "hex");
    if (!salt || expectedBuffer.length !== PBKDF2_KEYLEN) return false;

    const materialWithPepper = applyPepper(password, pepperOverride);
    const actualWithPepper = crypto.pbkdf2Sync(materialWithPepper, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST);
    if (actualWithPepper.length === expectedBuffer.length && crypto.timingSafeEqual(actualWithPepper, expectedBuffer)) {
      return true;
    }

    // Compatibilidad si el hash fue creado antes de configurar PASSWORD_PEPPER
    const actualRaw = crypto.pbkdf2Sync(String(password), salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST);
    return actualRaw.length === expectedBuffer.length && crypto.timingSafeEqual(actualRaw, expectedBuffer);
  }

  if (storedHash.startsWith("scrypt:")) {
    const [, salt, expected] = storedHash.split(":");
    const actual = crypto.scryptSync(String(password), salt, 64);
    const expectedBuffer = Buffer.from(expected || "", "hex");
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
  }

  return false;
}

function publicCompany(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalName: row.legal_name,
    rtn: row.tax_id || row.rtn,
    countryCode: row.country_code,
    countryName: row.country_name,
    locale: row.locale,
    currencyCode: row.currency_code,
    currencySymbol: row.currency_symbol,
    taxIdLabel: row.tax_id_label,
    taxId: row.tax_id || row.rtn,
    taxRate: Number(row.tax_rate),
    city: row.city,
    active: Boolean(row.active),
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    secondLastName: user.second_last_name || "",
    email: user.email,
    username: user.username,
    companyId: user.company_id,
    companyCode: user.company_code,
    company: user.company_name || user.company,
    countryCode: user.country_code,
    countryName: user.country_name,
    locale: user.locale,
    currencyCode: user.currency_code,
    currencySymbol: user.currency_symbol,
    taxIdLabel: user.tax_id_label,
    taxId: user.tax_id,
    taxRate: Number(user.tax_rate || 0),
    city: user.city,
    role: user.role,
    isGlobalAdmin: Boolean(user.is_global_admin),
    permissions: normalizePermissions(user.permissions_json, user.role),
    createdAt: user.created_at,
  };
}

function publicRegistration(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    secondLastName: row.second_last_name || "",
    email: row.email,
    username: row.username,
    companyId: row.company_id,
    companyCode: row.company_code,
    company: row.company_name || row.company,
    role: row.role,
    status: row.status,
    rejectionReason: row.rejection_reason || "",
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function validateRegistration(rawUserData) {
  const userData = stripBotFields(rawUserData);
  assertAllowedFields(
    userData,
    ["firstName", "lastName", "secondLastName", "email", "username", "password", "companyId", "role"],
    "registro de usuario"
  );

  const firstName = cleanText(userData.firstName);
  const lastName = cleanText(userData.lastName);
  const secondLastName = cleanText(userData.secondLastName);
  const email = validateEmailAddress(userData.email);
  const username = normalizeLoginValue(userData.username);
  const password = String(userData.password || "");
  const role = cleanText(userData.role) || "Empleado";

  if (!firstName || !lastName || !email || !username || !password || !userData.companyId) {
    throw new Error("Completa todos los campos obligatorios.");
  }
  if (!/^[\p{L}][\p{L}\s.'-]{1,79}$/u.test(firstName) || !/^[\p{L}][\p{L}\s.'-]{1,79}$/u.test(lastName)) {
    throw new Error("El nombre y los apellidos solo pueden contener letras, espacios, apostrofes o guiones.");
  }
  if (secondLastName && !/^[\p{L}][\p{L}\s.'-]{1,79}$/u.test(secondLastName)) {
    throw new Error("El segundo apellido solo puede contener letras, espacios, apostrofes o guiones.");
  }
  if (!/^[a-z0-9._-]{4,40}$/.test(username)) {
    throw new Error("El usuario debe tener entre 4 y 40 caracteres: letras, numeros, punto, guion o guion bajo.");
  }
  if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error("La contrasena debe tener entre 8 y 72 caracteres, una letra y un numero.");
  }
  if (/^(?:12345678|password|contrasena|qwerty\d*)$/i.test(password) || password.toLowerCase().includes(username)) {
    throw new Error("Elige una contrasena que no sea comun ni contenga tu usuario.");
  }
  if (!ALLOWED_ROLES.includes(role)) {
    throw new Error("Selecciona un area de acceso valida.");
  }
  return { firstName, lastName, secondLastName, email, username, password, role };
}

async function addColumn(tableName, definition) {
  const portableDefinition = definition.replace(/\s+AFTER\s+\w+$/i, "");
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${portableDefinition}`);
}

let authTablesPromise = null;
let companiesCache = null;
let companiesCacheUntil = 0;
const sessionCache = new Map();
const SESSION_CACHE_TTL_MS = 15_000;

async function ensureAuthTables() {
  if (!authTablesPromise) {
    authTablesPromise = ensureAuthTablesInternal().catch((error) => {
      authTablesPromise = null;
      throw error;
    });
  }
  return authTablesPromise;
}

async function ensureAuthTablesInternal() {
  await pool.query(`CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(160) NOT NULL UNIQUE,
    legal_name VARCHAR(200) NOT NULL,
    rtn VARCHAR(40) NOT NULL,
    country_code CHAR(2) NOT NULL DEFAULT 'HN',
    country_name VARCHAR(80) NOT NULL DEFAULT 'Honduras',
    locale VARCHAR(12) NOT NULL DEFAULT 'es-HN',
    currency_code CHAR(3) NOT NULL DEFAULT 'HNL',
    currency_symbol VARCHAR(8) NOT NULL DEFAULT 'L',
    tax_id_label VARCHAR(20) NOT NULL DEFAULT 'RTN',
    tax_id VARCHAR(40) NOT NULL DEFAULT '',
    tax_rate DECIMAL(5,2) NOT NULL DEFAULT 15,
    city VARCHAR(120) NOT NULL DEFAULT 'Tegucigalpa',
    active SMALLINT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await addColumn("companies", "country_code CHAR(2) NOT NULL DEFAULT 'HN' AFTER rtn");
  await addColumn("companies", "country_name VARCHAR(80) NOT NULL DEFAULT 'Honduras' AFTER country_code");
  await addColumn("companies", "locale VARCHAR(12) NOT NULL DEFAULT 'es-HN' AFTER country_name");
  await addColumn("companies", "currency_code CHAR(3) NOT NULL DEFAULT 'HNL' AFTER locale");
  await addColumn("companies", "currency_symbol VARCHAR(8) NOT NULL DEFAULT 'L' AFTER currency_code");
  await addColumn("companies", "tax_id_label VARCHAR(20) NOT NULL DEFAULT 'RTN' AFTER currency_symbol");
  await addColumn("companies", "tax_id VARCHAR(40) NOT NULL DEFAULT '' AFTER tax_id_label");
  await addColumn("companies", "tax_rate DECIMAL(5,2) NOT NULL DEFAULT 15 AFTER tax_id");
  await addColumn("companies", "city VARCHAR(120) NOT NULL DEFAULT 'Tegucigalpa' AFTER tax_rate");

  for (const company of COMPANIES) {
    const [existing] = await pool.query(
      "SELECT id FROM companies WHERE code IN (?, ?) ORDER BY CASE WHEN code = ? THEN 0 ELSE 1 END LIMIT 1",
      [company.code, company.legacyCode, company.code]
    );
    if (existing.length) {
      await pool.query(
        `UPDATE companies SET code = ?, name = ?, legal_name = ?, rtn = ?, country_code = ?, country_name = ?, locale = ?,
         currency_code = ?, currency_symbol = ?, tax_id_label = ?, tax_id = ?, tax_rate = ?, city = ?, active = 1 WHERE id = ?`,
        [company.code, company.name, company.legalName, company.taxId, company.countryCode, company.countryName, company.locale, company.currencyCode, company.currencySymbol, company.taxIdLabel, company.taxId, company.taxRate, company.city, existing[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO companies
         (code, name, legal_name, rtn, country_code, country_name, locale, currency_code, currency_symbol, tax_id_label, tax_id, tax_rate, city)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [company.code, company.name, company.legalName, company.taxId, company.countryCode, company.countryName, company.locale, company.currencyCode, company.currencySymbol, company.taxIdLabel, company.taxId, company.taxRate, company.city]
      );
    }
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    first_name VARCHAR(120) NOT NULL,
    last_name VARCHAR(120) NOT NULL,
    second_last_name VARCHAR(120),
    email VARCHAR(180) NOT NULL UNIQUE,
    username VARCHAR(80) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL DEFAULT '',
    password_hash VARCHAR(255),
    company VARCHAR(160),
    company_id INT,
    role VARCHAR(40) NOT NULL DEFAULT 'Empleado',
    is_global_admin SMALLINT NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'Activo',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await addColumn("users", "password_hash VARCHAR(255) NULL AFTER password");
  await addColumn("users", "company_id INT NULL AFTER company");
  await addColumn("users", "is_global_admin SMALLINT NOT NULL DEFAULT 0 AFTER role");
  await addColumn("users", "status VARCHAR(30) NOT NULL DEFAULT 'Activo' AFTER is_global_admin");
  await addColumn("users", "permissions_json TEXT NULL AFTER status");

  await pool.query(`CREATE TABLE IF NOT EXISTS registration_requests (
    id SERIAL PRIMARY KEY,
    first_name VARCHAR(120) NOT NULL,
    last_name VARCHAR(120) NOT NULL,
    second_last_name VARCHAR(120),
    email VARCHAR(180) NOT NULL,
    username VARCHAR(80) NOT NULL,
    password VARCHAR(255) NOT NULL DEFAULT '',
    password_hash VARCHAR(255),
    company VARCHAR(160),
    company_id INT NOT NULL,
    role VARCHAR(40) NOT NULL DEFAULT 'Empleado',
    status VARCHAR(30) NOT NULL DEFAULT 'Pendiente',
    decided_by INT NULL,
    decided_at TIMESTAMP NULL,
    rejection_reason VARCHAR(300) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await addColumn("registration_requests", "password_hash VARCHAR(255) NULL AFTER password");
  await addColumn("registration_requests", "company_id INT NULL AFTER company");
  await addColumn("registration_requests", "decided_by INT NULL AFTER status");
  await addColumn("registration_requests", "decided_at TIMESTAMP NULL AFTER decided_by");
  await addColumn("registration_requests", "rejection_reason VARCHAR(300) NULL AFTER decided_at");

  await pool.query(`CREATE TABLE IF NOT EXISTS auth_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS password_recovery_tokens (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(120) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await ensureAuditTable();

  const [defaultCompany] = await pool.query("SELECT id, name FROM companies WHERE code = 'VICMAR_HN' LIMIT 1");
  await pool.query(
    `UPDATE users SET company_id = COALESCE(users.company_id, c.id, ?), company = COALESCE(c.name, users.company, ?)
     FROM companies c WHERE c.name = users.company AND users.company_id IS NULL`,
    [defaultCompany[0].id, defaultCompany[0].name]
  );
  await pool.query(
    `UPDATE registration_requests SET company_id = COALESCE(registration_requests.company_id, c.id, ?), company = COALESCE(c.name, registration_requests.company, ?)
     FROM companies c WHERE c.name = registration_requests.company AND registration_requests.company_id IS NULL`,
    [defaultCompany[0].id, defaultCompany[0].name]
  );
  await pool.query("UPDATE users SET company = c.name FROM companies c WHERE c.id = users.company_id");
  await pool.query("UPDATE registration_requests SET company = c.name FROM companies c WHERE c.id = registration_requests.company_id");

  const [globalAdmins] = await pool.query("SELECT id FROM users WHERE is_global_admin = 1 AND status = 'Activo' LIMIT 1");
  const env = getEnvConfig();
  const bootstrapPassword = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!globalAdmins.length && bootstrapPassword) {
    if (bootstrapPassword.length < 12 || bootstrapPassword.length > 72 || !/[A-Za-z]/.test(bootstrapPassword) || !/\d/.test(bootstrapPassword)) {
      throw new Error("BOOTSTRAP_ADMIN_PASSWORD debe tener entre 12 y 72 caracteres, una letra y un numero.");
    }
    const bootstrapEmail = validateEmailAddress(env.BOOTSTRAP_ADMIN_EMAIL || "administrador@vicmar.hn");
    const bootstrapUsername = normalizeLoginValue(env.BOOTSTRAP_ADMIN_USERNAME || "administrador");
    if (!/^[a-z0-9._-]{4,40}$/.test(bootstrapUsername)) throw new Error("BOOTSTRAP_ADMIN_USERNAME no es valido.");
    await pool.query(
      `INSERT INTO users (first_name, last_name, second_last_name, email, username, password, password_hash, company, company_id, role, is_global_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ["Administrador", "Global", null, bootstrapEmail, bootstrapUsername, "__HASHED__", hashPassword(bootstrapPassword), defaultCompany[0].name, defaultCompany[0].id, "Administrador"]
    );
  }
}

async function listCompanies() {
  if (companiesCache && Date.now() < companiesCacheUntil) {
    return companiesCache;
  }
  await ensureAuthTables();
  const [rows] = await pool.query(
    `SELECT ${COMPANY_COLUMNS} FROM companies WHERE active = 1
     ORDER BY CASE code WHEN 'VICMAR_HN' THEN 1 WHEN 'TELAS_OLIMPICA_MX' THEN 2 WHEN 'GRUPO_CIRSA_HN' THEN 3 ELSE 4 END LIMIT 50`
  );
  companiesCache = rows.map(publicCompany);
  companiesCacheUntil = Date.now() + 60_000;
  return companiesCache;
}

async function requestRegistration(userData, ipAddress = "local") {
  await ensureAuthTables();
  const valid = validateRegistration(userData);
  const [companies] = await pool.query(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = ? AND active = 1 LIMIT 1`, [Number(userData.companyId)]);
  if (companies.length === 0) throw new Error("La empresa seleccionada no esta disponible.");
  const [existingUsers] = await pool.query("SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1", [valid.username, valid.email]);
  if (existingUsers.length > 0) throw new Error("Ya existe una cuenta registrada con ese usuario o correo.");
  const [existingRequests] = await pool.query(
    "SELECT id FROM registration_requests WHERE (username = ? OR email = ?) AND status = 'Pendiente' LIMIT 1",
    [valid.username, valid.email]
  );
  if (existingRequests.length > 0) throw new Error("Ya existe una solicitud pendiente con ese usuario o correo.");
  const [result] = await pool.query(
    `INSERT INTO registration_requests
     (first_name, last_name, second_last_name, email, username, password, password_hash, company, company_id, role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [valid.firstName, valid.lastName, valid.secondLastName, valid.email, valid.username, "__HASHED__", hashPassword(valid.password), companies[0].name, companies[0].id, valid.role]
  );
  const [rows] = await pool.query(
    `SELECT r.id, r.first_name, r.last_name, r.second_last_name, r.email, r.username, r.company, r.company_id,
            r.role, r.status, r.rejection_reason, r.created_at, r.decided_at,
            c.code company_code, c.name company_name
     FROM registration_requests r
     JOIN companies c ON c.id = r.company_id WHERE r.id = ? LIMIT 1`,
    [result.insertId]
  );
  await logSecurityEvent({
    companyId: companies[0].id,
    action: "USER_REGISTERED",
    severity: "INFO",
    ipAddress,
    details: { requestId: result.insertId, username: valid.username, role: valid.role },
  });
  return publicRegistration(rows[0]);
}

async function loginUser(username, password, ipAddress = "local") {
  await ensureAuthTables();
  const login = normalizeLoginValue(username);
  if (!login || !password) return null;

  checkLoginLockout(login, ipAddress);

  const [rows] = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.second_last_name, u.email, u.username, u.password, u.password_hash,
            u.company, u.company_id, u.role, u.is_global_admin, u.status, u.permissions_json, u.created_at,
            c.code company_code, c.name company_name, c.country_code, c.country_name, c.locale, c.currency_code,
            c.currency_symbol, c.tax_id_label, c.tax_id, c.tax_rate, c.city
     FROM users u
     JOIN companies c ON c.id = u.company_id
     WHERE (u.username = ? OR u.email = ?) AND u.status = 'Activo' LIMIT 1`,
    [login, login]
  );

  if (rows.length === 0 || !verifyPassword(password, rows[0].password_hash, rows[0].password)) {
    recordFailedLoginAttempt(login, ipAddress);
    await logSecurityEvent({
      companyId: rows[0]?.company_id || null,
      userId: rows[0]?.id || null,
      action: "AUTH_LOGIN_FAILED",
      severity: "WARN",
      ipAddress,
      details: { username: login },
    });
    return null;
  }

  clearLoginAttempts(login, ipAddress);

  // Actualizar hash legado a PBKDF2-HMAC-SHA512 con sal de 32 bytes y pepper
  if (!rows[0].password_hash || !rows[0].password_hash.startsWith("pbkdf2:")) {
    await pool.query("UPDATE users SET password_hash = ?, password = '__HASHED__' WHERE id = ?", [hashPassword(password), rows[0].id]);
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
  await pool.query("DELETE FROM auth_sessions WHERE expires_at <= NOW() OR revoked_at IS NOT NULL");
  await pool.query("INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)", [rows[0].id, tokenHash, expiresAt]);

  await logSecurityEvent({
    companyId: rows[0].company_id,
    userId: rows[0].id,
    action: "AUTH_LOGIN_SUCCESS",
    severity: "INFO",
    ipAddress,
    details: { username: rows[0].username, role: rows[0].role },
  });

  return { user: publicUser(rows[0]), token, expiresAt };
}

async function getSession(token) {
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
  const cached = sessionCache.get(tokenHash);
  if (cached && Date.now() < cached.until) {
    return cached.user;
  }
  await ensureAuthTables();
  const [rows] = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.second_last_name, u.email, u.username,
            u.company, u.company_id, u.role, u.is_global_admin, u.status, u.permissions_json, u.created_at,
            c.code company_code, c.name company_name, c.country_code, c.country_name, c.locale, c.currency_code,
            c.currency_symbol, c.tax_id_label, c.tax_id, c.tax_rate, c.city, s.expires_at session_expires_at
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     JOIN companies c ON c.id = u.company_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > NOW() AND u.status = 'Activo' LIMIT 1`,
    [tokenHash]
  );
  const user = rows.length ? { ...publicUser(rows[0]), sessionExpiresAt: rows[0].session_expires_at } : null;
  if (user) {
    sessionCache.set(tokenHash, { user, until: Date.now() + SESSION_CACHE_TTL_MS });
  } else {
    sessionCache.delete(tokenHash);
  }
  return user;
}

async function revokeSession(token) {
  if (!token) return;
  const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
  sessionCache.delete(tokenHash);
  await pool.query("UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = ?", [tokenHash]);
}

function assertGlobalAdmin(user) {
  if (!user?.isGlobalAdmin || user.role !== "Administrador") {
    const error = new Error("Solo el administrador global puede autorizar registros.");
    error.statusCode = 403;
    throw error;
  }
}

async function getRegistrations(adminUser, filters = {}) {
  await ensureAuthTables();
  assertGlobalAdmin(adminUser);
  const { limit, offset } = parsePagination(filters, 100, 500);
  const conditions = [];
  const values = [];
  if (filters.status && filters.status !== "Todos") {
    conditions.push("r.status = ?");
    values.push(cleanText(filters.status));
  }
  if (filters.companyId) {
    conditions.push("r.company_id = ?");
    values.push(Number(filters.companyId));
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(limit, offset);
  const [rows] = await pool.query(
    `SELECT r.id, r.first_name, r.last_name, r.second_last_name, r.email, r.username,
            r.company, r.company_id, r.role, r.status, r.rejection_reason, r.created_at, r.decided_at,
            c.code company_code, c.name company_name
     FROM registration_requests r
     JOIN companies c ON c.id = r.company_id
     ${where}
     ORDER BY c.name, r.created_at DESC
     LIMIT ? OFFSET ?`,
    values
  );
  return rows.map(publicRegistration);
}

async function approveRegistration(id, adminUser, ipAddress = "local") {
  await ensureAuthTables();
  assertGlobalAdmin(adminUser);
  const connection = await pool.getConnection(adminUser);
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, first_name, last_name, second_last_name, email, username, password, password_hash, company, company_id, role
       FROM registration_requests WHERE id = ? AND status = 'Pendiente' FOR UPDATE`,
      [Number(id)]
    );
    if (!rows.length) throw new Error("La solicitud no existe o ya fue procesada.");
    const request = rows[0];
    const [duplicates] = await connection.query("SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1", [request.username, request.email]);
    if (duplicates.length) throw new Error("Ya existe una cuenta con ese usuario o correo.");
    const [result] = await connection.query(
      `INSERT INTO users (first_name, last_name, second_last_name, email, username, password, password_hash, company, company_id, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [request.first_name, request.last_name, request.second_last_name, request.email, request.username, "__HASHED__", request.password_hash || hashPassword(request.password), request.company, request.company_id, request.role]
    );
    const defaultBranch = Number(request.company_id) === 2 ? "Sucursal Principal CDMX" : "Sucursal Principal";
    const defaultPosition =
      request.role && request.role !== "Empleado" ? `Especialista de ${request.role}` : "Auxiliar Operativo Textil";
    await connection.query(
      `INSERT INTO employees
       (company_id, first_name, last_name, second_last_name, email, gender, position, branch, system_role, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'No especificado', ?, ?, ?, 'Activo', ?)
       ON CONFLICT (company_id, email) DO UPDATE
       SET first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           second_last_name = EXCLUDED.second_last_name,
           system_role = EXCLUDED.system_role,
           status = 'Activo',
           updated_at = CURRENT_TIMESTAMP`,
      [
        request.company_id,
        request.first_name,
        request.last_name,
        request.second_last_name || null,
        request.email,
        defaultPosition,
        defaultBranch,
        request.role || "Empleado",
        adminUser.id,
      ]
    );
    await connection.query("UPDATE registration_requests SET status = 'Aprobada', decided_by = ?, decided_at = NOW() WHERE id = ?", [adminUser.id, request.id]);
    await connection.commit();
    const [users] = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.second_last_name, u.email, u.username,
              u.company, u.company_id, u.role, u.is_global_admin, u.status, u.permissions_json, u.created_at,
              c.code company_code, c.name company_name, c.country_code, c.country_name, c.locale, c.currency_code,
              c.currency_symbol, c.tax_id_label, c.tax_id, c.tax_rate, c.city
       FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ? LIMIT 1`,
      [result.insertId]
    );
    await logSecurityEvent({
      companyId: request.company_id,
      userId: adminUser.id,
      action: "REGISTRATION_APPROVED",
      severity: "INFO",
      ipAddress,
      details: { approvedUserId: result.insertId, username: request.username, role: request.role },
    });
    return publicUser(users[0]);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function rejectRegistration(id, adminUser, reason = "", ipAddress = "local") {
  await ensureAuthTables();
  assertGlobalAdmin(adminUser);
  const cleanReason = cleanText(reason).slice(0, 300);
  const [result] = await pool.query(
    `UPDATE registration_requests SET status = 'Rechazada', decided_by = ?, decided_at = NOW(), rejection_reason = ?
     WHERE id = ? AND status = 'Pendiente'`,
    [adminUser.id, cleanReason, Number(id)]
  );
  if (!result.affectedRows) throw new Error("La solicitud no existe o ya fue procesada.");
  await logSecurityEvent({
    userId: adminUser.id,
    action: "REGISTRATION_REJECTED",
    severity: "INFO",
    ipAddress,
    details: { requestId: Number(id), reason: cleanReason },
  });
}

async function sendPasswordRecovery(email, origin = "http://localhost:3000", ipAddress = "local") {
  await ensureAuthTables();
  const normalizedEmail = validateEmailAddress(email);
  const [rows] = await pool.query("SELECT id, email, username, company_id FROM users WHERE email = ? AND status = 'Activo' LIMIT 1", [normalizedEmail]);
  if (!rows.length) return { sent: true, delivered: false };
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await pool.query("UPDATE password_recovery_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL", [rows[0].id]);
  await pool.query("INSERT INTO password_recovery_tokens (user_id, token, expires_at) VALUES (?, ?, ?)", [rows[0].id, token, expiresAt]);
  const recoveryUrl = `${origin}/restablecer.html?token=${token}`;
  const delivery = await sendRecoveryEmail({ to: rows[0].email, username: rows[0].username, recoveryUrl });
  await logSecurityEvent({
    companyId: rows[0].company_id,
    userId: rows[0].id,
    action: "PASSWORD_RECOVERY_REQUESTED",
    severity: "INFO",
    ipAddress,
  });
  return { sent: true, emailRegistered: true, delivered: delivery.delivered, recoveryUrl: getEnvConfig().IS_PRODUCTION ? undefined : recoveryUrl };
}

async function resetPassword(token, password, ipAddress = "local") {
  await ensureAuthTables();
  if (!String(token || "").trim()) throw new Error("El enlace de recuperacion no es valido.");
  if (String(password || "").length < 8 || String(password || "").length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error("La nueva contrasena debe tener entre 8 y 72 caracteres, una letra y un numero.");
  }
  if (/^(?:12345678|password|contrasena|qwerty\d*)$/i.test(String(password))) {
    throw new Error("La nueva contrasena es demasiado comun.");
  }
  const [rows] = await pool.query(
    "SELECT id, user_id FROM password_recovery_tokens WHERE token = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1",
    [String(token).trim()]
  );
  if (!rows.length) throw new Error("El enlace de recuperacion expiro o ya fue usado.");
  await pool.query("UPDATE users SET password_hash = ?, password = '__HASHED__' WHERE id = ?", [hashPassword(password), rows[0].user_id]);
  await pool.query("UPDATE password_recovery_tokens SET used_at = NOW() WHERE id = ?", [rows[0].id]);
  await pool.query("UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL", [rows[0].user_id]);
  sessionCache.clear();
  await logSecurityEvent({
    userId: rows[0].user_id,
    action: "PASSWORD_RESET_COMPLETED",
    severity: "WARN",
    ipAddress,
  });
  return { reset: true };
}

async function deleteOwnAccount(user, password, confirmation, ipAddress = "local") {
  await ensureAuthTables();
  if (String(confirmation || "").trim().toUpperCase() !== "ELIMINAR MI CUENTA") {
    throw new Error("Escribe ELIMINAR MI CUENTA para confirmar.");
  }
  const connection = await pool.getConnection(user);
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, password, password_hash, is_global_admin, company_id FROM users WHERE id = ? AND status = 'Activo' FOR UPDATE",
      [user.id]
    );
    if (!rows.length) throw new Error("La cuenta ya no esta activa.");
    const account = rows[0];
    if (!verifyPassword(password, account.password_hash, account.password)) {
      const error = new Error("La contrasena actual no es correcta.");
      error.statusCode = 403;
      throw error;
    }
    if (account.is_global_admin) {
      const [admins] = await connection.query(
        "SELECT COUNT(*) total FROM users WHERE is_global_admin = 1 AND status = 'Activo' AND id <> ?",
        [account.id]
      );
      if (!Number(admins[0].total)) {
        const error = new Error("No puedes eliminar la ultima cuenta de administrador global.");
        error.statusCode = 409;
        throw error;
      }
    }
    const suffix = crypto.randomBytes(6).toString("hex");
    const deletedEmail = `eliminada+${account.id}+${suffix}@cuentas.invalid`;
    const deletedUsername = `eliminado_${account.id}_${suffix}`;
    await connection.query(
      `UPDATE users SET first_name = 'Cuenta', last_name = 'eliminada', second_last_name = NULL,
       email = ?, username = ?, password = '__HASHED__', password_hash = ?, role = 'Empleado',
       is_global_admin = 0, status = 'Eliminado' WHERE id = ?`,
      [deletedEmail, deletedUsername, hashPassword(crypto.randomBytes(32).toString("hex")), account.id]
    );
    await connection.query("UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL", [account.id]);
    await connection.query("UPDATE password_recovery_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL", [account.id]);
    await connection.commit();
    await logSecurityEvent({
      companyId: account.company_id,
      userId: account.id,
      action: "ACCOUNT_DELETED",
      severity: "HIGH",
      ipAddress,
    });
    return { deleted: true };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function clearSessionCache() {
  sessionCache.clear();
}

module.exports = {
  ALLOWED_ROLES,
  approveRegistration,
  cleanText,
  clearSessionCache,
  deleteOwnAccount,
  ensureAuthTables,
  getRegistrations,
  getSession,
  hashPassword,
  listCompanies,
  loginUser,
  rejectRegistration,
  requestRegistration,
  resetPassword,
  revokeSession,
  sendPasswordRecovery,
  validateEmailAddress,
  verifyPassword,
};
