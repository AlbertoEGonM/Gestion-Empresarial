const reportType = document.querySelector("#report-type");
const reportPeriod = document.querySelector("#report-period");
const reportCompanyField = document.querySelector("#report-company-field");
const reportCompany = document.querySelector("#report-company");
const reportStatus = document.querySelector("#report-status");
const paper = document.querySelector("#accounting-paper");
let currentReport = null;

const typeFromUrl = new URLSearchParams(window.location.search).get("tipo");
if ([...reportType.options].some((option) => option.value === typeFromUrl)) reportType.value = typeFromUrl;
const sessionUser = window.gestionUserDb.getCurrentUser();
document.querySelector("#current-date").textContent = new Intl.DateTimeFormat(sessionUser?.locale || "es-HN", { day: "numeric", month: "long", year: "numeric" }).format(new Date());

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function money(value) {
  return Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percent(value, base) {
  return base ? `${((Number(value) / Number(base)) * 100).toFixed(2)}` : "0.00";
}

function periodLabel(period, locale = "es-HN") {
  const [year, month] = period.split("-");
  return new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(`${year}-${month}-01T12:00:00Z`)).replace(".", "");
}

function documentHeader(report, title) {
  return `<header class="paper-header"><h2>${escapeHtml(report.company.name)}</h2><div><span><b>Direccion:</b> ${escapeHtml(report.company.city)}, ${escapeHtml(report.company.country_name)}</span><span><b>${escapeHtml(report.company.tax_id_label)}:</b> ${escapeHtml(report.company.tax_id)}</span><span><b>Pais:</b> ${escapeHtml(report.company.country_name)}</span><span><b>Moneda:</b> ${escapeHtml(report.company.currency_code)}</span></div><h1>${title}</h1></header>`;
}

function documentFooter(pageNumber = 1, totalPages = 1) {
  const user = window.gestionUserDb.getCurrentUser();
  return `<footer class="paper-footer"><span>Usuario: ${escapeHtml(user?.username || "ADMINISTRADOR")}</span><span>Fecha y hora: ${new Intl.DateTimeFormat(user?.locale || "es-HN", { dateStyle: "short", timeStyle: "short" }).format(new Date())}</span><span>Pag. ${pageNumber}${totalPages > 1 ? ` / ${totalPages}` : ""}</span></footer>`;
}

function chunks(rows, size) {
  if (!Array.isArray(rows) || rows.length === 0) return [[]];
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, (index + 1) * size));
}

