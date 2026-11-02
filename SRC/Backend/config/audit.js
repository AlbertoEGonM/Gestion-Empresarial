const pool = require("./connection");
const { requireAdminRole, resolveTenantCompanyId } = require("./permissions");
const { parsePagination, sanitizeText } = require("./validator");

let auditTablePromise = null;

async function ensureAuditTable() {
  if (!auditTablePromise) {
    auditTablePromise = pool
      .query(`CREATE TABLE IF NOT EXISTS security_audit_logs (
        id SERIAL PRIMARY KEY,
        company_id INT,
        user_id INT,
        action VARCHAR(80) NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'INFO',
        ip_address VARCHAR(80),
        details_json TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
      .catch((error) => {
        auditTablePromise = null;
        throw error;
      });
  }
  return auditTablePromise;
}

async function logSecurityEvent({
  companyId = null,
  userId = null,
  action,
  severity = "INFO",
  ipAddress = "local",
  details = {},
}) {
  try {
    await ensureAuditTable();
    const safeAction = sanitizeText(action || "UNKNOWN_EVENT", 80);
    const safeSeverity = ["INFO", "WARN", "HIGH", "CRITICAL"].includes(String(severity).toUpperCase())
      ? String(severity).toUpperCase()
      : "INFO";
    const safeIp = sanitizeText(ipAddress || "local", 80);

    // Sanitizar detalles sin guardar contrasenas ni tokens en texto plano
    const redactedDetails = { ...(details || {}) };
    delete redactedDetails.password;
    delete redactedDetails.passwordHash;
    delete redactedDetails.password_hash;
    delete redactedDetails.token;

    await pool.query(
      `INSERT INTO security_audit_logs (company_id, user_id, action, severity, ip_address, details_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        companyId ? Number(companyId) : null,
        userId ? Number(userId) : null,
        safeAction,
        safeSeverity,
        safeIp,
        JSON.stringify(redactedDetails).slice(0, 2000),
      ]
    );
  } catch (error) {
    console.warn("[AUDIT_LOG_WARNING] No se pudo registrar evento de auditoria:", error.message);
  }
}

async function listAuditLogs(actor, query = {}) {
  requireAdminRole(actor);
  await ensureAuditTable();
  const companyId = resolveTenantCompanyId(actor, query.companyId);
  const { limit, offset } = parsePagination(query, 50, 200);

  const [rows] = await pool.query(
    `SELECT l.id, l.company_id, l.user_id, l.action, l.severity, l.ip_address, l.details_json, l.created_at,
            u.username, u.first_name, u.last_name, c.name AS company_name
     FROM security_audit_logs l
     LEFT JOIN users u ON u.id = l.user_id
     LEFT JOIN companies c ON c.id = l.company_id
     WHERE l.company_id = ? OR l.company_id IS NULL
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ? OFFSET ?`,
    [companyId, limit, offset]
  );

  return rows.map((row) => {
    let details = {};
    try {
      details = row.details_json ? JSON.parse(row.details_json) : {};
    } catch {
      details = {};
    }
    return {
      id: Number(row.id),
      companyId: row.company_id ? Number(row.company_id) : companyId,
      companyName: row.company_name || actor.company || "Empresa activa",
      userId: row.user_id ? Number(row.user_id) : null,
      username: row.username || details.username || "sistema",
      action: row.action,
      severity: row.severity || "INFO",
      ipAddress: row.ip_address || "local",
      details,
      createdAt: row.created_at,
    };
  });
}

module.exports = {
  ensureAuditTable,
  listAuditLogs,
  logSecurityEvent,
};
