const pool = require("../config/connection");
const { listCompanies } = require("../config/db");
const { requireModuleAccess, resolveTenantCompanyId } = require("../config/permissions");
const { logSecurityEvent } = require("../config/audit");
const {
  assertAllowedFields,
  parsePagination,
  sanitizeText,
  validateModuleAndView,
} = require("../config/validator");

let recordsTablePromise = null;

async function assertActiveCompany(companyId) {
  const companies = await listCompanies();
  if (!companies.some((c) => Number(c.id) === Number(companyId))) {
    throw new Error("La empresa seleccionada no esta disponible.");
  }
}

async function ensureRecordsTable() {
  if (!recordsTablePromise) {
    recordsTablePromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS business_datasets (
        id BIGSERIAL PRIMARY KEY,
        company_id INT NOT NULL,
        module_key VARCHAR(40) NOT NULL,
        view_key VARCHAR(40) NOT NULL,
        rows_json TEXT NOT NULL,
        updated_by INT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_business_dataset UNIQUE (company_id, module_key, view_key)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS business_serial_sequences (
        company_id INT NOT NULL, module_key VARCHAR(40) NOT NULL, view_key VARCHAR(40) NOT NULL,
        next_value BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id, module_key, view_key)
      )`);
    })().catch((error) => {
      recordsTablePromise = null;
      throw error;
    });
  }
  return recordsTablePromise;
}

function serialPrefix(moduleKey, viewKey) {
  const part = (value) => value.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase().padEnd(3, "X");
  return `SER-${part(moduleKey)}-${part(viewKey)}-`;
}

async function assignSerialNumbers(connection, companyId, moduleKey, viewKey, rows) {
  const prefix = serialPrefix(moduleKey, viewKey);
  await connection.query(
    `INSERT INTO business_serial_sequences (company_id, module_key, view_key, next_value)
     VALUES (?, ?, ?, 1) ON CONFLICT (company_id, module_key, view_key) DO NOTHING RETURNING next_value`,
    [companyId, moduleKey, viewKey]
  );
  const [sequences] = await connection.query(
    `SELECT next_value FROM business_serial_sequences
     WHERE company_id = ? AND module_key = ? AND view_key = ? FOR UPDATE`,
    [companyId, moduleKey, viewKey]
  );
  let nextValue = Number(sequences[0].next_value);
  const used = new Set();
  const numberedRows = rows.map((row) => {
    const values = [...row];
    const candidate = String(values.at(-1) || "");
    if (new RegExp(`^${prefix}\\d{6,}$`).test(candidate) && !used.has(candidate)) {
      const value = Number(candidate.slice(prefix.length));
      // Punto 8: Bloquear inyeccion de folios SER-* falsos mayores al contador oficial del servidor
      if (Number.isSafeInteger(value) && value > 0 && value < nextValue + rows.length + 10) {
        used.add(candidate);
        nextValue = Math.max(nextValue, value + 1);
        return values;
      }
      values.pop();
    }
    const serial = `${prefix}${String(nextValue).padStart(6, "0")}`;
    nextValue += 1;
    used.add(serial);
    if (candidate === "Asignando...") values.pop();
    values.push(serial);
    return values;
  });
  await connection.query(
    `UPDATE business_serial_sequences SET next_value = ?, updated_at = CURRENT_TIMESTAMP
     WHERE company_id = ? AND module_key = ? AND view_key = ?`,
    [nextValue, companyId, moduleKey, viewKey]
  );
  return numberedRows;
}

const SHARED_CATALOG_VIEWS = new Set(["categorias", "unidades", "colores"]);

async function getDataset(user, query = {}) {
  await ensureRecordsTable();
  const { moduleKey, viewKey } = validateModuleAndView(query.module, query.view);
  requireModuleAccess(user, moduleKey, SHARED_CATALOG_VIEWS.has(viewKey) ? null : viewKey);
  const companyId = resolveTenantCompanyId(user, query.companyId);
  await assertActiveCompany(companyId);
  const { limit, offset } = parsePagination(query, 500, 1000);
  const [rows] = await pool.query(
    "SELECT rows_json, updated_at FROM business_datasets WHERE company_id = ? AND module_key = ? AND view_key = ? LIMIT 1",
    [companyId, moduleKey, viewKey]
  );
  if (!rows.length) return { initialized: false, rows: [], companyId };
  let data = [];
  try { data = JSON.parse(rows[0].rows_json); } catch (error) { data = []; }
  const allRows = Array.isArray(data) ? data : [];
  return {
    initialized: true,
    rows: allRows.slice(offset, offset + limit),
    totalRows: allRows.length,
    companyId,
    updatedAt: rows[0].updated_at,
  };
}

async function saveDataset(user, body = {}) {
  await ensureRecordsTable();
  assertAllowedFields(body, ["moduleKey", "viewKey", "rows", "companyId"], "guardado de registros");
  const { moduleKey, viewKey } = validateModuleAndView(body.moduleKey, body.viewKey);
  requireModuleAccess(user, moduleKey, SHARED_CATALOG_VIEWS.has(viewKey) ? null : viewKey);
  const companyId = resolveTenantCompanyId(user, body.companyId);
  await assertActiveCompany(companyId);
  if (!Array.isArray(body.rows) || body.rows.length > 500) {
    throw new Error("El conjunto de registros no es valido o excede el limite permitido (500 filas).");
  }
  const submittedRows = body.rows.map((row) => {
    if (!Array.isArray(row) || row.length > 30) throw new Error("Uno de los registros no tiene el formato esperado.");
    return row.map((value) => sanitizeText(value ?? "", 500));
  });
  const connection = await pool.getConnection(user);
  let rows;
  try {
    await connection.beginTransaction();
    rows = await assignSerialNumbers(connection, companyId, moduleKey, viewKey, submittedRows);
    await connection.query(
      `INSERT INTO business_datasets (company_id, module_key, view_key, rows_json, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (company_id, module_key, view_key) DO UPDATE
       SET rows_json = EXCLUDED.rows_json, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
      [companyId, moduleKey, viewKey, JSON.stringify(rows), user.id]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  await logSecurityEvent({
    companyId,
    userId: user.id,
    action: "DATASET_UPDATED",
    severity: "INFO",
    details: { moduleKey, viewKey, totalRows: rows.length, username: user.username },
  });
  return { saved: true, companyId, rows };
}

module.exports = { ensureRecordsTable, getDataset, saveDataset };
