const PDFDocument = require("pdfkit");
const pool = require("../config/connection");
const { requireModuleAccess, resolveTenantCompanyId } = require("../config/permissions");
const { logSecurityEvent } = require("../config/audit");
const { sanitizeText } = require("../config/validator");
const { decryptField } = require("../config/crypto-fields");
const { sendPayrollReceiptEmail } = require("../config/mailer");
const { ensureEmployeesTable } = require("./employees");
const { ensureAccountingTables } = require("./accounting");

let payrollTablesPromise = null;

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

function safeDecrypt(value) {
  try {
    return decryptField(value);
  } catch {
    return "";
  }
}

async function ensurePayrollTables() {
  if (!payrollTablesPromise) {
    payrollTablesPromise = (async () => {
      await ensureEmployeesTable();
      await ensureAccountingTables();
      await pool.query("ALTER TABLE payroll_concepts ADD COLUMN IF NOT EXISTS concept_type CHAR(1) NOT NULL DEFAULT 'P'").catch(() => {});
      await pool.query("ALTER TABLE payroll_concepts ADD COLUMN IF NOT EXISTS concept_number INT NOT NULL DEFAULT 1").catch(() => {});

      await pool.query(`CREATE TABLE IF NOT EXISTS payroll_closures (
        id BIGSERIAL PRIMARY KEY,
        company_id INT NOT NULL,
        period CHAR(7) NOT NULL,
        notes VARCHAR(200) NOT NULL DEFAULT '',
        closed_by INT NULL,
        closed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_payroll_closure UNIQUE (company_id, period)
      )`);

      await pool.query(`CREATE TABLE IF NOT EXISTS payroll_receipts (
        id BIGSERIAL PRIMARY KEY,
        company_id INT NOT NULL,
        employee_id BIGINT NOT NULL,
        period CHAR(7) NOT NULL,
        payment_frequency VARCHAR(20) NOT NULL DEFAULT 'Quincenal',
        pay_date DATE NOT NULL,
        base_salary DECIMAL(18,2) NOT NULL DEFAULT 0,
        total_perceptions DECIMAL(18,2) NOT NULL DEFAULT 0,
        total_deductions DECIMAL(18,2) NOT NULL DEFAULT 0,
        net_pay DECIMAL(18,2) NOT NULL DEFAULT 0,
        bank_account VARCHAR(80) NOT NULL DEFAULT '',
        email_sent SMALLINT NOT NULL DEFAULT 0,
        created_by INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);

      await pool.query(`CREATE TABLE IF NOT EXISTS payroll_receipt_lines (
        id BIGSERIAL PRIMARY KEY,
        receipt_id BIGINT NOT NULL,
        concept_key VARCHAR(20) NOT NULL,
        concept_type CHAR(1) NOT NULL,
        description VARCHAR(180) NOT NULL,
        amount DECIMAL(18,2) NOT NULL DEFAULT 0
      )`);
    })().catch((error) => {
      payrollTablesPromise = null;
      throw error;
    });
  }
  return payrollTablesPromise;
}

async function getCompanyInfo(companyId) {
  const [rows] = await pool.query(
    `SELECT id, code, name, legal_name, rtn, country_code, country_name, locale,
            currency_code, currency_symbol, tax_id_label, tax_id, city
     FROM companies WHERE id = ? AND active = 1 LIMIT 1`,
    [companyId]
  );
  if (!rows.length) throw httpError("La empresa solicitada no existe.", 404);
  return rows[0];
}

async function isPeriodClosed(companyId, period) {
  await ensurePayrollTables();
  const [rows] = await pool.query(
    "SELECT id, closed_at, notes FROM payroll_closures WHERE company_id = ? AND period = ? LIMIT 1",
    [companyId, period]
  );
  return rows[0] || null;
}

async function assertPeriodOpen(companyId, period) {
  const closed = await isPeriodClosed(companyId, period);
  if (closed) {
    throw httpError(
      `El periodo de nomina ${period} se encuentra CERRADO y no permite registrar, editar ni eliminar mas nominas.`,
      409
    );
  }
}

async function listPayrollEmployees(companyId) {
  await ensurePayrollTables();
  const [rows] = await pool.query(
    `SELECT id, company_id, first_name, last_name, second_last_name, email, birth_date, birth_place,
            gender, identity_number, tax_number, social_security_number, position, branch, system_role,
            base_salary, payment_frequency, bank_account, payroll_email_enabled, status
     FROM employees
     WHERE company_id = ? AND status <> 'Eliminado'
     ORDER BY id ASC`,
    [companyId]
  );
  return rows.map((r, index) => ({
    id: Number(r.id),
    workerNo: index + 1,
    companyId: Number(r.company_id),
    firstName: r.first_name,
    lastName: r.last_name,
    secondLastName: r.second_last_name || "",
    fullName: [r.first_name, r.last_name, r.second_last_name].filter(Boolean).join(" "),
    email: r.email,
    birthDate: r.birth_date ? String(r.birth_date).slice(0, 10) : "",
    birthPlace: r.birth_place || "",
    gender: r.gender,
    identityNumber: safeDecrypt(r.identity_number),
    taxNumber: safeDecrypt(r.tax_number),
    socialSecurityNumber: safeDecrypt(r.social_security_number),
    position: r.position,
    branch: r.branch,
    systemRole: r.system_role,
    baseSalary: round2(r.base_salary),
    paymentFrequency: r.payment_frequency || "Quincenal",
    bankAccount: r.bank_account || "",
    payrollEmailEnabled: r.payroll_email_enabled === undefined || r.payroll_email_enabled === null ? true : Boolean(Number(r.payroll_email_enabled)),
    status: r.status,
  }));
}

async function updateEmployeePayrollData(user, companyId, employeeId, body = {}) {
  await ensurePayrollTables();
  const [rows] = await pool.query(
    "SELECT id FROM employees WHERE id = ? AND company_id = ? AND status <> 'Eliminado' LIMIT 1",
    [Number(employeeId), companyId]
  );
  if (!rows.length) throw httpError("El trabajador solicitado no existe en esta empresa.", 404);

  const baseSalary = Math.max(round2(body.baseSalary ?? body.base_salary ?? 0), 0);
  const paymentFrequency = ["Semanal", "Quincenal", "Mensual"].includes(body.paymentFrequency)
    ? body.paymentFrequency
    : "Quincenal";
  const bankAccount = sanitizeText(body.bankAccount ?? body.bank_account ?? "", 80);
  const emailFlag =
    body.payrollEmailEnabled === false ||
    body.payrollEmailEnabled === "NO" ||
    body.payrollEmailEnabled === 0 ||
    body.payrollEmailEnabled === "0"
      ? 0
      : 1;

  await pool.query(
    `UPDATE employees
     SET base_salary = ?, payment_frequency = ?, bank_account = ?, payroll_email_enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [baseSalary, paymentFrequency, bankAccount, emailFlag, Number(employeeId), companyId]
  );

  const list = await listPayrollEmployees(companyId);
  return list.find((e) => e.id === Number(employeeId));
}

async function listConcepts(companyId) {
  await ensurePayrollTables();
  const [rows] = await pool.query(
    `SELECT id, company_id, concept_key, concept_type, concept_number, description, status,
            integrates_salary, calculation_scope, benefit, movement_type, accumulated
     FROM payroll_concepts
     WHERE company_id = ?
     ORDER BY concept_key ASC`,
    [companyId]
  );
  return rows.map((r) => {
    const inferredType = String(r.concept_key || "").toUpperCase().startsWith("D") ? "D" : "P";
    const cType = r.concept_type === "D" || inferredType === "D" ? "D" : "P";
    return {
      id: Number(r.id),
      companyId: Number(r.company_id),
      conceptKey: r.concept_key,
      conceptType: cType,
      conceptTypeLabel: cType === "P" ? "Prestacion / Percepcion (P)" : "Deduccion (D)",
      conceptNumber: Number(r.concept_number || parseInt(String(r.concept_key).slice(1), 10) || 1),
      description: r.description,
      status: r.status || "Alta",
      integratesSalary: r.integrates_salary || "Si",
      calculationScope: r.calculation_scope || "General",
      benefit: r.benefit || (cType === "P" ? "Si" : "No"),
      movementType: r.movement_type || "Fija",
      accumulated: round2(r.accumulated),
    };
  });
}

async function createOrUpdateConcept(user, companyId, body = {}) {
  await ensurePayrollTables();
  const conceptType = String(body.conceptType || body.type || "P").trim().toUpperCase() === "D" ? "D" : "P";
  const numberVal = Number(body.conceptNumber ?? body.number ?? 1);
  if (!Number.isInteger(numberVal) || numberVal < 1 || numberVal > 50) {
    throw httpError("El numero del concepto debe estar entre 1 y 50 (ej. P001 a P050 o D001 a D050).");
  }
  const conceptKey = `${conceptType}${String(numberVal).padStart(3, "0")}`;
  const description = sanitizeText(body.description || "", 180);
  if (description.length < 2) {
    throw httpError("La descripcion del concepto de nomina es obligatoria.");
  }
  const integratesSalary = String(body.integratesSalary || "Si") === "No" ? "No" : "Si";
  const movementType = String(body.movementType || "Fija") === "Variable" ? "Variable" : "Fija";
  const benefit = conceptType === "P" ? "Si" : "No";

  await pool.query(
    `INSERT INTO payroll_concepts
     (company_id, concept_key, concept_type, concept_number, description, status, integrates_salary, calculation_scope, benefit, movement_type, accumulated)
     VALUES (?, ?, ?, ?, ?, 'Alta', ?, 'General', ?, ?, 0)
     ON CONFLICT (company_id, concept_key) DO UPDATE
     SET concept_type = EXCLUDED.concept_type,
         concept_number = EXCLUDED.concept_number,
         description = EXCLUDED.description,
         integrates_salary = EXCLUDED.integrates_salary,
         benefit = EXCLUDED.benefit,
         movement_type = EXCLUDED.movement_type`,
    [companyId, conceptKey, conceptType, numberVal, description, integratesSalary, benefit, movementType]
  );

  const list = await listConcepts(companyId);
  return list.find((c) => c.conceptKey === conceptKey);
}

async function deleteConcept(companyId, id) {
  await ensurePayrollTables();
  await pool.query("DELETE FROM payroll_concepts WHERE id = ? AND company_id = ?", [Number(id), companyId]);
  return { deleted: true, id: Number(id) };
}

function buildReceiptPdfBuffer({ receipt, employee, company }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const sym = company.currency_symbol || "L";
    const fmt = (v) => `${sym} ${Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    doc.fontSize(16).fillColor("#1e3a8a").text(company.name || "Gestion Empresarial", { align: "left" });
    doc.fontSize(10).fillColor("#4b5563").text(`${company.tax_id_label || "RTN"}: ${company.tax_id || "-"} · ${company.city || ""}, ${company.country_name || "Honduras"}`);
    doc.moveDown(0.5);
    doc.fontSize(13).fillColor("#111827").text(`RECIBO DE NOMINA - PERIODO ${receipt.period} (${receipt.paymentFrequency})`, { underline: true });
    doc.moveDown(0.6);

    doc.fontSize(10).fillColor("#1f2937");
    doc.text(`Trabajador: ${employee.fullName} (No. ${employee.workerNo || employee.id})`);
    doc.text(`Puesto: ${employee.position}   |   Sucursal: ${employee.branch}`);
    doc.text(`DNI / Identidad: ${employee.identityNumber || "-"}   |   RTN/RFC: ${employee.taxNumber || "-"}   |   IHSS/IMSS: ${employee.socialSecurityNumber || "-"}`);
    doc.text(`Cuenta Bancaria: ${receipt.bankAccount || employee.bankAccount || "-"}   |   Fecha de Pago: ${receipt.payDate}`);
    doc.moveDown(0.8);

    doc.fontSize(11).fillColor("#1e3a8a").text("Desglose de Percepciones (P) y Deducciones (D)");
    doc.moveDown(0.3);

    const startX = 40;
    let y = doc.y;
    doc.fontSize(9.5).fillColor("#111827");
    doc.text("Clave", startX, y, { width: 65 });
    doc.text("Tipo", startX + 70, y, { width: 90 });
    doc.text("Concepto", startX + 165, y, { width: 230 });
    doc.text("Importe", startX + 400, y, { width: 110, align: "right" });
    y += 16;
    doc.moveTo(startX, y).lineTo(550, y).strokeColor("#9ca3af").stroke();
    y += 6;

    for (const line of receipt.lines) {
      doc.fillColor("#1f2937");
      doc.text(line.conceptKey, startX, y, { width: 65 });
      doc.text(line.conceptType === "P" ? "Prestacion (P)" : "Deduccion (D)", startX + 70, y, { width: 90 });
      doc.text(line.description, startX + 165, y, { width: 230 });
      doc.text(fmt(line.amount), startX + 400, y, { width: 110, align: "right" });
      y += 16;
    }

    y += 6;
    doc.moveTo(startX, y).lineTo(550, y).strokeColor("#1e3a8a").stroke();
    y += 8;
    doc.fontSize(10).fillColor("#111827");
    doc.text(`Total Percepciones / Prestaciones: ${fmt(receipt.totalPerceptions)}`, startX, y, { align: "right", width: 510 });
    y += 15;
    doc.text(`Total Deducciones: ${fmt(receipt.totalDeductions)}`, startX, y, { align: "right", width: 510 });
    y += 18;
    doc.fontSize(12).fillColor("#1e3a8a").text(`NETO A PAGAR: ${fmt(receipt.netPay)}`, startX, y, { align: "right", width: 510 });

    doc.end();
  });
}

async function listReceipts(companyId, query = {}) {
  await ensurePayrollTables();
  const employees = await listPayrollEmployees(companyId);
  const empMap = new Map(employees.map((e) => [e.id, e]));

  let sql = `SELECT id, company_id, employee_id, period, payment_frequency, pay_date,
                    base_salary, total_perceptions, total_deductions, net_pay, bank_account, email_sent, created_at
             FROM payroll_receipts WHERE company_id = ?`;
  const params = [companyId];
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(query.period || "")) {
    sql += " AND period = ?";
    params.push(query.period);
  }
  sql += " ORDER BY pay_date DESC, id ASC";
  const [receipts] = await pool.query(sql, params);
  if (!receipts.length) return [];

  const [lines] = await pool.query(
    `SELECT l.id, l.receipt_id, l.concept_key, l.concept_type, l.description, l.amount
     FROM payroll_receipt_lines l
     INNER JOIN payroll_receipts r ON r.id = l.receipt_id
     WHERE r.company_id = ?
     ORDER BY l.id ASC`,
    [companyId]
  );
  const linesByReceipt = new Map();
  for (const line of lines) {
    const rid = Number(line.receipt_id);
    if (!linesByReceipt.has(rid)) linesByReceipt.set(rid, []);
    linesByReceipt.get(rid).push({
      conceptKey: line.concept_key,
      conceptType: line.concept_type,
      description: line.description,
      amount: round2(line.amount),
    });
  }

  return receipts.map((r, index) => {
    const emp = empMap.get(Number(r.employee_id)) || {
      id: Number(r.employee_id),
      workerNo: index + 1,
      fullName: `Empleado #${r.employee_id}`,
      email: "",
      position: "-",
      branch: "-",
      identityNumber: "-",
      taxNumber: "-",
      socialSecurityNumber: "-",
      payrollEmailEnabled: false,
    };
    return {
      id: Number(r.id),
      rowNo: index + 1,
      companyId: Number(r.company_id),
      employeeId: Number(r.employee_id),
      employee: emp,
      period: r.period,
      paymentFrequency: r.payment_frequency,
      payDate: typeof r.pay_date === "string" ? r.pay_date.slice(0, 10) : new Date(r.pay_date).toISOString().slice(0, 10),
      baseSalary: round2(r.base_salary),
      totalPerceptions: round2(r.total_perceptions),
      totalDeductions: round2(r.total_deductions),
      netPay: round2(r.net_pay),
      bankAccount: r.bank_account || emp.bankAccount || "",
      emailSent: Boolean(Number(r.email_sent)),
      lines: linesByReceipt.get(Number(r.id)) || [],
    };
  });
}

