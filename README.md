# Gestión Empresarial

Sistema web multiempresa para Vicmar, Grupo Cirsa y Telas Olímpica. El backend Node.js sirve el frontend y guarda autenticación, empleados, operaciones y reportes en **Supabase PostgreSQL**.

> 🛡️ **Documentación de Seguridad**: Consulta [`SECURITY_ARCHITECTURE.md`](SECURITY_ARCHITECTURE.md) para revisar el detalle técnico de los **20 puntos de Hardening DevSecOps** implementados en el proyecto.

## Requisitos

- Node.js 18 o superior.
- Un proyecto de Supabase.
- La contraseña de la base de datos del proyecto (no la clave `anon`).

## Conectar Supabase paso a paso

### 1. Crear el proyecto

1. Inicia sesión en [Supabase](https://supabase.com/dashboard) y selecciona **New project**.
2. Elige la organización, nombre y región más cercana al servidor donde desplegarás la API.
3. Define una contraseña robusta para PostgreSQL y guárdala en un gestor de contraseñas.
4. Espera a que el proyecto termine de aprovisionarse.

> Esta aplicación conserva su autenticación propia (usuarios aprobados, sesiones y permisos). No requiere activar Supabase Auth.

### 2. Crear las tablas con SQL

1. En el panel del proyecto abre **SQL Editor** y pulsa **New query**.
2. Copia **todo** el contenido de [`SRC/Backend/database/schema.sql`](SRC/Backend/database/schema.sql).
3. Pulsa **Run**. El script es idempotente: usa `IF NOT EXISTS`, `ON CONFLICT`, habilita **Row Level Security (RLS)** en todas las tablas y configura el rol de privilegios mínimos `app_backend_user`.
4. Abre **Table Editor** y comprueba que existan, entre otras, `companies`, `users`, `auth_sessions`, `employees`, `business_datasets` y `security_audit_logs`.
5. En `companies` deben aparecer Vicmar, Telas Olímpica y Grupo Cirsa.

El script crea tablas, restricciones, índices, políticas RLS y las tres empresas iniciales. Las migraciones defensivas del backend también crean cualquier tabla faltante al arrancar.

### 3. Obtener la URI correcta

1. Ve a **Project Settings > Database** y localiza **Connection string**.
2. Selecciona formato **URI** y copia la cadena.
3. Sustituye el marcador de contraseña por la contraseña de PostgreSQL.

Para desarrollo local o un servidor con IPv6 se puede usar la conexión directa (puerto `5432`). Si la red solo soporta IPv4 o el despliegue es serverless, usa **Transaction pooler** (normalmente puerto `6543`). En el pooler el usuario suele incluir la referencia del proyecto, por ejemplo `postgres.PROJECT_REF`.

Si la contraseña contiene `@`, `:`, `/`, `#`, `%` u otros caracteres reservados, codifícala para URL. Por ejemplo, en Node:

```bash
node -p "encodeURIComponent('TU CONTRASEÑA')"
```

### 4. Configurar las variables

Desde la raíz del repositorio:

```bash
cp SRC/Backend/.env.example SRC/Backend/.env
```

Edita `SRC/Backend/.env` configurando `SUPABASE_DB_URL`, `DATA_ENCRYPTION_KEY` (32 bytes hex para AES-256-GCM) y `PASSWORD_PEPPER`:

```dotenv
SUPABASE_DB_URL=postgresql://app_backend_user.PROJECT_REF:CONTRASENA_CODIFICADA@aws-0-REGION.pooler.supabase.com:6543/postgres
DB_SSL=true
DB_POOL_MAX=10
DB_CONNECTION_TIMEOUT_MS=15000
DATA_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
PASSWORD_PEPPER=tu-secreto-pepper-de-servidor
PORT=3000
NODE_ENV=development
```

- `.env` está ignorado por Git. **Nunca** pongas la URI, la contraseña de PostgreSQL ni claves privadas en el frontend o en un commit.

Para crear el primer administrador define temporalmente:

```dotenv
BOOTSTRAP_ADMIN_EMAIL=admin@tu-dominio.com
BOOTSTRAP_ADMIN_USERNAME=administrador
BOOTSTRAP_ADMIN_PASSWORD=una-clave-segura-123
```

La contraseña debe tener de 12 a 72 caracteres, al menos una letra y un número. Arranca una vez, verifica la cuenta y retira las variables `BOOTSTRAP_ADMIN_*` del entorno.

### 5. Instalar, probar y arrancar

```bash
cd SRC/Backend
npm install
npm run check
npm test
npm start
```

Abre `http://localhost:3000`. No abras los HTML mediante `file://` ni desde otro servidor: el frontend consume `/api` en el mismo origen.

### 6. Verificar la conexión

Con el servidor activo ejecuta:

```bash
curl http://localhost:3000/api/companies
```

Debe responder JSON con las tres empresas. El endpoint `/api/health` solo comprueba el proceso; `/api/companies` también obliga a consultar PostgreSQL y por eso es la prueba real de conexión.

## Correo de recuperación

Se aceptan `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` y `SMTP_STARTTLS`. Sin SMTP, el enlace de recuperación se muestra en la consola local en modo desarrollo.

## Seguridad y arquitectura (Hardening 20 Puntos)

- **Documentación completa**: Ver [`SECURITY_ARCHITECTURE.md`](SECURITY_ARCHITECTURE.md).
- **Gateway Deny-by-Default**: Toda ruta `/api/*` privada exige sesión activa verificada en servidor y autorización RBAC.
- **Cifrado en Reposo**: Campos sensibles (`identity_number`, `tax_number`, `social_security_number`) cifrados con `AES-256-GCM` e índice ciego `HMAC-SHA256`.
- **Contraseñas y Sesiones**: Hashing `PBKDF2-HMAC-SHA512` (100,000 iteraciones, sal de 32 bytes y `PASSWORD_PEPPER`) y cookies `HttpOnly; SameSite=Strict; Secure`.
- **Anti-Brute Force y Anti-Bots**: Bloqueo progresivo por IP/cuenta, Honeypot invisible, validación de tiempo de llenado y soporte Cloudflare Turnstile.
- **RLS y Auditoría**: Row Level Security forzado en las 14 tablas de PostgreSQL y bitácora de auditoría en `security_audit_logs`.

## Estructura principal

```text
SRC/
|-- Backend/
|   |-- config/       Entorno, cifrado AES-256-GCM, validador, anti-bots, auditoría, DB y RBAC
|   |-- database/     Esquema PostgreSQL con RLS y separación de privilegios
|   |-- modules/      Empleados, registros operativos y reportes contables
|   |-- test/         Suites unitarias de conectividad y 20 puntos de seguridad
|   `-- server.js     Gateway HTTP, cabeceras de seguridad y servidor estático
`-- Frontend/
    |-- assets/       Estilos, iconos y controladores sanitizados contra XSS
    |-- modulo.html   Vistas operativas compartidas
    `-- reportes-contables.html
```