function dateOnly(value, locale = "es-HN") {
  if (!value) return "-";
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

function statementRow(label, amount, base, className = "") {
  return `<tr class="${className}"><td>${label}</td><td>${money(amount)}</td><td>${percent(amount, base)}</td><td>${money(amount)}</td><td>${percent(amount, base)}</td></tr>`;
}

function renderIncomeStatement(report) {
  const label = periodLabel(report.period, report.company.locale);
  paper.className = "accounting-paper report-portrait";
  paper.innerHTML = `${documentHeader(report, `Estado de resultados a ${label}`)}<table class="paper-table statement-table"><thead><tr><th></th><th>Este mes</th><th>% ventas</th><th>Acum. este mes</th><th>% ventas</th></tr></thead><tbody>
    <tr class="section-row"><td colspan="5">Ingresos</td></tr>${statementRow("VENTAS", report.income, report.income)}${statementRow("Total de ingresos", report.income, report.income, "total-row")}
    <tr class="section-row"><td colspan="5">Costos</td></tr>${statementRow("COSTO DE VENTAS", report.cost, report.income)}${statementRow("Costo total", report.cost, report.income, "total-row")}
    ${statementRow("Utilidad bruta", report.grossProfit, report.income, "grand-total")}
    <tr class="section-row"><td colspan="5">Gastos generales</td></tr>${statementRow("GASTOS GENERALES", report.expenses, report.income)}${statementRow("Total de gastos generales", report.expenses, report.income, "total-row")}
    ${statementRow("Utilidad de operacion", report.operatingProfit, report.income, "grand-total")}
    <tr class="section-row"><td colspan="5">Otros ingresos y gastos</td></tr>${statementRow("PRODUCTOS FINANCIEROS", report.otherIncome, report.income)}${statementRow("GASTOS FINANCIEROS", report.otherExpense, report.income)}
    ${statementRow("Impuestos", report.taxes, report.income, "total-row")}${statementRow("Utilidad neta", report.netProfit, report.income, "grand-total")}
    </tbody></table>${documentFooter()}`;
}

function balanceRows(title, rows, totalLabel, total) {
  const bodyRows = rows.length
    ? rows.map((row) => `<tr><td class="indent">${escapeHtml(row.name)}</td><td>${money(row.amount)}</td><td>${money(row.amount)}</td><td></td></tr>`).join("")
    : `<tr><td class="indent" colspan="4">Sin saldos registrados</td></tr>`;
  return `<tr class="section-row"><td colspan="4">${title}</td></tr>${bodyRows}<tr class="total-row"><td>${totalLabel}</td><td>${money(total)}</td><td>${money(total)}</td><td></td></tr>`;
}

function renderBalanceSheet(report) {
  const label = periodLabel(report.period, report.company.locale);
  paper.className = "accounting-paper report-portrait";
  paper.innerHTML = `${documentHeader(report, `Balance general a ${label}`)}<table class="paper-table balance-table"><thead><tr><th>Cuenta</th><th>${label}</th><th>Periodo anterior</th><th>%</th></tr></thead><tbody>
    <tr class="major-row"><td colspan="4">ACTIVO</td></tr>${balanceRows("Activo circulante", report.sections.currentAssets, "Total de activo circulante", report.totals.currentAssets)}${balanceRows("Activo no circulante", report.sections.nonCurrentAssets, "Total de activo no circulante", report.totals.nonCurrentAssets)}<tr class="grand-total"><td>Total de activo</td><td>${money(report.totals.assets)}</td><td>${money(report.totals.assets)}</td><td>0.00</td></tr>
    <tr class="major-row"><td colspan="4">PASIVO Y CAPITAL CONTABLE</td></tr>${balanceRows("Pasivo a corto plazo", report.sections.currentLiabilities, "Total de pasivo a corto plazo", report.totals.currentLiabilities)}${balanceRows("Pasivo a largo plazo", report.sections.longLiabilities, "Total de pasivo a largo plazo", report.totals.longLiabilities)}${balanceRows("Capital contable", report.sections.equity, "Total de capital contable", report.totals.equity)}<tr class="grand-total"><td>Total de pasivo y capital</td><td>${money(report.totals.liabilitiesAndEquity)}</td><td>${money(report.totals.liabilitiesAndEquity)}</td><td>0.00</td></tr>
    </tbody></table>${documentFooter()}`;
}

function renderTrialBalance(report) {
  const label = periodLabel(report.period, report.company.locale);
  paper.className = "accounting-paper report-landscape";
  const bodyRows = report.rows.length
    ? report.rows.map((row) => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td>${money(row.opening)}</td><td>${money(row.debit)}</td><td>${money(row.credit)}</td><td>${money(row.closing)}</td></tr>`).join("")
    : `<tr><td colspan="6">Sin cuentas contables con movimientos en el periodo seleccionado.</td></tr>`;
  paper.innerHTML = `${documentHeader(report, `Balanza de comprobacion al ${label}`)}<p class="paper-note">Tipos de monedas: Todas</p><table class="paper-table trial-table"><thead><tr><th>No. de cuenta</th><th>Descripcion</th><th>Saldo inicial</th><th>Debe</th><th>Haber</th><th>Saldo final</th></tr></thead><tbody>${bodyRows}<tr class="grand-total"><td colspan="2">${report.rows.length} cuentas reportadas - Totales</td><td>${money(report.totals.opening)}</td><td>${money(report.totals.debit)}</td><td>${money(report.totals.credit)}</td><td>${money(report.totals.closing)}</td></tr></tbody></table>${documentFooter()}`;
}

function renderPayrollCatalog(report) {
  const pages = chunks(report.concepts, 18);
  paper.className = "accounting-paper-stack report-landscape-stack";
  paper.innerHTML = pages.map((concepts, pageIndex) => {
    const bodyRows = concepts.length
      ? concepts.map((row) => `<tr><td>${escapeHtml(row.concept_key)}</td><td>${escapeHtml(row.description)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.integrates_salary)}</td><td>${escapeHtml(row.calculation_scope)}</td><td>${escapeHtml(row.benefit)}</td><td>${escapeHtml(row.movement_type)}</td><td>${money(row.accumulated)}</td></tr>`).join("")
      : `<tr><td colspan="8">Sin conceptos de nomina registrados en el periodo seleccionado.</td></tr>`;
    return `<article class="accounting-paper report-landscape report-page">${documentHeader(report, `Reporte del catalogo de percepciones y deducciones - ${report.company.country_name}`)}<table class="paper-table payroll-table"><thead><tr><th>Clave</th><th>Descripcion</th><th>Estado</th><th>Integra salario</th><th>Gral./Ind.</th><th>Prestacion</th><th>Fija/Variable</th><th>Acum. periodo</th></tr></thead><tbody>${bodyRows}</tbody></table><p class="paper-note">Los acumulados no incluyen conceptos fuera del periodo seleccionado.</p>${documentFooter(pageIndex + 1, pages.length)}</article>`;
  }).join("");
}

function renderSalesProfit(report) {
  const pages = chunks(report.rows, 32);
  const margin = report.totals.price ? (report.totals.utility / report.totals.price) * 100 : 0;
  const utilityPercent = report.totals.cost ? (report.totals.utility / report.totals.cost) * 100 : 0;
  paper.className = "accounting-paper-stack report-portrait-stack";
  paper.innerHTML = pages.map((rows, pageIndex) => {
    const bodyRows = rows.length
      ? rows.map((row) => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.description)}</td><td>${money(row.quantity)}</td><td>${money(row.cost)}</td><td>${money(row.price)}</td><td>${money(row.utility)}</td><td>${money(row.utilityPercent)}</td><td>${money(row.margin)}</td></tr>`).join("")
      : `<tr><td colspan="8">Sin ventas de tela registradas en el periodo seleccionado.</td></tr>`;
    return `<article class="accounting-paper report-portrait report-page sales-profit-page">${documentHeader(report, "Ventas y utilidad")}<div class="paper-filter-grid"><span><b>Producto:</b> ${report.filters.product}</span><span><b>Tipo de documento:</b> ${report.filters.documentType}</span><span><b>Cliente:</b> ${report.filters.customer}</span><span><b>Periodo:</b> ${periodLabel(report.period, report.company.locale)}</span><span><b>Vendedor:</b> ${report.filters.seller}</span><span><b>Moneda:</b> ${report.filters.currency}</span></div><table class="paper-table sales-profit-table"><thead><tr><th>Producto</th><th>Descripcion</th><th>Cantidad</th><th>Costo total</th><th>Precio total</th><th>Utilidad</th><th>% Utilidad</th><th>Margen</th></tr></thead><tbody>${bodyRows}${pageIndex === pages.length - 1 ? `<tr class="grand-total"><td colspan="2">Totales</td><td>${money(report.totals.quantity)}</td><td>${money(report.totals.cost)}</td><td>${money(report.totals.price)}</td><td>${money(report.totals.utility)}</td><td>${money(utilityPercent)}</td><td>${money(margin)}</td></tr>` : ""}</tbody></table>${documentFooter(pageIndex + 1, pages.length)}</article>`;
  }).join("");
}