async function recalcConceptAccumulated(companyId) {
  const [sums] = await pool.query(
    `SELECT l.concept_key, COALESCE(SUM(l.amount), 0) AS total
     FROM payroll_receipt_lines l
     INNER JOIN payroll_receipts r ON r.id = l.receipt_id
     WHERE r.company_id = ?
     GROUP BY l.concept_key`,
    [companyId]
  );
  await pool.query("UPDATE payroll_concepts SET accumulated = 0 WHERE company_id = ?", [companyId]);
  for (const row of sums) {
    await pool.query(
      "UPDATE payroll_concepts SET accumulated = ? WHERE company_id = ? AND concept_key = ?",
      [round2(row.total), companyId, row.concept_key]
    );
  }
}

async function createReceipt(user, companyId, body = {}) {
  await ensurePayrollTables();
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(body.period || "") ? body.period : new Date().toISOString().slice(0, 7);
  await assertPeriodOpen(companyId, period);

  const employees = await listPayrollEmployees(companyId);
  const employee = employees.find((e) => e.id === Number(body.employeeId));
  if (!employee) throw httpError("Selecciona un trabajador valido de la empresa.");

  const payDate = /^\d{4}-\d{2}-\d{2}$/.test(body.payDate || "") ? body.payDate : `${period}-15`;
  const paymentFrequency = ["Semanal", "Quincenal", "Mensual"].includes(body.paymentFrequency)
    ? body.paymentFrequency
    : employee.paymentFrequency || "Quincenal";
  const baseSalary = round2(body.baseSalary !== undefined ? body.baseSalary : employee.baseSalary);
  const bankAccount = sanitizeText(body.bankAccount ?? employee.bankAccount ?? "", 80);

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  const cleanLines = [];
  if (baseSalary > 0 && !rawLines.some((l) => String(l.conceptKey).toUpperCase() === "P001")) {
    cleanLines.push({
      conceptKey: "P001",
      conceptType: "P",
      description: "Sueldo / Salario Base",
      amount: baseSalary,
    });
  }
  for (const line of rawLines) {
    const amount = round2(line.amount);
    if (amount <= 0) continue;
    const key = sanitizeText(line.conceptKey || "P001", 20).toUpperCase();
    const type = key.startsWith("D") || line.conceptType === "D" ? "D" : "P";
    const description = sanitizeText(line.description || (type === "P" ? "Percepcion" : "Deduccion"), 180);
    cleanLines.push({ conceptKey: key, conceptType: type, description, amount });
  }

  if (!cleanLines.length) {
    throw httpError("La nomina del trabajador debe tener al menos un importe mayor a cero (salario base o concepto).");
  }

  const totalPerceptions = round2(
    cleanLines.filter((l) => l.conceptType === "P").reduce((s, l) => s + l.amount, 0)
  );
  const totalDeductions = round2(
    cleanLines.filter((l) => l.conceptType === "D").reduce((s, l) => s + l.amount, 0)
  );
  const netPay = round2(totalPerceptions - totalDeductions);

  const [inserted] = await pool.query(
    `INSERT INTO payroll_receipts
     (company_id, employee_id, period, payment_frequency, pay_date, base_salary, total_perceptions, total_deductions, net_pay, bank_account, email_sent, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     RETURNING id`,
    [
      companyId,
      employee.id,
      period,
      paymentFrequency,
      payDate,
      baseSalary,
      totalPerceptions,
      totalDeductions,
      netPay,
      bankAccount,
      user.id,
    ]
  );
  const receiptId = Number(inserted.insertId ?? inserted[0]?.id);
  for (const line of cleanLines) {
    await pool.query(
      `INSERT INTO payroll_receipt_lines (receipt_id, concept_key, concept_type, description, amount)
       VALUES (?, ?, ?, ?, ?)`,
      [receiptId, line.conceptKey, line.conceptType, line.description, line.amount]
    );
  }

  await recalcConceptAccumulated(companyId);

  const list = await listReceipts(companyId, { period });
  const created = list.find((r) => r.id === receiptId);

  let emailResult = { delivered: false, reason: "DISABLED_FOR_EMPLOYEE" };
  const shouldEmail = body.sendEmail !== undefined ? Boolean(body.sendEmail) : employee.payrollEmailEnabled;
  if (shouldEmail && employee.email && created) {
    try {
      const company = await getCompanyInfo(companyId);
      const pdfBuffer = await buildReceiptPdfBuffer({ receipt: created, employee, company });
      emailResult = await sendPayrollReceiptEmail({
        to: employee.email,
        employeeName: employee.fullName,
        companyName: company.name,
        periodLabel: `${period} (${paymentFrequency})`,
        netPay,
        currencySymbol: company.currency_symbol || "L",
        pdfBuffer,
        filename: `recibo-nomina-${period}-${employee.id}.pdf`,
      });
      if (emailResult.delivered) {
        await pool.query("UPDATE payroll_receipts SET email_sent = 1 WHERE id = ?", [receiptId]);
        created.emailSent = true;
      }
    } catch (error) {
      emailResult = { delivered: false, reason: error.message };
    }
  }

  await logSecurityEvent({
    companyId,
    userId: user.id,
    action: "PAYROLL_RECEIPT_CREATED",
    severity: "INFO",
    details: { receiptId, employeeId: employee.id, period, netPay },
  });

  return { receipt: created, emailResult };
}

