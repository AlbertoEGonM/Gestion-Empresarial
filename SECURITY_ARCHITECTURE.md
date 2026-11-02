# Arquitectura de Seguridad y Hardening DevSecOps (20 Puntos)

Este documento describe la arquitectura de seguridad implementada en **Gestión Empresarial (ERP Textil Multiempresa)** bajo un enfoque de **Defensa en Profundidad (Defense-in-Depth)** y **Zero Trust**.

---

## Índice de Controles Implementados

1. [Ocultamiento de Claves API y Credenciales](#1-ocultamiento-de-claves-api-y-credenciales)
2. [Eliminación y Prevención de Secretos en Git](#2-eliminación-y-prevención-de-secretos-en-git)
3. [Clave Pública de Base de Datos y Separación de Privilegios](#3-clave-pública-de-base-de-datos-y-separación-de-privilegios)
4. [Row Level Security (RLS) Estricto en Supabase PostgreSQL](#4-row-level-security-rls-estricto-en-supabase-postgresql)
5. [Cifrado de Datos Sensibles en Reposo (AES-256-GCM + Blind Index)](#5-cifrado-de-datos-sensibles-en-reposo-aes-256-gcm--blind-index)
6. [Autenticación Forzada en Servidor (Gateway Deny-by-Default)](#6-autenticación-forzada-en-servidor-gateway-deny-by-default)
7. [Aislamiento Multi-tenant y Prevención de IDOR](#7-aislamiento-multi-tenant-y-prevención-de-idor)
8. [Protección contra Manipulación de Campos (Mass Assignment)](#8-protección-contra-manipulación-de-campos-mass-assignment)
9. [Protección de Cookies de Sesión (`HttpOnly`, `SameSite=Strict`, `Secure`)](#9-protección-de-cookies-de-sesión-httponly-samesitestrict-secure)
10. [Hashing Endurecido de Contraseñas (`PBKDF2-HMAC-SHA512` + Salt 32B + Pepper)](#10-hashing-endurecido-de-contraseñas-pbkdf2-hmac-sha512--salt-32b--pepper)
11. [Limitación de Intentos de Inicio de Sesión (Anti-Brute Force Progresivo)](#11-limitación-de-intentos-de-inicio-de-sesión-anti-brute-force-progresivo)
12. [Protección Anti-Bots (Honeypot, Tiempo de Interacción y Turnstile)](#12-protección-anti-bots-honeypot-tiempo-de-interacción-y-turnstile)
13. [Monitorización de Consultas SQL y Bitácora de Auditoría](#13-monitorización-de-consultas-sql-y-bitácora-de-auditoría)
14. [Validación Estricta de Entradas y Esquemas](#14-validación-estricta-de-entradas-y-esquemas)
15. [Sanitización y Escape contra XSS (Backend y Frontend)](#15-sanitización-y-escape-contra-xss-backend-y-frontend)
16. [Restricción y Validación Binaria de Subida de Archivos](#16-restricción-y-validación-binaria-de-subida-de-archivos)
17. [Minimización de Datos, Paginación Acotada y Ocultamiento de Errores](#17-minimización-de-datos-paginación-acotada-y-ocultamiento-de-errores)
18. [Cabeceras HTTP de Seguridad Completas y CORS Estricto](#18-cabeceras-http-de-seguridad-completas-y-cors-estricto)
19. [Forzado de HTTPS y HSTS](#19-forzado-de-https-y-hsts)
20. [Escaneo de Dependencias y Suite Automatizada de Pruebas de Seguridad](#20-escaneo-de-dependencias-y-suite-automatizada-de-pruebas-de-seguridad)

---

## 1. Ocultamiento de Claves API y Credenciales
* **Vulnerabilidad Mitigada**: Exposición de cadenas de conexión PostgreSQL, contraseñas por defecto hardcodeadas en el código fuente y llaves criptográficas embebidas (CWE-798).
* **Archivos y Funciones**:
  * `SRC/Backend/config/env.js` (`loadDotEnv()`, `getEnvConfig()`, `deriveKey32()`)
  * `SRC/Backend/config/db.js` (`ensureAuthTables()`)
  * `SRC/Backend/.env.example`
* **Implementación**:
  Se centralizó toda la lectura de variables de entorno en `config/env.js`, eliminando contraseñas hardcodeadas de administrador en `config/db.js`. En modo producción (`NODE_ENV=production`), el servidor valida al arranque que `SUPABASE_DB_URL`, `DATA_ENCRYPTION_KEY` y `PASSWORD_PEPPER` estén definidos con valores reales, abortando el inicio si detecta valores de plantilla.

---

## 2. Eliminación y Prevención de Secretos en Git
* **Vulnerabilidad Mitigada**: Fuga de archivos `.env`, llaves privadas `.pem`/`.key` o artefactos de dependencias en el repositorio de control de versiones (CWE-540).
* **Archivos**:
  * `.gitignore`
* **Implementación**:
  Se reforzó `.gitignore` para bloquear `.env`, `.env.*` (permitiendo únicamente `!.env.example`), certificados (`*.pem`, `*.key`, `*.crt`, `*.p12`), directorios temporales de carga (`uploads/`) y `node_modules/`. Se limpió el índice de Git eliminando artefactos rastreados de `node_modules`.

---

## 3. Clave Pública de Base de Datos y Separación de Privilegios
* **Vulnerabilidad Mitigada**: Ejecución de consultas de la aplicación bajo el superusuario `postgres` (que evade RLS y permite operaciones administrativas destructivas) y exposición de credenciales de servidor en el cliente (CWE-250).
* **Archivos y Funciones**:
  * `SRC/Backend/database/schema.sql` (Rol `app_backend_user`)
  * `SRC/Backend/config/connection.js` (`checkLeastPrivilegeRole()`, `getConnection()`)
  * `SRC/Backend/config/env.js` (`getPublicClientConfig()`)
* **Implementación**:
  * `schema.sql` crea el rol `app_backend_user` con atributos `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` y permisos exclusivos `SELECT, INSERT, UPDATE, DELETE`.
  * `getPublicClientConfig()` expone en `/api/config/public` únicamente `SUPABASE_URL` y `SUPABASE_ANON_KEY`, manteniendo `SUPABASE_DB_URL` estrictamente en el backend.

---

## 4. Row Level Security (RLS) Estricto en Supabase PostgreSQL
* **Vulnerabilidad Mitigada**: Acceso no autorizado directo a las tablas mediante la API PostgREST de Supabase o fuga de datos entre empresas en consultas SQL (CWE-284).
* **Archivos**:
  * `SRC/Backend/database/schema.sql`
  * `SRC/Backend/config/connection.js` (`set_config('app.current_company_id', ...)`)
* **Implementación**:
  Se activó `ENABLE ROW LEVEL SECURITY` y `FORCE ROW LEVEL SECURITY` en las 14 tablas del esquema (`companies`, `users`, `registration_requests`, `auth_sessions`, `password_recovery_tokens`, `business_datasets`, `business_serial_sequences`, `employees`, `accounting_balances`, `payroll_concepts`, `sales_profit_lines`, `purchase_invoices`, `purchase_invoice_lines`, `security_audit_logs`), con políticas `CREATE POLICY` que exigen coincidencia con `current_setting('app.current_company_id', true)::INT` o contexto autenticado del servicio backend.

---

## 5. Cifrado de Datos Sensibles en Reposo (AES-256-GCM + Blind Index)
* **Vulnerabilidad Mitigada**: Exposición de identificaciones personales y fiscales (CURP, RFC, DNI, RTN, NSS/IHSS) ante un volcado o compromiso del almacenamiento de base de datos (CWE-311).
* **Archivos y Funciones**:
  * `SRC/Backend/config/crypto-fields.js` (`encryptField()`, `decryptField()`, `blindIndex()`)
  * `SRC/Backend/modules/employees.js` (`createEmployee()`, `updateEmployee()`, `publicEmployee()`)
* **Implementación**:
  Los campos `identity_number`, `tax_number` y `social_security_number` se cifran antes de persistirse usando **AES-256-GCM** con IV aleatorio de 12 bytes y etiqueta de autenticación (Auth Tag) de 16 bytes (`enc:v1:<iv>:<tag>:<ciphertext>`). Además, se calcula un índice ciego determinista mediante **HMAC-SHA256** (`bidx:<hmac>`) en la columna `identity_blind_index` para búsquedas exactas sin descifrar toda la tabla.

---

## 6. Autenticación Forzada en Servidor (Gateway Deny-by-Default)
* **Vulnerabilidad Mitigada**: Rutas privadas accesibles por omisión de verificación de sesión en controladores individuales (CWE-306).
* **Archivos y Funciones**:
  * `SRC/Backend/server.js` (`PUBLIC_API_ROUTES`, `handleApi()`, `requireSession()`)
  * `SRC/Backend/config/permissions.js` (`requireModuleAccess()`, `requireAdminRole()`, `requireGlobalAdminRole()`)
* **Implementación**:
  El despachador `handleApi()` en `server.js` intercepta todas las peticiones `/api/*` antes de llegar a los módulos y exige una sesión válida en base de datos salvo que el método y ruta estén explícitamente en la lista blanca `PUBLIC_API_ROUTES`.

---

## 7. Aislamiento Multi-tenant y Prevención de IDOR
* **Vulnerabilidad Mitigada**: *Insecure Direct Object Reference* (IDOR) al manipular `companyId` o `id` de recursos pertenecientes a otra empresa del grupo (CWE-639).
* **Archivos y Funciones**:
  * `SRC/Backend/config/permissions.js` (`resolveTenantCompanyId()`)
  * `SRC/Backend/modules/employees.js`, `SRC/Backend/modules/records.js`, `SRC/Backend/modules/accounting.js`
* **Implementación**:
  `resolveTenantCompanyId(user, requestedCompanyId)` obtiene siempre el `company_id` de la sesión del servidor (`user.companyId`). Si un usuario que no es Administrador Global envía un `companyId` distinto al propio, la operación se aborta con `403 Forbidden` y se registra un evento `IDOR_ATTEMPT_BLOCKED` en la bitácora de auditoría.

---

## 8. Protección contra Manipulación de Campos (Mass Assignment)
* **Vulnerabilidad Mitigada**: Escalación de privilegios inyectando propiedades no autorizadas como `is_global_admin: 1`, `role: "Administrador"`, `password_hash` o folios `SER-*` falsificados en cuerpos JSON (CWE-915).
* **Archivos y Funciones**:
  * `SRC/Backend/config/validator.js` (`FORBIDDEN_MASS_ASSIGNMENT_KEYS`, `assertAllowedFields()`)
  * `SRC/Backend/modules/records.js` (`assignSerialNumbers()`)
* **Implementación**:
  Todos los endpoints `POST`/`PUT`/`DELETE` validan el payload contra una lista blanca estricta de campos permitidos por operación y bloquean inmediatamente cualquier propiedad privilegiada o desconocida con `HTTP 400`.

---

## 9. Protección de Cookies de Sesión (`HttpOnly`, `SameSite=Strict`, `Secure`)
* **Vulnerabilidad Mitigada**: Robo de tokens de sesión mediante ataques Cross-Site Scripting (XSS) o envío involuntario en peticiones Cross-Site (CSRF) (CWE-1004, CWE-614).
* **Archivos y Funciones**:
  * `SRC/Backend/server.js` (`buildSessionCookie()`, `extractSessionToken()`)
  * `SRC/Frontend/assets/js/user-db.js` (`credentials: "same-origin"`)
* **Implementación**:
  Al iniciar sesión se emite la cookie `__Host-gestion_session` (en HTTPS) o `gestion_session` con las directivas `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200; Secure`. Al cerrar sesión o eliminar la cuenta, la cookie se invalida con `Max-Age=0`.

---

## 10. Hashing Endurecido de Contraseñas (`PBKDF2-HMAC-SHA512` + Salt 32B + Pepper)
* **Vulnerabilidad Mitigada**: Cracking offline de contraseñas mediante tablas rainbow o fuerza bruta acelerada por GPU (CWE-916).
* **Archivos y Funciones**:
  * `SRC/Backend/config/db.js` (`applyPepper()`, `hashPassword()`, `verifyPassword()`)
* **Implementación**:
  Las contraseñas se pre-procesan con un **HMAC-SHA256** utilizando el secreto de servidor `PASSWORD_PEPPER` (almacenado solo en `.env`), y posteriormente se derivan con **PBKDF2-HMAC-SHA512** usando **100,000 iteraciones** y una sal criptográficamente aleatoria de **32 bytes (256 bits)** por usuario. La comparación utiliza `crypto.timingSafeEqual` para prevenir ataques de canal lateral por tiempo.

---

## 11. Limitación de Intentos de Inicio de Sesión (Anti-Brute Force Progresivo)
* **Vulnerabilidad Mitigada**: Ataques de fuerza bruta y relleno de credenciales (*Credential Stuffing*) sobre cuentas de usuario (CWE-307).
* **Archivos y Funciones**:
  * `SRC/Backend/config/security.js` (`checkLoginLockout()`, `recordFailedLoginAttempt()`, `clearLoginAttempts()`)
  * `SRC/Backend/config/db.js` (`loginUser()`)
* **Implementación**:
  Rastrea intentos fallidos tanto por dirección IP como por identificador de cuenta (`username`/`email`). Al alcanzar `LOGIN_MAX_ATTEMPTS` (por defecto 5 intentos), bloquea la cuenta/IP durante `LOGIN_LOCKOUT_MINUTES` (15 minutos), duplicando el tiempo de bloqueo de forma exponencial ante reincidencias y devolviendo `HTTP 429` con cabecera `Retry-After`.

---

## 12. Protección Anti-Bots (Honeypot, Tiempo de Interacción y Turnstile)
* **Vulnerabilidad Mitigada**: Automatización de registros falsos, enumeración y abuso de formularios públicos por bots (CWE-799).
* **Archivos y Funciones**:
  * `SRC/Backend/config/security.js` (`verifyBotProtection()`, `verifyTurnstileToken()`)
  * `SRC/Frontend/login.html`, `SRC/Frontend/index.html`, `SRC/Frontend/recuperar.html`
  * `SRC/Frontend/assets/js/auth.js`, `SRC/Frontend/assets/js/register.js`
* **Implementación**:
  Combina tres capas en los formularios públicos:
  1. **Campo Honeypot invisible (`website_url`)**: Oculto para humanos (`aria-hidden="true"`, `tabindex="-1"`). Si un bot lo rellena, la petición se bloquea con `HTTP 403`.
  2. **Tiempo mínimo de llenado (`_form_ts`)**: Rechaza envíos realizados en menos de `800ms` desde la carga del DOM.
  3. **Cloudflare Turnstile**: Si se configura `TURNSTILE_SECRET_KEY`, verifica criptográficamente el token CAPTCHA contra Cloudflare.

---

## 13. Monitorización de Consultas SQL y Bitácora de Auditoría
* **Vulnerabilidad Mitigada**: Consultas colgadas que agotan el pool de conexiones y falta de trazabilidad forense ante incidentes de seguridad (CWE-778, CWE-400).
* **Archivos y Funciones**:
  * `SRC/Backend/config/connection.js` (`run()`, `statement_timeout`)
  * `SRC/Backend/config/audit.js` (`ensureAuditTable()`, `logSecurityEvent()`)
  * `SRC/Backend/database/schema.sql` (Tabla `security_audit_logs`)
* **Implementación**:
  * Cada consulta SQL se cronometra con `process.hrtime.bigint()`. Si supera `SLOW_QUERY_THRESHOLD_MS` (500ms), emite una alerta sanitizada sin exponer parámetros sensibles.
  * El pool configura `statement_timeout` (10s) para cancelar consultas anómalas.
  * Todos los eventos críticos (`AUTH_LOGIN_SUCCESS`, `AUTH_LOGIN_FAILED`, `USER_REGISTERED`, `REGISTRATION_APPROVED`, `EMPLOYEE_DELETED`, `IDOR_ATTEMPT_BLOCKED`) quedan registrados en `security_audit_logs`.

---

## 14. Validación Estricta de Entradas y Esquemas
* **Vulnerabilidad Mitigada**: Inyección de tipos inesperados, desbordamiento de buffers/memoria por payloads gigantes y parámetros fuera de rango (CWE-20).
* **Archivos y Funciones**:
  * `SRC/Backend/config/validator.js` (`validateModuleAndView()`, `validatePositiveAmount()`)
  * `SRC/Backend/server.js` (`parseJsonBody()`)
* **Implementación**:
  * `parseJsonBody()` exige `Content-Type: application/json` (`HTTP 415` en caso contrario) y corta el stream inmediatamente con `HTTP 413` si supera el límite de bytes permitido.
  * `validateModuleAndView()` valida contra el catálogo explícito `ALLOWED_MODULE_VIEWS`.

---

## 15. Sanitización y Escape contra XSS (Backend y Frontend)
* **Vulnerabilidad Mitigada**: Cross-Site Scripting (XSS) almacenado y reflejado mediante inyección de etiquetas `<script>`, `<iframe>` o atributos `onerror=` (CWE-79).
* **Archivos y Funciones**:
  * `SRC/Backend/config/validator.js` (`sanitizeText()`, `escapeHtml()`)
  * `SRC/Frontend/assets/js/auth.js`, `register.js`, `admin.js`, `empleados.js`, `module.js`, `accounting-reports.js`
* **Implementación**:
  En el backend, `sanitizeText()` elimina etiquetas ejecutables, manejadores de eventos inline (`on*=`) y esquemas `javascript:`/`data:text/html` antes de guardar en la base de datos. En el frontend, todo dato dinámico se inserta mediante `.textContent` o pasa por `escapeHtml()`.

---

## 16. Restricción y Validación Binaria de Subida de Archivos
* **Vulnerabilidad Mitigada**: Ejecución remota de código mediante subida de web shells o binarios camuflados con extensión falsa y *Path Traversal* (CWE-434, CWE-22).
* **Archivos y Funciones**:
  * `SRC/Backend/config/file-security.js` (`sanitizeOriginalFilename()`, `validateAndPrepareUpload()`)
  * `SRC/Backend/server.js` (`POST /api/uploads/validate`)
* **Implementación**:
  * Bloquea secuencias `../`, barras de ruta, bytes nulos y dobles extensiones peligrosas (`.php.jpg`, `.exe.pdf`).
  * Verifica los **Magic Bytes** reales del buffer binario (`%PDF-` para PDF, `\x89PNG` para PNG, `\xFF\xD8\xFF` para JPEG, ausencia de cabeceras `MZ`/`ELF`/`<?php` en CSV).
  * Renombra el archivo con un identificador aleatorio `crypto.randomUUID()`.

---

## 17. Minimización de Datos, Paginación Acotada y Ocultamiento de Errores
* **Vulnerabilidad Mitigada**: Exposición excesiva de columnas de base de datos, denegación de servicio por consultas sin límite y fuga de detalles de esquema en mensajes de error (CWE-209, CWE-770).
* **Archivos y Funciones**:
  * `SRC/Backend/config/validator.js` (`parsePagination()`)
  * `SRC/Backend/server.js` (`sanitizeClientErrorMessage()`)
  * `SRC/Backend/config/db.js`, `SRC/Backend/modules/employees.js`, `SRC/Backend/modules/accounting.js`, `SRC/Backend/modules/records.js`
* **Implementación**:
  Se reemplazaron todas las consultas `SELECT *` por proyecciones explícitas de columnas. Todas las listas aceptan `limit` y `offset` con tope máximo forzado en servidor (500 registros). `sanitizeClientErrorMessage()` intercepta errores de SQL o de estado `>= 500` y devuelve un mensaje genérico seguro.

---

## 18. Cabeceras HTTP de Seguridad Completas y CORS Estricto
* **Vulnerabilidad Mitigada**: Clickjacking, MIME sniffing, carga de scripts externos maliciosos y peticiones cross-origin no autorizadas (CWE-693, CWE-346).
* **Archivos y Funciones**:
  * `SRC/Backend/server.js` (`buildSecurityHeaders()`)
* **Implementación**:
  Todas las respuestas HTTP (API y archivos estáticos) incluyen:
  * `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; ...`
  * `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  * `X-Frame-Options: DENY`
  * `X-Content-Type-Options: nosniff`
  * `Referrer-Policy: strict-origin-when-cross-origin`
  * `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()`
  * `Cross-Origin-Opener-Policy: same-origin`
  * `Access-Control-Allow-Origin`: Asignado dinámicamente solo si el header `Origin` está en `ALLOWED_ORIGINS`.

---

## 19. Forzado de HTTPS y HSTS
* **Vulnerabilidad Mitigada**: Interceptación de tráfico en tránsito (*Man-in-the-Middle* / SSL Stripping) (CWE-319).
* **Archivos y Funciones**:
  * `SRC/Backend/server.js` (`isEncryptedRequest()`, `enforceHttps()`)
* **Implementación**:
  Al inicio de `handleRequest()`, cuando `FORCE_HTTPS=true` o `NODE_ENV=production`, el servidor verifica el socket TLS o la cabecera `x-forwarded-proto`. Las peticiones `GET`/`HEAD` por HTTP reciben redirección `301 Moved Permanently` hacia `https://`, y las peticiones de mutación (`POST`, `PUT`, `DELETE`) por HTTP son rechazadas con `403 Forbidden`.

---

## 20. Escaneo de Dependencias y Suite Automatizada de Pruebas de Seguridad
* **Vulnerabilidad Mitigada**: Dependencias con CVEs conocidos y regresiones en los controles de seguridad durante el ciclo de desarrollo (CWE-1395).
* **Archivos**:
  * `SRC/Backend/package.json`
  * `SRC/Backend/test/security.test.js`
  * `SRC/Backend/test/connection-errors.test.js`
* **Comandos de Verificación**:
  ```bash
  cd SRC/Backend
  npm run check          # Verificación sintáctica de todos los módulos
  npm test               # Ejecución de todas las suites de pruebas (incluyendo security.test.js)
  npm run test:security  # Ejecución exclusiva de la suite de 20 puntos de seguridad
  npm run security:audit # Auditoría de vulnerabilidades de dependencias (npm audit --audit-level=high)
  ```
