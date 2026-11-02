const pool = require("../config/connection");
const { requireModuleAccess, resolveTenantCompanyId } = require("../config/permissions");
const { parsePagination } = require("../config/validator");
const { listAccountsWithBalances } = require("./ledger");

const REPORT_TYPES = [
  "income-statement",
  "balance-sheet",
  "trial-balance",
  "payroll-catalog",
  "sales-profit",
  "purchase-invoice",
];

let accountingTablesPromise = null;

function resolveCompanyId(user, requestedCompanyId) {
  return resolveTenantCompanyId(user, requestedCompanyId);
}

async function ensureAccountingTables() {
  if (!accountingTablesPromise) {
    accountingTablesPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS accounting_balances (
        id BIGSERIAL PRIMARY KEY,
        company_id INT NOT NULL,
        period CHAR(7) NOT NULL,
        account_code VARCHAR(30) NOT NULL,
        account_name VARCHAR(180) NOT NULL,
        account_type VARCHAR(40) NOT NULL,
        opening_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
        debit DECIMAL(18,2) NOT NULL DEFAULT 0,
        credit DECIMAL(18,2) NOT NULL DEFAULT 0,
        CONSTRAINT uq_accounting_balance UNIQUE (company_id, period, account_code)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS payroll_concepts (
        id BIGSERIAL PRIMARY KEY,
        company_id INT NOT NULL,
        concept_key VARCHAR(20) NOT NULL,
        description VARCHAR(180) NOT NULL,
        status VARCHAR(30) NOT NULL,
        integrates_salary VARCHAR(10) NOT NULL,
        calculation_scope VARCHAR(30) NOT NULL,
        benefit VARCHAR(10) NOT NULL,
        movement_type VARCHAR(20) NOT NULL,
        accumulated DECIMAL(18,2) NOT NULL DEFAULT 0,
        CONSTRAINT uq_payroll_concept UNIQUE (company_id, concept_key)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS sales_profit_lines (
        id BIGSERIAL PRIMARY KEY,
        company_id INT NOT NULL,
        period CHAR(7) NOT NULL,
        product_code VARCHAR(40) NOT NULL,
        description VARCHAR(180) NOT NULL,
        quantity DECIMAL(18,2) NOT NULL DEFAULT 0,
        total_cost DECIMAL(18,2) NOT NULL DEFAULT 0,
        total_price DECIMAL(18,2) NOT NULL DEFAULT 0,
        CONSTRAINT uq_sales_profit_line UNIQUE (company_id, period, product_code)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS purchase_invoices (
        id BIGSERIAL PRIMARY KEY,
        company_id INT NOT NULL,
        invoice_number VARCHAR(50) NOT NULL,
        supplier VARCHAR(180) NOT NULL,
        issue_date DATE NOT NULL,
        due_date DATE,
        currency CHAR(3) NOT NULL DEFAULT 'USD',
        status VARCHAR(30) NOT NULL DEFAULT 'Recibida',
        net_weight DECIMAL(18,2) NOT NULL DEFAULT 0,
        gross_weight DECIMAL(18,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_purchase_invoice UNIQUE (company_id, invoice_number)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
        id BIGSERIAL PRIMARY KEY,
        invoice_id BIGINT NOT NULL,
        work_order VARCHAR(30) NOT NULL,
        style_code VARCHAR(30) NOT NULL,
        description VARCHAR(180) NOT NULL,
        color VARCHAR(80),
        quantity DECIMAL(18,2) NOT NULL DEFAULT 0,
        unit VARCHAR(10) NOT NULL,
        unit_price DECIMAL(18,4) NOT NULL DEFAULT 0,
        line_total DECIMAL(18,2) NOT NULL DEFAULT 0
      )`);
    })().catch((error) => {
      accountingTablesPromise = null;
      throw error;
    });
  }
  return accountingTablesPromise;
}

function number(value) {
  return Number(value || 0);
}

function closing(row) {
  if (row.closing_override !== undefined) return number(row.closing_override);
  return number(row.opening_balance) + number(row.debit) - number(row.credit);
}

function sum(rows, type) {
  return rows
    .filter((row) => row.account_type === type)
    .reduce((total, row) => total + Math.abs(closing(row)), 0);
}

async function getAccountingReport(user, query = {}) {
  requireModuleAccess(user, "contabilidad", "estados");
  const type = String(query.type || "income-statement");
  if (!REPORT_TYPES.includes(type)) throw new Error("El tipo de reporte contable no es valido.");
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.period || "") ? query.period : "2026-01";
  const companyId = resolveCompanyId(user, query.companyId);
  const { limit, offset } = parsePagination(query, 200, 500);
  await ensureAccountingTables();

  const [companies] = await pool.query(
    `SELECT id, code, name, legal_name, rtn, country_code, country_name, locale,
            currency_code, currency_symbol, tax_id_label, tax_id, tax_rate, city
     FROM companies WHERE id = ? AND active = 1 LIMIT 1`,
    [companyId]
  );
  if (!companies.length) throw new Error("La empresa solicitada no existe.");
  const company = companies[0];

  if (type === "payroll-catalog") {
    const [concepts] = await pool.query(
      `SELECT id, company_id, concept_key, description, status, integrates_salary,
              calculation_scope, benefit, movement_type, accumulated
       FROM payroll_concepts WHERE company_id = ? ORDER BY concept_key LIMIT ? OFFSET ?`,
      [companyId, limit, offset]
    );
    return { type, period, company, concepts };
  }

  if (type === "sales-profit") {
    const [lines] = await pool.query(
      `SELECT product_code, description, quantity, total_cost, total_price
       FROM sales_profit_lines WHERE company_id = ? AND period = ? ORDER BY product_code LIMIT ? OFFSET ?`,
      [companyId, period, limit, offset]
    );
    const rows = lines.map((row) => {
      const cost = number(row.total_cost);
      const price = number(row.total_price);
      const utility = price - cost;
      return {
        code: row.product_code,
        description: row.description,
        quantity: number(row.quantity),
        cost,
        price,
        utility,
        utilityPercent: cost ? (utility / cost) * 100 : 0,
        margin: price ? (utility / price) * 100 : 0,
      };
    });
    return {
      type,
      period,
      company,
      rows,
      filters: { product: "Todos", customer: "Todos", seller: "Todos", documentType: "Todos", currency: company.currency_code },
      totals: rows.reduce(
        (totals, row) => ({
          quantity: totals.quantity + row.quantity,
          cost: totals.cost + row.cost,
          price: totals.price + row.price,
          utility: totals.utility + row.utility,
        }),
        { quantity: 0, cost: 0, price: 0, utility: 0 }
      ),
    };
  }

  if (type === "purchase-invoice") {
    const [invoices] = await pool.query(
      `SELECT id, company_id, invoice_number, supplier, issue_date, due_date, currency, status, net_weight, gross_weight
       FROM purchase_invoices WHERE company_id = ? ORDER BY issue_date DESC, id DESC LIMIT 1`,
      [companyId]
    );
    const invoice = invoices[0];
    if (!invoice) {
      return {
        type,
        period,
        company,
        invoice: {
          number: "Sin facturas registradas",
          supplier: "-",
          issueDate: `${period}-01`,
          dueDate: `${period}-01`,
          currency: company.currency_code || "HNL",
          status: "Pendiente",
          netWeight: 0,
          grossWeight: 0,
        },
        lines: [],
        totals: { subtotal: 0, tax: 0 },
      };
    }
    const [lines] = await pool.query(
      `SELECT id, invoice_id, work_order, style_code, description, color, quantity, unit, unit_price, line_total
       FROM purchase_invoice_lines WHERE invoice_id = ? ORDER BY id LIMIT ? OFFSET ?`,
      [invoice.id, limit, offset]
    );
    return {
      type,
      period,
      company,
      invoice: {
        number: invoice.invoice_number,
        supplier: invoice.supplier,
        issueDate: invoice.issue_date,
        dueDate: invoice.due_date,
        currency: invoice.currency,
        status: invoice.status,
        netWeight: number(invoice.net_weight),
        grossWeight: number(invoice.gross_weight),
      },
      lines: lines.map((row) => ({
        workOrder: row.work_order,
        styleCode: row.style_code,
        description: row.description,
        color: row.color || "",
        quantity: number(row.quantity),
        unit: row.unit,
        unitPrice: number(row.unit_price),
        total: number(row.line_total),
      })),
      totals: { subtotal: lines.reduce((total, row) => total + number(row.line_total), 0), tax: 0 },
    };
  }

  const ledgerAccounts = await listAccountsWithBalances(companyId, { period });
  const [balanceRows] = await pool.query(
    `SELECT id, company_id, period, account_code, account_name, account_type, opening_balance, debit, credit
     FROM accounting_balances WHERE company_id = ? AND period = ? ORDER BY account_code LIMIT ? OFFSET ?`,
    [companyId, period, limit, offset]
  );
  const rows = ledgerAccounts.length ? ledgerAccounts.map((acc) => ({ account_code: acc.code, account_name: acc.name, account_type: acc.accountType, opening_balance: acc.periodOpening, debit: acc.debit, credit: acc.credit, closing_override: acc.closingBalance })) : balanceRows;
  if (type === "trial-balance") {
    return {
      type,
      period,
      company,
      rows: rows.map((row) => ({
        code: row.account_code,
        name: row.account_name,
        opening: number(row.opening_balance),
        debit: number(row.debit),
        credit: number(row.credit),
        closing: closing(row),
      })),
      totals: {
        opening: rows.reduce((t, r) => t + number(r.opening_balance), 0),
        debit: rows.reduce((t, r) => t + number(r.debit), 0),
        credit: rows.reduce((t, r) => t + number(r.credit), 0),
        closing: rows.reduce((t, r) => t + closing(r), 0),
      },
    };
  }
  if (type === "income-statement") {
    const income = sum(rows, "INCOME");
    const cost = sum(rows, "COST");
    const expenses = sum(rows, "EXPENSE");
    const otherIncome = sum(rows, "OTHER_INCOME");
    const otherExpense = sum(rows, "OTHER_EXPENSE");
    const grossProfit = income - cost;
    const operatingProfit = grossProfit - expenses;
    const netProfit = operatingProfit + otherIncome - otherExpense;
    return { type, period, company, income, cost, grossProfit, expenses, operatingProfit, otherIncome, otherExpense, taxes: 0, netProfit };
  }
  const currentAssets = sum(rows, "ASSET_CURRENT");
  const nonCurrentAssets = sum(rows, "ASSET_NONCURRENT");
  const currentLiabilities = sum(rows, "LIABILITY_CURRENT");
  const longLiabilities = sum(rows, "LIABILITY_LONG");
  const equity = sum(rows, "EQUITY");
  return {
    type,
    period,
    company,
    sections: {
      currentAssets: rows.filter((r) => r.account_type === "ASSET_CURRENT").map((r) => ({ name: r.account_name, amount: Math.abs(closing(r)) })),
      nonCurrentAssets: rows.filter((r) => r.account_type === "ASSET_NONCURRENT").map((r) => ({ name: r.account_name, amount: Math.abs(closing(r)) })),
      currentLiabilities: rows.filter((r) => r.account_type === "LIABILITY_CURRENT").map((r) => ({ name: r.account_name, amount: Math.abs(closing(r)) })),
      longLiabilities: rows.filter((r) => r.account_type === "LIABILITY_LONG").map((r) => ({ name: r.account_name, amount: Math.abs(closing(r)) })),
      equity: rows.filter((r) => r.account_type === "EQUITY").map((r) => ({ name: r.account_name, amount: Math.abs(closing(r)) })),
    },
    totals: {
      currentAssets,
      nonCurrentAssets,
      assets: currentAssets + nonCurrentAssets,
      currentLiabilities,
      longLiabilities,
      equity,
      liabilitiesAndEquity: currentLiabilities + longLiabilities + equity,
    },
  };
}

module.exports = { ensureAccountingTables, getAccountingReport };