async function deleteReceipt(user, companyId, id) {
  await ensurePayrollTables();
  const [rows] = await pool.query(
    "SELECT id, period FROM payroll_receipts WHERE id = ? AND company_id = ? LIMIT 1",
    [Number(id), companyId]
  );
  if (!rows.length) throw httpError("El recibo de nomina no existe.", 404);
  await assertPeriodOpen(companyId, rows[0].period);

  await pool.query("DELETE FROM payroll_receipt_lines WHERE receipt_id = ?", [Number(id)]);
  await pool.query("DELETE FROM payroll_receipts WHERE id = ? AND company_id = ?", [Number(id), companyId]);
  await recalcConceptAccumulated(companyId);
  return { deleted: true, id: Number(id) };
}

async function getAccumulatedReport(companyId, query = {}) {
  await ensurePayrollTables();
  const fromPeriod = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.from || "") ? query.from : "2026-01";
  const toPeriod = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.to || "") ? query.to : "2026-12";

  const [conceptRows] = await pool.query(
    `SELECT l.concept_key, l.concept_type, MAX(l.description) AS description,
            COUNT(DISTINCT r.id) AS receipts_count,
            COALESCE(SUM(l.amount), 0) AS total_amount
     FROM payroll_receipt_lines l
     INNER JOIN payroll_receipts r ON r.id = l.receipt_id
     WHERE r.company_id = ? AND r.period >= ? AND r.period <= ?
     GROUP BY l.concept_key, l.concept_type
     ORDER BY l.concept_key ASC`,
    [companyId, fromPeriod, toPeriod]
  );

  const employees = await listPayrollEmployees(companyId);
  const empMap = new Map(employees.map((e) => [e.id, e]));
  const [empRows] = await pool.query(
    `SELECT employee_id,
            COUNT(id) AS receipts_count,
            COALESCE(SUM(total_perceptions), 0) AS perceptions,
            COALESCE(SUM(total_deductions), 0) AS deductions,
            COALESCE(SUM(net_pay), 0) AS net_pay
     FROM payroll_receipts
     WHERE company_id = ? AND period >= ? AND period <= ?
     GROUP BY employee_id
     ORDER BY employee_id ASC`,
    [companyId, fromPeriod, toPeriod]
  );

  return {
    from: fromPeriod,
    to: toPeriod,
    byConcept: conceptRows.map((c) => ({
      conceptKey: c.concept_key,
      conceptType: c.concept_type,
      description: c.description,
      receiptsCount: Number(c.receipts_count || 0),
      totalAmount: round2(c.total_amount),
    })),
    byEmployee: empRows.map((row, idx) => {
      const emp = empMap.get(Number(row.employee_id)) || { fullName: `Empleado #${row.employee_id}`, position: "-", bankAccount: "-" };
      return {
        workerNo: idx + 1,
        employeeId: Number(row.employee_id),
        fullName: emp.fullName,
        position: emp.position,
        bankAccount: emp.bankAccount || "-",
        receiptsCount: Number(row.receipts_count || 0),
        perceptions: round2(row.perceptions),
        deductions: round2(row.deductions),
        netPay: round2(row.net_pay),
      };
    }),
  };
}