function renderPurchaseInvoice(report) {
  const pages = chunks(report.lines, 10);
  const total = report.totals.subtotal + report.totals.tax;
  paper.className = "accounting-paper-stack report-portrait-stack";
  paper.innerHTML = pages.map((lines, pageIndex) => {
    const bodyRows = lines.length
      ? lines.map((row) => `<tr><td>${escapeHtml(row.workOrder)}</td><td>${escapeHtml(row.styleCode)}</td><td>${escapeHtml(row.description)}</td><td>${escapeHtml(row.color)}</td><td>${escapeHtml(row.unit)}</td><td>${money(row.quantity)}</td><td>${money(row.unitPrice)}</td><td>${money(row.total)}</td></tr>`).join("")
      : `<tr><td colspan="8">Sin partidas de compra registradas en el periodo.</td></tr>`;
    return `<article class="accounting-paper report-portrait report-page purchase-invoice-page"><header class="invoice-header"><div><strong>${escapeHtml(report.invoice.supplier)}</strong><span>Documento de proveedor</span></div><div><b>FACTURA No.</b><strong>${escapeHtml(report.invoice.number)}</strong><span>Pagina ${pageIndex + 1} / ${pages.length}</span></div></header><section class="invoice-meta"><div><b>COMPRADOR</b><strong>${escapeHtml(report.company.name)}</strong><span>${escapeHtml(report.company.tax_id_label)} ${escapeHtml(report.company.tax_id)}</span><span>${escapeHtml(report.company.city)}, ${escapeHtml(report.company.country_name)}</span></div><div><span><b>Fecha emision:</b> ${dateOnly(report.invoice.issueDate, report.company.locale)}</span><span><b>Vencimiento:</b> ${dateOnly(report.invoice.dueDate, report.company.locale)}</span><span><b>Condicion:</b> Pago de contado</span><span><b>Estatus:</b> ${escapeHtml(report.invoice.status)}</span></div><div><span><b>Peso neto:</b> ${money(report.invoice.netWeight)}</span><span><b>Peso bruto:</b> ${money(report.invoice.grossWeight)}</span><span><b>Moneda:</b> ${escapeHtml(report.invoice.currency)}</span></div></section><table class="paper-table purchase-invoice-table"><thead><tr><th>Orden</th><th>Estilo</th><th>Descripcion</th><th>Color</th><th>Unidad</th><th>Cantidad</th><th>Precio unit.</th><th>Importe</th></tr></thead><tbody>${bodyRows}</tbody></table>${pageIndex === pages.length - 1 ? `<section class="invoice-totals"><span>Subtotal <b>${report.invoice.currency} ${money(report.totals.subtotal)}</b></span><span>${report.company.country_code === "MX" ? "IVA" : "ISV"} ${money(report.company.tax_rate)}% <b>${money(report.totals.tax)}</b></span><span>Total <strong>${report.invoice.currency} ${money(total)}</strong></span></section>` : ""}<p class="invoice-note">Mercancia recibida sujeta a revision de cantidad, peso y calidad. Documento asociado a la recepcion de compra.</p>${documentFooter(pageIndex + 1, pages.length)}</article>`;
  }).join("");
}

