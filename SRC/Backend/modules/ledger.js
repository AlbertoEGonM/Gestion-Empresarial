const pool = require("../config/connection");
const { requireModuleAccess, resolveTenantCompanyId } = require("../config/permissions");
const { logSecurityEvent } = require("../config/audit");
const { sanitizeText } = require("../config/validator");

const ACCOUNT_TYPES = Object.freeze({
  ASSET_CURRENT: { label: "Activo circulante", nature: "D" },
  ASSET_NONCURRENT: { label: "Activo no circulante", nature: "D" },
  LIABILITY_CURRENT: { label: "Pasivo a corto plazo", nature: "A" },
  LIABILITY_LONG: { label: "Pasivo a largo plazo", nature: "A" },
  EQUITY: { label: "Capital contable", nature: "A" },
  INCOME: { label: "Ingresos / Ventas", nature: "A" },
  COST: { label: "Costo de ventas", nature: "D" },
  EXPENSE: { label: "Gastos generales", nature: "D" },
  OTHER_INCOME: { label: "Otros ingresos / Productos financieros", nature: "A" },
  OTHER_EXPENSE: { label: "Otros gastos / Gastos financieros", nature: "D" },
});

const POLICY_TYPES = Object.freeze({
  CO: "Compra (Co)",
  DI: "Diario (Di)",
  EG: "Egreso (Eg)",
  IG: "Ingreso (Ig)",
  VT: "Venta (Vt)",
});

let ledgerTablesPromise = null;

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function num(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value) {
  return Math.round(num(value) * 100) / 100;
}

function accountNature(accountType) {
  return ACCOUNT_TYPES[accountType]?.nature || "D";
}

function computeClosingBalance(accountType, opening, debit, credit) {
  const nature = accountNature(accountType);
  if (nature === "A") {
    return round2(num(opening) - num(debit) + num(credit));
  }
  return round2(num(opening) + num(debit) - num(credit));
}