async function listClosures(companyId) {
  await ensurePayrollTables();
  const [rows] = await pool.query(
    "SELECT id, company_id, period, notes, closed_at FROM payroll_closures WHERE company_id = ? ORDER BY period DESC",
    [companyId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    period: r.period,
    notes: r.notes || "",
    closedAt: r.closed_at,
  }));
}

async function closePayrollPeriod(user, companyId, body = {}) {
  await ensurePayrollTables();
  const period = String(body.period || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw httpError("Selecciona un periodo valido (YYYY-MM) para ejecutar el cierre de nomina.");
  }
  const existing = await isPeriodClosed(companyId, period);
  if (existing) {
    throw httpError(`El periodo ${period} ya fue cerrado anteriormente.`, 409);
  }
  const notes = sanitizeText(body.notes || "Cierre definitivo de periodo de nomina", 200);
  await pool.query(
    `INSERT INTO payroll_closures (company_id, period, notes, closed_by)
     VALUES (?, ?, ?, ?)`,
    [companyId, period, notes, user.id]
  );
  await logSecurityEvent({
    companyId,
    userId: user.id,
    action: "PAYROLL_PERIOD_CLOSED",
    severity: "WARN",
    details: { period, notes },
  });
  const closures = await listClosures(companyId);
  return closures.find((c) => c.period === period);
}

