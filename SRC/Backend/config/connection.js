const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { friendlyConnectionError, validateConnectionString } = require("./connection-errors");
const { getEnvConfig } = require("./env");

const env = getEnvConfig();
let connectionString = env.SUPABASE_DB_URL;

let pgPool;
let isLocalDb = false;

function sanitizeSqlForLog(sql) {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function checkLeastPrivilegeRole(uri) {
  try {
    const parsed = new URL(uri);
    const username = decodeURIComponent(parsed.username || "");
    const baseRole = username.split(".")[0];
    if (env.IS_PRODUCTION && baseRole === "postgres") {
      console.warn(
        `[SECURITY_WARNING] La conexion de produccion usa el rol superusuario '${baseRole}'. ` +
        `Se recomienda emplear el rol de privilegios minimos '${env.DB_APP_ROLE}'.`
      );
    }
  } catch {
    // Validado previamente por validateConnectionString
  }
}

if (!connectionString || connectionString === "local") {
  console.log("ℹ️ No se detectó SUPABASE_DB_URL. Iniciando base de datos local en memoria...");
  const { newDb } = require("pg-mem");
  const memDb = newDb();
  const schemaPath = path.resolve(__dirname, "..", "database", "schema.sql");
  if (fs.existsSync(schemaPath)) {
    let schemaSql = fs.readFileSync(schemaPath, "utf8");
    schemaSql = schemaSql
      .replace(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/gi, "CREATE INDEX")
      .replace(/BIGSERIAL/gi, "SERIAL")
      .replace(/(?<!\bNOT\s)\bNULL\b(?=\s*[,)])/gi, "")
      .replace(/decimal\(\d+,\s*\d+\)/gi, "numeric")
      .replace(/DO\s+\$\$[\s\S]*?\$\$\s*;/gi, "")
      .replace(/ALTER\s+TABLE\s+[\w.]+\s+(ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\s*;/gi, "")
      .replace(/DROP\s+POLICY\s+IF\s+EXISTS[\s\S]*?;/gi, "")
      .replace(/CREATE\s+POLICY[\s\S]*?;/gi, "")
      .replace(/REVOKE\s+[\s\S]*?;/gi, "")
      .replace(/GRANT\s+[\s\S]*?;/gi, "");
    try {
      memDb.public.none(schemaSql);
    } catch (e) {
      console.warn("Aviso schema en memoria:", e.message);
    }
  }
  const pgAdapter = memDb.adapters.createPg();
  pgPool = new pgAdapter.Pool();
  isLocalDb = true;
} else {
  connectionString = validateConnectionString(connectionString);
  checkLeastPrivilegeRole(connectionString);

  pgPool = new Pool({
    connectionString,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
    statement_timeout: env.STATEMENT_TIMEOUT_MS,
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : false,
  });
}

function postgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function run(client, sql, values = []) {
  let statement = postgresSql(sql);
  if (isLocalDb) {
    statement = statement
      .replace(/decimal\(\d+,\s*\d+\)/gi, "numeric")
      .replace(/\s+AFTER\s+\w+/gi, "")
      .replace(/FOR\s+UPDATE/gi, "");
  }
  const isInsert = /^\s*INSERT\s+INTO\b/i.test(statement);
  if (isInsert && !/\bRETURNING\b/i.test(statement)) statement += " RETURNING id";

  const startNs = process.hrtime.bigint();
  try {
    const result = await client.query(statement, values);
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    if (durationMs >= env.SLOW_QUERY_THRESHOLD_MS) {
      console.warn(`[SLOW_QUERY] ${durationMs.toFixed(1)}ms | ${sanitizeSqlForLog(statement)}`);
    }
    const metadata = {
      affectedRows: result.rowCount,
      insertId: result.rows[0]?.id,
    };
    return [isInsert ? metadata : result.rows, result.fields];
  } catch (error) {
    if (isLocalDb && /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i.test(statement) && String(error.message).includes("Not supported")) {
      return [[], []];
    }
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    if (durationMs >= env.SLOW_QUERY_THRESHOLD_MS) {
      console.warn(`[SLOW_QUERY_ERROR] ${durationMs.toFixed(1)}ms | ${sanitizeSqlForLog(statement)}`);
    }
    throw error;
  }
}

async function connect() {
  try {
    return await pgPool.connect();
  } catch (error) {
    throw friendlyConnectionError(error, connectionString);
  }
}

const pool = {
  query(sql, values) {
    return run(pgPool, sql, values).catch((error) => {
      throw friendlyConnectionError(error, connectionString);
    });
  },
  async getConnection(sessionContext = null) {
    const client = await connect();
    if (sessionContext && !isLocalDb) {
      const companyIdVal = sessionContext.companyId ? String(Number(sessionContext.companyId)) : "";
      const isGlobalVal = sessionContext.isGlobalAdmin ? "true" : "false";
      await client.query("SELECT set_config('app.current_company_id', $1, false), set_config('app.is_global_admin', $2, false), set_config('app.backend_service', 'true', false)", [companyIdVal, isGlobalVal]).catch(() => {});
    }
    return {
      query: (sql, values) => run(client, sql, values),
      beginTransaction: () => client.query("BEGIN"),
      commit: () => client.query("COMMIT"),
      rollback: () => client.query("ROLLBACK"),
      release: () => client.release(),
    };
  },
  end() {
    return pgPool.end();
  },
};

module.exports = pool;
