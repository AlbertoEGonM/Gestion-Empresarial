process.env.SUPABASE_DB_URL = "local";
process.env.NODE_ENV = "test";
process.env.DATA_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DATA_HMAC_KEY = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
process.env.PASSWORD_PEPPER = "test-pepper-secret-2026";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ensureAuthTables } = require("../config/db");
const { createEmployee, ensureEmployeesTable } = require("../modules/employees");
const { ensureLedgerTables, handleLedgerRoute } = require("../modules/ledger");
const { ensurePayrollTables, handlePayrollRoute } = require("../modules/payroll");

const adminUser = {
  id: 1,
  username: "administrador",
  role: "Administrador",
  isGlobalAdmin: true,
  companyId: 1,
};

test("Contabilidad COI: catalogo de cuentas, polizas (Co, Di, Eg, Ig, Vt), auxiliar, balanza y estados USD/LEM", async () => {
  await ensureAuthTables();
  await ensureLedgerTables();

  await handleLedgerRoute({
    route: "/api/ledger/accounts",
    method: "POST",
    user: adminUser,
    query: { companyId: 1 },
    readBody: async () => ({
      code: "1101-001",
      name: "Bancos Moneda Nacional",
      groupingCode: "102.01",
      accountType: "ASSET_CURRENT",
      openingBalance: 10000,
      currency: "HNL",
    }),
  });

  await handleLedgerRoute({
    route: "/api/ledger/accounts",
    method: "POST",
    user: adminUser,
    query: { companyId: 1 },
    readBody: async () => ({
      code: "4101-001",
      name: "Ventas de Telas",
      groupingCode: "401.01",
      accountType: "INCOME",
      openingBalance: 0,
      currency: "HNL",
    }),
  });

  // Poliza descuadrada debe fallar
  await assert.rejects(
    () =>
      handleLedgerRoute({
        route: "/api/ledger/policies",
        method: "POST",
        user: adminUser,
        query: { companyId: 1 },
        readBody: async () => ({
          policyType: "VT",
          policyDate: "2026-01-15",
          concept: "Venta descuadrada",
          currency: "HNL",
          lines: [
            { accountCode: "1101-001", concept: "Cobro", debit: 500, credit: 0 },
            { accountCode: "4101-001", concept: "Venta", debit: 0, credit: 400 },
          ],
        }),
      }),
    /descuadrada/i
  );

  // Poliza cuadrada de Venta (Vt)
  const polRes = await handleLedgerRoute({
    route: "/api/ledger/policies",
    method: "POST",
    user: adminUser,
    query: { companyId: 1 },
    readBody: async () => ({
      policyType: "VT",
      policyDate: "2026-01-15",
      concept: "Venta de rollos de gabardina",
      currency: "HNL",
      lines: [
        { accountCode: "1101-001", concept: "Deposito cliente", debit: 2500, credit: 0 },
        { accountCode: "4101-001", concept: "Factura de venta", debit: 0, credit: 2500 },
      ],
    }),
  });
  assert.equal(polRes.status, 201);
  assert.equal(polRes.body.policy.folio, "VT-0001");

  // Balanza de comprobacion con titulo personalizado
  const trialRes = await handleLedgerRoute({
    route: "/api/ledger/trial-balance",
    method: "GET",
    user: adminUser,
    query: { companyId: 1, period: "2026-01", title: "Balanza Oficial Enero 2026" },
    readBody: async () => ({}),
  });
  assert.equal(trialRes.body.trialBalance.title, "Balanza Oficial Enero 2026");
  assert.equal(trialRes.body.trialBalance.totals.debit, 2500);
  assert.equal(trialRes.body.trialBalance.totals.credit, 2500);

  // Auxiliar de cuentas
  const auxRes = await handleLedgerRoute({
    route: "/api/ledger/auxiliary",
    method: "GET",
    user: adminUser,
    query: { companyId: 1, year: "2026", month: "01", from: "1101-001", to: "4101-001" },
    readBody: async () => ({}),
  });
  assert.equal(auxRes.body.auxiliary.accounts.length, 2);

  // Tipo de cambio y Estados Financieros en USD
  await handleLedgerRoute({
    route: "/api/ledger/exchange-rates",
    method: "POST",
    user: adminUser,
    query: { companyId: 1 },
    readBody: async () => ({ rateDate: "2026-01-15", rate: 25, notes: "Tasa prueba" }),
  });

  const stmtUsd = await handleLedgerRoute({
    route: "/api/ledger/statements",
    method: "GET",
    user: adminUser,
    query: { companyId: 1, period: "2026-01", currency: "USD" },
    readBody: async () => ({}),
  });
  assert.equal(stmtUsd.body.statements.incomeStatement.income, 100);
});