async function ensureLedgerTables() {
  if (!ledgerTablesPromise) {
    ledgerTablesPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS ledger_accounts (
        id BIGSERIAL PRIMARY KEY,
        company_id INT NOT NULL,
        code VARCHAR(30) NOT NULL,
        name VARCHAR(180) NOT NULL,
        grouping_code VARCHAR(30) NOT NULL DEFAULT '',
        account_type VARCHAR(30) NOT NULL DEFAULT 'ASSET_CURRENT',
        opening_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
        currency CHAR(3) NOT NULL DEFAULT 'HNL',
        active SMALLINT NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_ledger_account UNIQUE (company_id, code)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ledger_policies (
        id BIGSERIAL PRIMARY KEY,
        company_id INT NOT NULL,
        policy_type CHAR(2) NOT NULL,
        period CHAR(7) NOT NULL,
        number INT NOT NULL,
        policy_date DATE NOT NULL,
        concept VARCHAR(250) NOT NULL,
        currency CHAR(3) NOT NULL DEFAULT 'HNL',
        exchange_rate DECIMAL(18,4) NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'Registrada',
        created_by INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_ledger_policy UNIQUE (company_id, policy_type, period, number)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ledger_policy_lines (
        id BIGSERIAL PRIMARY KEY,
        policy_id BIGINT NOT NULL,
        line_no INT NOT NULL,
        account_code VARCHAR(30) NOT NULL,
        concept VARCHAR(220) NOT NULL DEFAULT '',
        debit DECIMAL(18,2) NOT NULL DEFAULT 0,
        credit DECIMAL(18,2) NOT NULL DEFAULT 0
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ledger_exchange_rates (
        id BIGSERIAL PRIMARY KEY,
        company_id INT NOT NULL,
        rate_date DATE NOT NULL,
        currency CHAR(3) NOT NULL DEFAULT 'USD',
        rate DECIMAL(18,4) NOT NULL DEFAULT 24.7500,
        notes VARCHAR(160) NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_ledger_exchange_rate UNIQUE (company_id, rate_date, currency)
      )`);
    })().catch((error) => {
      ledgerTablesPromise = null;
      throw error;
    });
  }
  return ledgerTablesPromise;
}

async function getCompanyInfo(companyId) {
  const [rows] = await pool.query(
    `SELECT id, code, name, legal_name, rtn, country_code, country_name, locale,
            currency_code, currency_symbol, tax_id_label, tax_id, tax_rate, city
     FROM companies WHERE id = ? AND active = 1 LIMIT 1`,
    [companyId]
  );
  if (!rows.length) throw httpError("La empresa solicitada no existe.", 404);
  return rows[0];
}

async function listAccountsWithBalances(companyId, { search = "", period = "" } = {}) {
  await ensureLedgerTables();
  const [accounts] = await pool.query(
    `SELECT id, company_id, code, name, grouping_code, account_type, opening_balance, currency, active
     FROM ledger_accounts WHERE company_id = ? AND active = 1 ORDER BY code ASC`,
    [companyId]
  );

  let movementSql = `
    SELECT l.account_code,
           p.period,
           p.currency,
           p.exchange_rate,
           l.debit,
           l.credit
    FROM ledger_policy_lines l
    INNER JOIN ledger_policies p ON p.id = l.policy_id
    WHERE p.company_id = ? AND p.status = 'Registrada'`;
  const params = [companyId];
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    movementSql += " AND p.period <= ?";
    params.push(period);
  }
  const [movements] = await pool.query(movementSql, params);

  const byAccount = new Map();
  for (const mov of movements) {
    const factor = mov.currency === "USD" ? num(mov.exchange_rate || 1) : 1;
    const debit = round2(num(mov.debit) * factor);
    const credit = round2(num(mov.credit) * factor);
    const current = byAccount.get(mov.account_code) || { priorDebit: 0, priorCredit: 0, periodDebit: 0, periodCredit: 0 };
    if (period && mov.period < period) {
      current.priorDebit = round2(current.priorDebit + debit);
      current.priorCredit = round2(current.priorCredit + credit);
    } else {
      current.periodDebit = round2(current.periodDebit + debit);
      current.periodCredit = round2(current.periodCredit + credit);
    }
    byAccount.set(mov.account_code, current);
  }

  const term = String(search || "").trim().toLowerCase();
  return accounts
    .filter((acc) => {
      if (!term) return true;
      return (
        acc.code.toLowerCase().includes(term) ||
        acc.name.toLowerCase().includes(term) ||
        String(acc.grouping_code || "").toLowerCase().includes(term)
      );
    })
    .map((acc) => {
      const mov = byAccount.get(acc.code) || { priorDebit: 0, priorCredit: 0, periodDebit: 0, periodCredit: 0 };
      const openingForPeriod = period
        ? computeClosingBalance(acc.account_type, acc.opening_balance, mov.priorDebit, mov.priorCredit)
        : round2(acc.opening_balance);
      const closing = computeClosingBalance(acc.account_type, openingForPeriod, mov.periodDebit, mov.periodCredit);
      return {
        id: Number(acc.id),
        companyId: Number(acc.company_id),
        code: acc.code,
        name: acc.name,
        groupingCode: acc.grouping_code || "",
        accountType: acc.account_type,
        accountTypeLabel: ACCOUNT_TYPES[acc.account_type]?.label || acc.account_type,
        nature: accountNature(acc.account_type),
        currency: acc.currency || "HNL",
        openingBalance: round2(acc.opening_balance),
        periodOpening: openingForPeriod,
        debit: mov.periodDebit,
        credit: mov.periodCredit,
        closingBalance: closing,
      };
    });
}

function validateAccountPayload(body = {}) {
  const code = sanitizeText(body.code || "", 30).replace(/\s+/g, "");
  const name = sanitizeText(body.name || "", 180);
  const groupingCode = sanitizeText(body.groupingCode ?? body.grouping_code ?? "", 30);
  const accountType = String(body.accountType || body.account_type || "ASSET_CURRENT").trim().toUpperCase();
  const currency = String(body.currency || "HNL").trim().toUpperCase() === "USD" ? "USD" : "HNL";
  const openingBalance = round2(body.openingBalance ?? body.opening_balance ?? 0);

  if (!/^[A-Za-z0-9._-]{1,30}$/.test(code)) {
    throw httpError("El numero de cuenta es obligatorio y solo permite letras, numeros, guiones o puntos.");
  }
  if (name.length < 2) {
    throw httpError("La descripcion de la cuenta debe tener al menos 2 caracteres.");
  }
  if (!ACCOUNT_TYPES[accountType]) {
    throw httpError("El tipo de cuenta contable no es valido.");
  }
  return { code, name, groupingCode, accountType, currency, openingBalance };
}

async function createAccount(user, companyId, body) {
  await ensureLedgerTables();
  const data = validateAccountPayload(body);
  const [existing] = await pool.query(
    "SELECT id, active FROM ledger_accounts WHERE company_id = ? AND code = ? LIMIT 1",
    [companyId, data.code]
  );
  if (existing.length && Number(existing[0].active) === 1) {
    throw httpError(`Ya existe la cuenta ${data.code} en el catalogo de esta empresa.`, 409);
  }
  if (existing.length) {
    await pool.query(
      `UPDATE ledger_accounts
       SET name = ?, grouping_code = ?, account_type = ?, opening_balance = ?, currency = ?, active = 1
       WHERE id = ?`,
      [data.name, data.groupingCode, data.accountType, data.openingBalance, data.currency, existing[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO ledger_accounts (company_id, code, name, grouping_code, account_type, opening_balance, currency, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [companyId, data.code, data.name, data.groupingCode, data.accountType, data.openingBalance, data.currency]
    );
  }
  await logSecurityEvent({
    companyId,
    userId: user.id,
    action: "LEDGER_ACCOUNT_CREATED",
    severity: "INFO",
    details: { code: data.code, name: data.name },
  });
  const accounts = await listAccountsWithBalances(companyId);
  return accounts.find((acc) => acc.code === data.code);
}

async function updateAccount(user, companyId, id, body) {
  await ensureLedgerTables();
  const [rows] = await pool.query(
    "SELECT id, code FROM ledger_accounts WHERE id = ? AND company_id = ? AND active = 1 LIMIT 1",
    [Number(id), companyId]
  );
  if (!rows.length) throw httpError("La cuenta contable solicitada no existe.", 404);
  const previousCode = rows[0].code;
  const data = validateAccountPayload({ ...body, code: body.code ?? previousCode });

  if (data.code !== previousCode) {
    const [dup] = await pool.query(
      "SELECT id FROM ledger_accounts WHERE company_id = ? AND code = ? AND id <> ? LIMIT 1",
      [companyId, data.code, Number(id)]
    );
    if (dup.length) throw httpError(`Ya existe otra cuenta con el numero ${data.code}.`, 409);
  }

  const connection = await pool.getConnection(user);
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE ledger_accounts
       SET code = ?, name = ?, grouping_code = ?, account_type = ?, opening_balance = ?, currency = ?
       WHERE id = ? AND company_id = ?`,
      [data.code, data.name, data.groupingCode, data.accountType, data.openingBalance, data.currency, Number(id), companyId]
    );
    if (data.code !== previousCode) {
      await connection.query(
        `UPDATE ledger_policy_lines SET account_code = ?
         WHERE account_code = ? AND policy_id IN (SELECT id FROM ledger_policies WHERE company_id = ?)`,
        [data.code, previousCode, companyId]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const accounts = await listAccountsWithBalances(companyId);
  return accounts.find((acc) => Number(acc.id) === Number(id));
}

async function deleteAccount(user, companyId, id) {
  await ensureLedgerTables();
  const [rows] = await pool.query(
    "SELECT id, code, name FROM ledger_accounts WHERE id = ? AND company_id = ? AND active = 1 LIMIT 1",
    [Number(id), companyId]
  );
  if (!rows.length) throw httpError("La cuenta contable no existe.", 404);
  const account = rows[0];
  const [used] = await pool.query(
    `SELECT l.id FROM ledger_policy_lines l
     INNER JOIN ledger_policies p ON p.id = l.policy_id
     WHERE p.company_id = ? AND l.account_code = ? AND p.status = 'Registrada' LIMIT 1`,
    [companyId, account.code]
  );
  if (used.length) {
    throw httpError("No se puede eliminar una cuenta que ya tiene polizas registradas.", 409);
  }
  await pool.query("DELETE FROM ledger_accounts WHERE id = ? AND company_id = ?", [Number(id), companyId]);
  await logSecurityEvent({
    companyId,
    userId: user.id,
    action: "LEDGER_ACCOUNT_DELETED",
    severity: "INFO",
    details: { code: account.code, name: account.name },
  });
  return { deleted: true, id: Number(id) };
}

function validatePolicyPayload(body = {}) {
  const policyType = String(body.policyType || body.policy_type || "DI").trim().toUpperCase();
  if (!POLICY_TYPES[policyType]) {
    throw httpError("El tipo de poliza no es valido. Usa Co, Di, Eg, Ig o Vt.");
  }
  const policyDate = String(body.policyDate || body.policy_date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(policyDate)) {
    throw httpError("La fecha de la poliza es obligatoria (YYYY-MM-DD).");
  }
  const period = policyDate.slice(0, 7);
  const concept = sanitizeText(body.concept || "", 250);
  if (concept.length < 2) {
    throw httpError("El concepto general de la poliza es obligatorio.");
  }
  const currency = String(body.currency || "HNL").trim().toUpperCase() === "USD" ? "USD" : "HNL";
  const exchangeRate = currency === "USD" ? Math.max(num(body.exchangeRate ?? body.exchange_rate ?? 1), 0.0001) : 1;
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length < 2) {
    throw httpError("La poliza debe incluir al menos 2 partidas para cumplir partida doble.");
  }

  const lines = rawLines.map((line, index) => {
    const accountCode = sanitizeText(line.accountCode || line.account_code || "", 30).replace(/\s+/g, "");
    const lineConcept = sanitizeText(line.concept || concept, 220);
    const debit = round2(line.debit);
    const credit = round2(line.credit);
    if (!accountCode) throw httpError(`La partida #${index + 1} no tiene cuenta contable.`);
    if (debit < 0 || credit < 0) throw httpError(`La partida #${index + 1} no permite importes negativos.`);
    if ((debit === 0 && credit === 0) || (debit > 0 && credit > 0)) {
      throw httpError(`La partida #${index + 1} debe tener unicamente Cargo o Abono mayor a cero.`);
    }
    return { lineNo: index + 1, accountCode, concept: lineConcept, debit, credit };
  });

  const totalDebit = round2(lines.reduce((sum, l) => sum + l.debit, 0));
  const totalCredit = round2(lines.reduce((sum, l) => sum + l.credit, 0));
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    throw httpError(
      `La poliza esta descuadrada: Cargos (${totalDebit.toFixed(2)}) != Abonos (${totalCredit.toFixed(2)}).`
    );
  }
  return { policyType, policyDate, period, concept, currency, exchangeRate, lines, totalDebit, totalCredit };
}

async function assertAccountsExist(companyId, lines) {
  const [accounts] = await pool.query(
    "SELECT code, name FROM ledger_accounts WHERE company_id = ? AND active = 1",
    [companyId]
  );
  const map = new Map(accounts.map((acc) => [acc.code, acc.name]));
  for (const line of lines) {
    if (!map.has(line.accountCode)) {
      throw httpError(`La cuenta contable "${line.accountCode}" no existe en el catalogo de la empresa.`);
    }
  }
  return map;
}

async function listPolicies(companyId, query = {}) {
  await ensureLedgerTables();
  let sql = `SELECT id, company_id, policy_type, period, number, policy_date, concept, currency, exchange_rate, status, created_at
             FROM ledger_policies WHERE company_id = ?`;
  const params = [companyId];
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(query.period || "")) {
    sql += " AND period = ?";
    params.push(query.period);
  }
  if (query.type && POLICY_TYPES[String(query.type).toUpperCase()]) {
    sql += " AND policy_type = ?";
    params.push(String(query.type).toUpperCase());
  }
  sql += " ORDER BY policy_date DESC, id DESC LIMIT 300";
  const [policies] = await pool.query(sql, params);
  if (!policies.length) return [];

  const [accounts] = await pool.query(
    "SELECT code, name FROM ledger_accounts WHERE company_id = ?",
    [companyId]
  );
  const accountNames = new Map(accounts.map((acc) => [acc.code, acc.name]));

  const [allLines] = await pool.query(
    `SELECT l.id, l.policy_id, l.line_no, l.account_code, l.concept, l.debit, l.credit
     FROM ledger_policy_lines l
     INNER JOIN ledger_policies p ON p.id = l.policy_id
     WHERE p.company_id = ?
     ORDER BY l.policy_id ASC, l.line_no ASC`,
    [companyId]
  );
  const linesByPolicy = new Map();
  for (const line of allLines) {
    const pid = Number(line.policy_id);
    if (!linesByPolicy.has(pid)) linesByPolicy.set(pid, []);
    linesByPolicy.get(pid).push({
      lineNo: Number(line.line_no),
      accountCode: line.account_code,
      accountName: accountNames.get(line.account_code) || "",
      concept: line.concept,
      debit: round2(line.debit),
      credit: round2(line.credit),
    });
  }

  return policies.map((p) => {
    const lines = linesByPolicy.get(Number(p.id)) || [];
    const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
    const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
    return {
      id: Number(p.id),
      companyId: Number(p.company_id),
      policyType: p.policy_type,
      policyTypeLabel: POLICY_TYPES[p.policy_type] || p.policy_type,
      period: p.period,
      number: Number(p.number),
      folio: `${p.policy_type}-${String(p.number).padStart(4, "0")}`,
      policyDate: typeof p.policy_date === "string" ? p.policy_date.slice(0, 10) : new Date(p.policy_date).toISOString().slice(0, 10),
      concept: p.concept,
      currency: p.currency,
      exchangeRate: num(p.exchange_rate),
      status: p.status,
      totalDebit,
      totalCredit,
      lines,
    };
  });
}

async function createPolicy(user, companyId, body) {
  await ensureLedgerTables();
  const data = validatePolicyPayload(body);
  await assertAccountsExist(companyId, data.lines);

  const connection = await pool.getConnection(user);
  let policyId = null;
  try {
    await connection.beginTransaction();
    const [maxRows] = await connection.query(
      `SELECT COALESCE(MAX(number), 0) AS max_number
       FROM ledger_policies
       WHERE company_id = ? AND policy_type = ? AND period = ?`,
      [companyId, data.policyType, data.period]
    );
    const nextNumber = Number(maxRows[0]?.max_number || 0) + 1;
    const [inserted] = await connection.query(
      `INSERT INTO ledger_policies (company_id, policy_type, period, number, policy_date, concept, currency, exchange_rate, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Registrada', ?)
       RETURNING id`,
      [companyId, data.policyType, data.period, nextNumber, data.policyDate, data.concept, data.currency, data.exchangeRate, user.id]
    );
    policyId = Number(inserted.insertId ?? inserted[0]?.id);
    for (const line of data.lines) {
      await connection.query(
        `INSERT INTO ledger_policy_lines (policy_id, line_no, account_code, concept, debit, credit)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [policyId, line.lineNo, line.accountCode, line.concept, line.debit, line.credit]
      );
    }
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
    action: "LEDGER_POLICY_CREATED",
    severity: "INFO",
    details: { policyId, policyType: data.policyType, period: data.period, totalDebit: data.totalDebit },
  });
  const list = await listPolicies(companyId, { period: data.period });
  return list.find((item) => item.id === policyId);
}

async function updatePolicy(user, companyId, id, body) {
  await ensureLedgerTables();
  const [rows] = await pool.query(
    "SELECT id, period FROM ledger_policies WHERE id = ? AND company_id = ? LIMIT 1",
    [Number(id), companyId]
  );
  if (!rows.length) throw httpError("La poliza solicitada no existe.", 404);
  const data = validatePolicyPayload(body);
  await assertAccountsExist(companyId, data.lines);

  const connection = await pool.getConnection(user);
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE ledger_policies
       SET policy_type = ?, period = ?, policy_date = ?, concept = ?, currency = ?, exchange_rate = ?, status = 'Registrada'
       WHERE id = ? AND company_id = ?`,
      [data.policyType, data.period, data.policyDate, data.concept, data.currency, data.exchangeRate, Number(id), companyId]
    );
    await connection.query("DELETE FROM ledger_policy_lines WHERE policy_id = ?", [Number(id)]);
    for (const line of data.lines) {
      await connection.query(
        `INSERT INTO ledger_policy_lines (policy_id, line_no, account_code, concept, debit, credit)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [Number(id), line.lineNo, line.accountCode, line.concept, line.debit, line.credit]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const list = await listPolicies(companyId, { period: data.period });
  return list.find((item) => item.id === Number(id));
}

async function cancelOrDeletePolicy(user, companyId, id, hardDelete = false) {
  await ensureLedgerTables();
  const [rows] = await pool.query(
    "SELECT id, policy_type, number, period FROM ledger_policies WHERE id = ? AND company_id = ? LIMIT 1",
    [Number(id), companyId]
  );
  if (!rows.length) throw httpError("La poliza no existe.", 404);
  if (hardDelete) {
    await pool.query("DELETE FROM ledger_policy_lines WHERE policy_id = ?", [Number(id)]);
    await pool.query("DELETE FROM ledger_policies WHERE id = ? AND company_id = ?", [Number(id), companyId]);
  } else {
    await pool.query("UPDATE ledger_policies SET status = 'Cancelada' WHERE id = ? AND company_id = ?", [Number(id), companyId]);
  }
  await logSecurityEvent({
    companyId,
    userId: user.id,
    action: hardDelete ? "LEDGER_POLICY_DELETED" : "LEDGER_POLICY_CANCELLED",
    severity: "INFO",
    details: { id: Number(id) },
  });
  return { cancelled: true, id: Number(id) };
}

async function getAuxiliaryReport(companyId, query = {}) {
  await ensureLedgerTables();
  const year = /^\d{4}$/.test(String(query.year || "")) ? String(query.year) : String(new Date().getFullYear());
  const month = /^(0?[1-9]|1[0-2])$/.test(String(query.month || ""))
    ? String(query.month).padStart(2, "0")
    : String(new Date().getMonth() + 1).padStart(2, "0");
  const period = `${year}-${month}`;
  const fromCode = String(query.from || "").trim();
  const toCode = String(query.to || "").trim();

  const accounts = await listAccountsWithBalances(companyId, { period });
  const filteredAccounts = accounts.filter((acc) => {
    if (fromCode && acc.code.localeCompare(fromCode) < 0) return false;
    if (toCode && acc.code.localeCompare(toCode) > 0) return false;
    return true;
  });

  const [lines] = await pool.query(
    `SELECT l.account_code, l.concept AS line_concept, l.debit, l.credit,
            p.id AS policy_id, p.policy_type, p.number, p.policy_date, p.concept AS policy_concept,
            p.currency, p.exchange_rate
     FROM ledger_policy_lines l
     INNER JOIN ledger_policies p ON p.id = l.policy_id
     WHERE p.company_id = ? AND p.period = ? AND p.status = 'Registrada'
     ORDER BY p.policy_date ASC, p.id ASC, l.line_no ASC`,
    [companyId, period]
  );

  const grouped = new Map();
  for (const row of lines) {
    if (!grouped.has(row.account_code)) grouped.set(row.account_code, []);
    const factor = row.currency === "USD" ? num(row.exchange_rate || 1) : 1;
    grouped.get(row.account_code).push({
      policyId: Number(row.policy_id),
      folio: `${row.policy_type}-${String(row.number).padStart(4, "0")}`,
      policyType: row.policy_type,
      date: typeof row.policy_date === "string" ? row.policy_date.slice(0, 10) : new Date(row.policy_date).toISOString().slice(0, 10),
      concept: row.line_concept || row.policy_concept,
      debit: round2(num(row.debit) * factor),
      credit: round2(num(row.credit) * factor),
    });
  }

  const accountAuxiliaries = filteredAccounts.map((acc) => {
    const movs = grouped.get(acc.code) || [];
    let running = acc.periodOpening;
    const detailedMovements = movs.map((m) => {
      running = computeClosingBalance(acc.accountType, running, m.debit, m.credit);
      return { ...m, balance: running };
    });
    return {
      code: acc.code,
      name: acc.name,
      groupingCode: acc.groupingCode,
      accountType: acc.accountType,
      nature: acc.nature,
      openingBalance: acc.periodOpening,
      debit: acc.debit,
      credit: acc.credit,
      closingBalance: acc.closingBalance,
      movements: detailedMovements,
    };
  });

  return {
    period,
    year,
    month,
    from: fromCode,
    to: toCode,
    accounts: accountAuxiliaries,
  };
}

async function getTrialBalance(companyId, query = {}) {
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.period || "") ? query.period : "2026-01";
  const customTitle = sanitizeText(query.title || "", 180);
  const company = await getCompanyInfo(companyId);
  const accounts = await listAccountsWithBalances(companyId, { period });
  const rows = accounts.map((acc) => ({
    code: acc.code,
    name: acc.name,
    groupingCode: acc.groupingCode,
    opening: acc.periodOpening,
    debit: acc.debit,
    credit: acc.credit,
    closing: acc.closingBalance,
  }));
  const totals = rows.reduce(
    (tot, row) => ({
      opening: round2(tot.opening + row.opening),
      debit: round2(tot.debit + row.debit),
      credit: round2(tot.credit + row.credit),
      closing: round2(tot.closing + row.closing),
    }),
    { opening: 0, debit: 0, credit: 0, closing: 0 }
  );
  return {
    title: customTitle || `Balanza de Comprobacion - Periodo ${period}`,
    period,
    company,
    rows,
    totals,
  };
}

async function listExchangeRates(companyId) {
  await ensureLedgerTables();
  const [rows] = await pool.query(
    `SELECT id, company_id, rate_date, currency, rate, notes, created_at
     FROM ledger_exchange_rates WHERE company_id = ? ORDER BY rate_date DESC, id DESC LIMIT 120`,
    [companyId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    rateDate: typeof r.rate_date === "string" ? r.rate_date.slice(0, 10) : new Date(r.rate_date).toISOString().slice(0, 10),
    currency: r.currency,
    rate: num(r.rate),
    notes: r.notes || "",
  }));
}

async function saveExchangeRate(user, companyId, body = {}) {
  await ensureLedgerTables();
  const rateDate = String(body.rateDate || body.rate_date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) {
    throw httpError("La fecha del tipo de cambio es obligatoria (YYYY-MM-DD).");
  }
  const rate = num(body.rate);
  if (rate <= 0 || rate > 10000) {
    throw httpError("El tipo de cambio (Lempiras por 1 USD) debe ser mayor a cero.");
  }
  const notes = sanitizeText(body.notes || "", 160);
  await pool.query(
    `INSERT INTO ledger_exchange_rates (company_id, rate_date, currency, rate, notes)
     VALUES (?, ?, 'USD', ?, ?)
     ON CONFLICT (company_id, rate_date, currency) DO UPDATE
     SET rate = EXCLUDED.rate, notes = EXCLUDED.notes`,
    [companyId, rateDate, rate, notes]
  );
  const rates = await listExchangeRates(companyId);
  return rates.find((item) => item.rateDate === rateDate) || rates[0];
}

async function deleteExchangeRate(companyId, id) {
  await ensureLedgerTables();
  await pool.query("DELETE FROM ledger_exchange_rates WHERE id = ? AND company_id = ?", [Number(id), companyId]);
  return { deleted: true, id: Number(id) };
}

async function resolveRateForPeriod(companyId, period) {
  const rates = await listExchangeRates(companyId);
  const endOfPeriod = `${period}-31`;
  const match = rates.find((r) => r.rateDate <= endOfPeriod) || rates[0];
  return match ? match.rate : 24.75;
}

async function getFinancialStatements(companyId, query = {}) {
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.period || "") ? query.period : "2026-01";
  const currency = String(query.currency || "HNL").toUpperCase() === "USD" ? "USD" : "HNL";
  const company = await getCompanyInfo(companyId);
  const accounts = await listAccountsWithBalances(companyId, { period });
  const rate = await resolveRateForPeriod(companyId, period);
  const divisor = currency === "USD" ? (rate > 0 ? rate : 24.75) : 1;
  const convert = (val) => round2(num(val) / divisor);

  const byType = (type) =>
    accounts
      .filter((acc) => acc.accountType === type)
      .map((acc) => ({
        code: acc.code,
        name: acc.name,
        amount: convert(acc.closingBalance),
      }));

  const sumType = (type) => round2(byType(type).reduce((s, r) => s + r.amount, 0));

  const income = sumType("INCOME");
  const cost = sumType("COST");
  const expenses = sumType("EXPENSE");
  const otherIncome = sumType("OTHER_INCOME");
  const otherExpense = sumType("OTHER_EXPENSE");
  const grossProfit = round2(income - cost);
  const operatingProfit = round2(grossProfit - expenses);
  const netProfit = round2(operatingProfit + otherIncome - otherExpense);

  const currentAssets = sumType("ASSET_CURRENT");
  const nonCurrentAssets = sumType("ASSET_NONCURRENT");
  const currentLiabilities = sumType("LIABILITY_CURRENT");
  const longLiabilities = sumType("LIABILITY_LONG");
  const equityBase = sumType("EQUITY");
  const equity = round2(equityBase + netProfit);

  return {
    period,
    currency,
    currencySymbol: currency === "USD" ? "$" : "L",
    exchangeRate: rate,
    company,
    incomeStatement: {
      income,
      cost,
      grossProfit,
      expenses,
      operatingProfit,
      otherIncome,
      otherExpense,
      taxes: 0,
      netProfit,
      details: {
        income: byType("INCOME"),
        cost: byType("COST"),
        expenses: byType("EXPENSE"),
        otherIncome: byType("OTHER_INCOME"),
        otherExpense: byType("OTHER_EXPENSE"),
      },
    },
    balanceSheet: {
      sections: {
        currentAssets: byType("ASSET_CURRENT"),
        nonCurrentAssets: byType("ASSET_NONCURRENT"),
        currentLiabilities: byType("LIABILITY_CURRENT"),
        longLiabilities: byType("LIABILITY_LONG"),
        equity: [
          ...byType("EQUITY"),
          ...(netProfit !== 0 ? [{ code: "RES-EJ", name: "Resultado del ejercicio", amount: netProfit }] : []),
        ],
      },
      totals: {
        currentAssets,
        nonCurrentAssets,
        assets: round2(currentAssets + nonCurrentAssets),
        currentLiabilities,
        longLiabilities,
        equity,
        liabilitiesAndEquity: round2(currentLiabilities + longLiabilities + equity),
      },
    },
  };
}

async function handleLedgerRoute({ route, method, user, query, readBody }) {
  const companyId = resolveTenantCompanyId(user, query.companyId);

  if (route === "/api/ledger/accounts" && method === "GET") {
    requireModuleAccess(user, "contabilidad", "cuentas");
    const accounts = await listAccountsWithBalances(companyId, { search: query.q || "", period: query.period || "" });
    return { status: 200, body: { accounts, accountTypes: ACCOUNT_TYPES } };
  }
  if (route === "/api/ledger/accounts" && method === "POST") {
    requireModuleAccess(user, "contabilidad", "cuentas");
    const body = await readBody();
    const targetCompanyId = resolveTenantCompanyId(user, body.companyId ?? query.companyId);
    const account = await createAccount(user, targetCompanyId, body);
    return { status: 201, body: { account, message: "Cuenta contable registrada correctamente." } };
  }
  const accountMatch = route.match(/^\/api\/ledger\/accounts\/(\d+)$/);
  if (accountMatch && method === "PUT") {
    requireModuleAccess(user, "contabilidad", "cuentas");
    const body = await readBody();
    const targetCompanyId = resolveTenantCompanyId(user, body.companyId ?? query.companyId);
    const account = await updateAccount(user, targetCompanyId, accountMatch[1], body);
    return { status: 200, body: { account, message: "Cuenta contable actualizada." } };
  }
  if (accountMatch && method === "DELETE") {
    requireModuleAccess(user, "contabilidad", "cuentas");
    const result = await deleteAccount(user, companyId, accountMatch[1]);
    return { status: 200, body: { ...result, message: "Cuenta eliminada del catalogo." } };
  }

  if (route === "/api/ledger/policies" && method === "GET") {
    requireModuleAccess(user, "contabilidad", "polizas");
    const policies = await listPolicies(companyId, query);
    return { status: 200, body: { policies, policyTypes: POLICY_TYPES } };
  }
  if (route === "/api/ledger/policies" && method === "POST") {
    requireModuleAccess(user, "contabilidad", "polizas");
    const body = await readBody();
    const targetCompanyId = resolveTenantCompanyId(user, body.companyId ?? query.companyId);
    const policy = await createPolicy(user, targetCompanyId, body);
    return { status: 201, body: { policy, message: "Poliza registrada correctamente." } };
  }
  const policyMatch = route.match(/^\/api\/ledger\/policies\/(\d+)$/);
  if (policyMatch && method === "PUT") {
    requireModuleAccess(user, "contabilidad", "polizas");
    const body = await readBody();
    const targetCompanyId = resolveTenantCompanyId(user, body.companyId ?? query.companyId);
    const policy = await updatePolicy(user, targetCompanyId, policyMatch[1], body);
    return { status: 200, body: { policy, message: "Poliza actualizada." } };
  }
  if (policyMatch && method === "DELETE") {
    requireModuleAccess(user, "contabilidad", "polizas");
    const hard = query.hard === "1" || query.hard === "true";
    const result = await cancelOrDeletePolicy(user, companyId, policyMatch[1], hard);
    return { status: 200, body: { ...result, message: hard ? "Poliza eliminada." : "Poliza cancelada." } };
  }

  if (route === "/api/ledger/auxiliary" && method === "GET") {
    requireModuleAccess(user, "contabilidad", "auxiliares");
    const auxiliary = await getAuxiliaryReport(companyId, query);
    return { status: 200, body: { auxiliary } };
  }

  if (route === "/api/ledger/trial-balance" && method === "GET") {
    requireModuleAccess(user, "contabilidad", "balanza");
    const trialBalance = await getTrialBalance(companyId, query);
    return { status: 200, body: { trialBalance } };
  }

  if (route === "/api/ledger/statements" && method === "GET") {
    requireModuleAccess(user, "contabilidad", "estados");
    const statements = await getFinancialStatements(companyId, query);
    return { status: 200, body: { statements } };
  }

  if (route === "/api/ledger/exchange-rates" && method === "GET") {
    requireModuleAccess(user, "contabilidad", "tipocambio");
    const exchangeRates = await listExchangeRates(companyId);
    return { status: 200, body: { exchangeRates } };
  }
  if (route === "/api/ledger/exchange-rates" && method === "POST") {
    requireModuleAccess(user, "contabilidad", "tipocambio");
    const body = await readBody();
    const targetCompanyId = resolveTenantCompanyId(user, body.companyId ?? query.companyId);
    const exchangeRate = await saveExchangeRate(user, targetCompanyId, body);
    return { status: 201, body: { exchangeRate, message: "Tipo de cambio guardado." } };
  }
  const rateMatch = route.match(/^\/api\/ledger\/exchange-rates\/(\d+)$/);
  if (rateMatch && method === "DELETE") {
    requireModuleAccess(user, "contabilidad", "tipocambio");
    const result = await deleteExchangeRate(companyId, rateMatch[1]);
    return { status: 200, body: { ...result, message: "Tipo de cambio eliminado." } };
  }

  return undefined;
}

module.exports = {
  ACCOUNT_TYPES,
  POLICY_TYPES,
  computeClosingBalance,
  ensureLedgerTables,
  getFinancialStatements,
  getTrialBalance,
  handleLedgerRoute,
  listAccountsWithBalances,
};