function renderReport(report) {
  currentReport = report;
  document.querySelector("#report-page-size").textContent = report.type === "trial-balance" || report.type === "payroll-catalog" ? "@page { size: A4 landscape; margin: 8mm; }" : "@page { size: A4 portrait; margin: 10mm; }";
  if (report.type === "income-statement") renderIncomeStatement(report);
  if (report.type === "balance-sheet") renderBalanceSheet(report);
  if (report.type === "trial-balance") renderTrialBalance(report);
  if (report.type === "payroll-catalog") renderPayrollCatalog(report);
  if (report.type === "sales-profit") renderSalesProfit(report);
  if (report.type === "purchase-invoice") renderPurchaseInvoice(report);
}

async function loadReport() {
  reportStatus.hidden = false;
  reportStatus.textContent = "Generando documento...";
  try {
    const report = await window.gestionUserDb.getAccountingReport(reportType.value, reportPeriod.value, reportCompany.value);
    renderReport(report);
    reportStatus.hidden = true;
  } catch (error) {
    reportStatus.textContent = error.message;
  }
}

function downloadCsv() {
  if (!currentReport) return;
  const rows = [...paper.querySelectorAll("table tr")].map((row) => [...row.children].map((cell) => `"${cell.textContent.trim().replaceAll('"', '""')}"`).join(","));
  const blob = new Blob([`\ufeff${rows.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${currentReport.type}-${currentReport.period}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function initialize() {
  const user = window.gestionUserDb.getCurrentUser();
  if (user?.isGlobalAdmin) {
    const companies = await window.gestionUserDb.listCompanies();
    reportCompany.innerHTML = companies.map((company) => `<option value="${company.id}"${company.id === user.companyId ? " selected" : ""}>${escapeHtml(company.name)}</option>`).join("");
    reportCompanyField.hidden = false;
  }
  await loadReport();
}

reportType.addEventListener("change", loadReport);
reportPeriod.addEventListener("change", loadReport);
reportCompany.addEventListener("change", loadReport);
function downloadExcel() {
  if (!currentReport || !window.gestionExport) return;
  const table = paper.querySelector("table");
  const { columns, rows } = window.gestionExport.tableData(table, { skipColumns: [] });
  window.gestionExport.toExcel({
    filename: `${currentReport.type}-${currentReport.period}`,
    sheetName: "Reporte",
    title: reportType.selectedOptions[0]?.textContent || "Reporte Contable",
    subtitle: `Periodo: ${currentReport.period}`,
    columns,
    rows,
  });
}

document.querySelector("#report-excel")?.addEventListener("click", downloadExcel);
document.querySelector("#report-print").addEventListener("click", () => window.print());
document.querySelector("#report-csv").addEventListener("click", downloadCsv);
initialize().catch((error) => { reportStatus.textContent = error.message; });