test("Nomina NOI: datos del trabajador, conceptos P001/D001, recibo PDF, acumulados y cierre de periodo", async () => {
  await ensureAuthTables();
  await ensureEmployeesTable();
  await ensurePayrollTables();

  const emp = await createEmployee(adminUser, {
    companyId: 1,
    firstName: "Gabriel",
    lastName: "Mejia",
    secondLastName: "Lopez",
    email: "gabriel.nomina@vicmar.hn",
    gender: "Masculino",
    position: "Supervisor de Corte",
    branch: "Sucursal Principal",
    systemRole: "Inventarios",
    baseSalary: 14000,
    paymentFrequency: "Quincenal",
    bankAccount: "2000-1111-2222",
    payrollEmailEnabled: "SI",
  });
  assert.equal(emp.baseSalary, 14000);
  assert.equal(emp.payrollEmailEnabled, true);

  // Crear conceptos P002 y D001
  const pRes = await handlePayrollRoute({
    route: "/api/payroll/concepts",
    method: "POST",
    user: adminUser,
    query: { companyId: 1 },
    readBody: async () => ({ conceptType: "P", conceptNumber: 2, description: "Bono de Puntualidad", integratesSalary: "Si" }),
  });
  assert.equal(pRes.body.concept.conceptKey, "P002");

  const dRes = await handlePayrollRoute({
    route: "/api/payroll/concepts",
    method: "POST",
    user: adminUser,
    query: { companyId: 1 },
    readBody: async () => ({ conceptType: "D", conceptNumber: 1, description: "Cuota IHSS", integratesSalary: "No" }),
  });
  assert.equal(dRes.body.concept.conceptKey, "D001");

  // Emitir nomina
  const recRes = await handlePayrollRoute({
    route: "/api/payroll/receipts",
    method: "POST",
    user: adminUser,
    query: { companyId: 1 },
    readBody: async () => ({
      employeeId: emp.id,
      period: "2026-02",
      paymentFrequency: "Quincenal",
      payDate: "2026-02-15",
      baseSalary: 7000,
      bankAccount: "2000-1111-2222",
      lines: [
        { conceptKey: "P002", conceptType: "P", description: "Bono de Puntualidad", amount: 500 },
        { conceptKey: "D001", conceptType: "D", description: "Cuota IHSS", amount: 350 },
      ],
    }),
  });
  assert.equal(recRes.status, 201);
  assert.equal(recRes.body.receipt.netPay, 7150);

  // Descargar PDF del recibo
  const pdfRes = await handlePayrollRoute({
    route: `/api/payroll/receipts/${recRes.body.receipt.id}/pdf`,
    method: "GET",
    user: adminUser,
    query: { companyId: 1 },
    readBody: async () => ({}),
  });
  assert.equal(pdfRes.contentType, "application/pdf");
  assert.ok(pdfRes.raw.length > 500, "El PDF del recibo debe generarse con contenido");

  // Acumulados
  const accRes = await handlePayrollRoute({
    route: "/api/payroll/accumulated",
    method: "GET",
    user: adminUser,
    query: { companyId: 1, from: "2026-01", to: "2026-12" },
    readBody: async () => ({}),
  });
  assert.equal(accRes.body.accumulated.byEmployee.length, 1);
  assert.equal(accRes.body.accumulated.byEmployee[0].netPay, 7150);

  // Cierre de periodo -> No permitir mas nominas
  await handlePayrollRoute({
    route: "/api/payroll/closures",
    method: "POST",
    user: adminUser,
    query: { companyId: 1 },
    readBody: async () => ({ period: "2026-02", notes: "Cierre Febrero 2026" }),
  });

  await assert.rejects(
    () =>
      handlePayrollRoute({
        route: "/api/payroll/receipts",
        method: "POST",
        user: adminUser,
        query: { companyId: 1 },
        readBody: async () => ({
          employeeId: emp.id,
          period: "2026-02",
          payDate: "2026-02-28",
          baseSalary: 7000,
        }),
      }),
    /CERRADO/i
  );
});