async function handlePayrollRoute({ route, method, user, query, readBody }) {
  const companyId = resolveTenantCompanyId(user, query.companyId);

  if (route === "/api/payroll/employees" && method === "GET") {
    requireModuleAccess(user, "nomina", "empleados");
    const employees = await listPayrollEmployees(companyId);
    return { status: 200, body: { employees } };
  }
  const empMatch = route.match(/^\/api\/payroll\/employees\/(\d+)$/);
  if (empMatch && method === "PUT") {
    requireModuleAccess(user, "nomina", "empleados");
    const body = await readBody();
    const targetCompanyId = resolveTenantCompanyId(user, body.companyId ?? query.companyId);
    const employee = await updateEmployeePayrollData(user, targetCompanyId, empMatch[1], body);
    return { status: 200, body: { employee, message: "Datos de nomina del trabajador actualizados." } };
  }

  if (route === "/api/payroll/concepts" && method === "GET") {
    requireModuleAccess(user, "nomina", "conceptos");
    const concepts = await listConcepts(companyId);
    return { status: 200, body: { concepts } };
  }
  if (route === "/api/payroll/concepts" && method === "POST") {
    requireModuleAccess(user, "nomina", "conceptos");
    const body = await readBody();
    const targetCompanyId = resolveTenantCompanyId(user, body.companyId ?? query.companyId);
    const concept = await createOrUpdateConcept(user, targetCompanyId, body);
    return { status: 201, body: { concept, message: "Concepto de nomina guardado." } };
  }
  const conceptMatch = route.match(/^\/api\/payroll\/concepts\/(\d+)$/);
  if (conceptMatch && method === "DELETE") {
    requireModuleAccess(user, "nomina", "conceptos");
    const result = await deleteConcept(companyId, conceptMatch[1]);
    return { status: 200, body: { ...result, message: "Concepto eliminado." } };
  }

  if (route === "/api/payroll/receipts" && method === "GET") {
    requireModuleAccess(user, "nomina", "nominas");
    const receipts = await listReceipts(companyId, query);
    const closed = query.period ? await isPeriodClosed(companyId, query.period) : null;
    return { status: 200, body: { receipts, periodClosed: Boolean(closed), closure: closed } };
  }
  if (route === "/api/payroll/receipts" && method === "POST") {
    requireModuleAccess(user, "nomina", "nominas");
    const body = await readBody();
    const targetCompanyId = resolveTenantCompanyId(user, body.companyId ?? query.companyId);
    const result = await createReceipt(user, targetCompanyId, body);
    return { status: 201, body: { ...result, message: "Nomina registrada correctamente." } };
  }
  const receiptPdfMatch = route.match(/^\/api\/payroll\/receipts\/(\d+)\/pdf$/);
  if (receiptPdfMatch && method === "GET") {
    requireModuleAccess(user, "nomina", "reportes");
    const receipts = await listReceipts(companyId);
    const receipt = receipts.find((r) => r.id === Number(receiptPdfMatch[1]));
    if (!receipt) throw httpError("Recibo de nomina no encontrado.", 404);
    const company = await getCompanyInfo(companyId);
    const pdfBuffer = await buildReceiptPdfBuffer({ receipt, employee: receipt.employee, company });
    return {
      status: 200,
      raw: pdfBuffer,
      contentType: "application/pdf",
      filename: `recibo-nomina-${receipt.period}-${receipt.employee.id}.pdf`,
    };
  }
  const receiptEmailMatch = route.match(/^\/api\/payroll\/receipts\/(\d+)\/send-email$/);
  if (receiptEmailMatch && method === "POST") {
    requireModuleAccess(user, "nomina", "nominas");
    const receipts = await listReceipts(companyId);
    const receipt = receipts.find((r) => r.id === Number(receiptEmailMatch[1]));
    if (!receipt) throw httpError("Recibo de nomina no encontrado.", 404);
    if (!receipt.employee.email) throw httpError("El trabajador no tiene correo registrado.");
    const company = await getCompanyInfo(companyId);
    const pdfBuffer = await buildReceiptPdfBuffer({ receipt, employee: receipt.employee, company });
    const emailResult = await sendPayrollReceiptEmail({
      to: receipt.employee.email,
      employeeName: receipt.employee.fullName,
      companyName: company.name,
      periodLabel: `${receipt.period} (${receipt.paymentFrequency})`,
      netPay: receipt.netPay,
      currencySymbol: company.currency_symbol || "L",
      pdfBuffer,
      filename: `recibo-nomina-${receipt.period}-${receipt.employee.id}.pdf`,
    });
    if (emailResult.delivered) {
      await pool.query("UPDATE payroll_receipts SET email_sent = 1 WHERE id = ?", [receipt.id]);
    }
    return {
      status: 200,
      body: {
        emailResult,
        message: emailResult.delivered
          ? `Recibo enviado por correo a ${receipt.employee.email}.`
          : `Recibo PDF generado (SMTP en modo local: ${emailResult.reason}).`,
      },
    };
  }
  const receiptMatch = route.match(/^\/api\/payroll\/receipts\/(\d+)$/);
  if (receiptMatch && method === "DELETE") {
    requireModuleAccess(user, "nomina", "nominas");
    const result = await deleteReceipt(user, companyId, receiptMatch[1]);
    return { status: 200, body: { ...result, message: "Recibo de nomina eliminado." } };
  }

  if (route === "/api/payroll/accumulated" && method === "GET") {
    requireModuleAccess(user, "nomina", "acumulados");
    const accumulated = await getAccumulatedReport(companyId, query);
    return { status: 200, body: { accumulated } };
  }

  if (route === "/api/payroll/closures" && method === "GET") {
    requireModuleAccess(user, "nomina", "cierre");
    const closures = await listClosures(companyId);
    return { status: 200, body: { closures } };
  }
  if (route === "/api/payroll/closures" && method === "POST") {
    requireModuleAccess(user, "nomina", "cierre");
    const body = await readBody();
    const targetCompanyId = resolveTenantCompanyId(user, body.companyId ?? query.companyId);
    const closure = await closePayrollPeriod(user, targetCompanyId, body);
    return { status: 201, body: { closure, message: `Periodo ${closure.period} cerrado. No se permitiran mas nominas en este periodo.` } };
  }

  return undefined;
}

module.exports = {
  ensurePayrollTables,
  handlePayrollRoute,
};
