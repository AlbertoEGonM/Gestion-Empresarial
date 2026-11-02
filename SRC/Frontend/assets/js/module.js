const modules = window.TEXTILES_MODULES || {};
const reports = window.TEXTILES_REPORTS || [];
const guides = window.TEXTILES_GUIDES || [];
const params = new URLSearchParams(window.location.search);
const requestedModule = params.get("modulo") || "compras";
const redirects = { administrador: "./admin.html", actividad: "./bitacora.html", configuracion: "./configuracion.html" };
const moduleSessionUser = window.gestionUserDb.getCurrentUser() || {};

const STORAGE_PREFIX = "textiles-clean-v2";

(function purgeLegacyLocalStorage() {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith("textiles-gh-")) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (error) {
    // Ignore storage access errors
  }
})();

function activeUser() {
  return window.gestionUserDb.getCurrentUser() || moduleSessionUser || {};
}

function activeCompanyId() {
  return Number(activeUser().companyId || 1);
}

function localizeBusinessText(value) {
  let text = String(value ?? "");
  if (activeUser().countryCode === "MX") {
    text = text.replaceAll("RTN", "RFC").replaceAll("HNL", "MXN").replaceAll("ISV", "IVA").replaceAll("SAR", "SAT");
    text = text.replace(/(^|\s)L\s(?=\d)/g, "$1$ ");
    text = text.replace(/lempiras/gi, "pesos mexicanos");
  }
  return text;
}

if (redirects[requestedModule]) window.location.replace(redirects[requestedModule]);

const currentKey = modules[requestedModule] ? requestedModule : "compras";
const currentModule = modules[currentKey];

function getModulePermissionConfig(modKey = currentKey) {
  const u = activeUser();
  if (u?.isGlobalAdmin || u?.role === "Administrador") {
    return {
      actions: [true, true, true, true],
      views: Object.keys(modules[modKey]?.views || {}),
    };
  }
  const modPerm = u?.permissions?.[modKey];
  if (modPerm && Array.isArray(modPerm.actions)) {
    const allViews = Object.keys(modules[modKey]?.views || {});
    const allowedViews = Array.isArray(modPerm.views)
      ? modPerm.views.filter((v) => allViews.includes(v))
      : allViews;
    return {
      actions: [
        Boolean(modPerm.actions[0]),
        Boolean(modPerm.actions[1]),
        Boolean(modPerm.actions[2]),
        Boolean(modPerm.actions[3]),
      ],
      views: allowedViews,
    };
  }
  return {
    actions: [true, true, true, false],
    views: Object.keys(modules[modKey]?.views || {}),
  };
}

const currentPermConfig = getModulePermissionConfig(currentKey);
const requestedView = params.get("vista");
const resolvedDefaultView = currentPermConfig.views.includes(currentModule.defaultView)
  ? currentModule.defaultView
  : currentPermConfig.views[0] || currentModule.defaultView;
const currentViewKey =
  currentModule.views[requestedView] && currentPermConfig.views.includes(requestedView)
    ? requestedView
    : resolvedDefaultView;
const currentView = currentModule.views[currentViewKey];
const storageKey = rowsStorageKey(currentKey, currentViewKey);
const metricsContainer = document.querySelector("#module-metrics");
const tabs = document.querySelector("#module-tabs");
const toolbar = document.querySelector("#module-toolbar");
const searchInput = document.querySelector("#module-search");
const filterControl = document.querySelector(".module-filter");
const filterInput = document.querySelector("#module-filter");
const view = document.querySelector("#module-view");
const actionButton = document.querySelector("#module-primary-action");
const dialog = document.querySelector("#module-dialog");
const form = document.querySelector("#module-form");
const formFields = document.querySelector("#module-form-fields");
const formError = document.querySelector("#module-form-error");
const toast = document.querySelector("#module-toast");

function rowsWithSerialPlaceholder(datasetRows, viewDefinition = currentView) {
  if (!viewDefinition.columns) return datasetRows;
  const expectedDataColumns = viewDefinition.columns.length;
  return datasetRows.map((row) => (row.length >= expectedDataColumns ? row : [...row, "Asignando..."]));
}

let rows = rowsWithSerialPlaceholder(loadRows(currentKey, currentViewKey, currentView.rows || []));
let editIndex = null;
let posCart = [];
let posTaxName = activeUser().countryCode === "MX" ? "IVA" : "ISV";
let posTaxRate = Number(activeUser().taxRate ?? (activeUser().countryCode === "MX" ? 16 : 15));
let posPriceListIndex = 0;
const PRICE_LIST_NAMES = ["1. Precio Publico", "2. Precio Mayoreo", "3. Precio Distribuidor", "4. Precio Especial 1", "5. Precio Especial 2"];

function formatWeightConversion(qtyValue, unitValue) {
  const qty = numericValue(qtyValue);
  const u = String(unitValue || "").toLowerCase();
  if (!qty) return "";
  if (u.includes("libra") || u === "lb") return ` lb (${(qty * 0.453592).toFixed(2)} kg)`;
  return ` kg (${(qty * 2.20462).toFixed(2)} lb)`;
}

function formatPriceConversion(priceValue, unitValue) {
  const price = numericValue(priceValue);
  if (!price) return "";
  const isLb = String(unitValue || "").toLowerCase().includes("libra") || String(unitValue || "").toLowerCase() === "lb";
  const otherPrice = isLb ? price * 2.20462 : price / 2.20462;
  const otherUnit = isLb ? "kg" : "lb";
  return ` (${currency(otherPrice, 2)}/${otherUnit})`;
}

function formatInlineWeightText(value) {
  const str = String(value ?? "");
  if (!str || /\(\d+(?:[.,]\d+)?\s*(?:kg|lb)\)/i.test(str)) return str;
  const kgMatch = str.match(/^(\s*[+-]?\d+(?:[.,]\d+)?)\s*(?:kg|kilos?|kilogramos?)\b(.*)$/i);
  if (kgMatch) {
    const n = numericValue(kgMatch[1]);
    return `${n.toFixed(2)} kg (${(n * 2.20462).toFixed(2)} lb)${kgMatch[2] || ""}`;
  }
  const lbMatch = str.match(/^(\s*[+-]?\d+(?:[.,]\d+)?)\s*(?:lb|lbs|libras?)\b(.*)$/i);
  if (lbMatch) {
    const n = numericValue(lbMatch[1]);
    return `${n.toFixed(2)} lb (${(n * 0.453592).toFixed(2)} kg)${lbMatch[2] || ""}`;
  }
  return str;
  return "";
}

function rowsStorageKey(moduleKey, viewKey) {
  return `${STORAGE_PREFIX}-c${activeCompanyId()}-${moduleKey}-${viewKey}-rows`;
}

function normalizeDatasetRows(moduleKey, viewKey, datasetRows) {
  if (!Array.isArray(datasetRows)) return [];
  if (moduleKey === "inventarios" && viewKey === "productos") {
    return datasetRows.map((row) => {
      if (row.length === 13) {
        return [row[0], row[1], row[3], row[5], row[6], row[7], row[11], row[12]];
      }
      const normRow = row.length === 13 ? [row[0], row[1], row[3], row[5], row[6], row[7], row[11], row[12]] : [...row];
      if (normRow.length >= 4) {
        normRow[3] = String(normRow[3] || "").toLowerCase().includes("libra") || String(normRow[3] || "").toLowerCase() === "lb" ? "Libra (lb)" : "Kilogramo (kg)";
      }
      return normRow;
    });
  }
  return datasetRows;
}

function loadRows(moduleKey, viewKey, defaults = []) {
  try {
    const saved = JSON.parse(localStorage.getItem(rowsStorageKey(moduleKey, viewKey)));
    if (Array.isArray(saved)) {
      return normalizeDatasetRows(moduleKey, viewKey, saved);
    }
  } catch (error) {
    // Fallback a filas base de la vista
  }
  return normalizeDatasetRows(
    moduleKey,
    viewKey,
    defaults.map((row) => row.map((cell) => localizeBusinessText(cell)))
  );
}

async function saveRows() {
  localStorage.setItem(storageKey, JSON.stringify(rows));
  try {
    const saved = await window.gestionUserDb.saveDataset(currentKey, currentViewKey, rows, activeCompanyId());
    rows = rowsWithSerialPlaceholder(normalizeDatasetRows(currentKey, currentViewKey, saved.rows));
    localStorage.setItem(storageKey, JSON.stringify(rows));
    refreshDataView();
  } catch (error) {
    showToast(`${error.message} Los cambios quedaron guardados localmente.`, true);
  }
}

async function syncDataset() {
  try {
    const dataset = await window.gestionUserDb.getDataset(currentKey, currentViewKey, activeCompanyId());
    if (dataset.initialized && Array.isArray(dataset.rows)) {
      rows = rowsWithSerialPlaceholder(normalizeDatasetRows(currentKey, currentViewKey, dataset.rows));
      if (rows.some((row) => row.at(-1) === "Asignando...")) {
        const saved = await window.gestionUserDb.saveDataset(currentKey, currentViewKey, rows, activeCompanyId());
        rows = rowsWithSerialPlaceholder(normalizeDatasetRows(currentKey, currentViewKey, saved.rows));
      }
    } else {
      rows = [];
    }
    localStorage.setItem(storageKey, JSON.stringify(rows));

    if (typeof currentView.metrics === "string") {
      const relatedDatasets = metricDependencies(currentView.metrics).filter(
        ([moduleKey, viewKey]) => moduleKey !== currentKey || viewKey !== currentViewKey
      );
      await Promise.all(
        relatedDatasets.map(async ([moduleKey, viewKey]) => {
          try {
            const related = await window.gestionUserDb.getDataset(moduleKey, viewKey, activeCompanyId());
            const cleanRelated = related.initialized && Array.isArray(related.rows)
              ? normalizeDatasetRows(moduleKey, viewKey, related.rows)
              : [];
            localStorage.setItem(rowsStorageKey(moduleKey, viewKey), JSON.stringify(cleanRelated));
          } catch (error) {
            // Conserva copia local en caso de error de red puntual.
          }
        })
      );
    }
    renderMetrics();
    renderFilterOptions();
    renderTable();
  } catch (error) {
    showToast(`${error.message} Se muestran los datos disponibles en este navegador.`, true);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, isError = false) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("error", Boolean(isError));
  toast.hidden = false;
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function navigate(moduleKey, viewKey) {
  window.location.href = `./modulo.html?modulo=${encodeURIComponent(moduleKey)}&vista=${encodeURIComponent(viewKey)}`;
}

function renderTabs() {
  const perm = getModulePermissionConfig(currentKey);
  const entries = Object.entries(currentModule.views).filter(([key]) => perm.views.includes(key));
  tabs.hidden = entries.length < 2;
  tabs.innerHTML = entries
    .map(
      ([key, section]) =>
        `<a href="./modulo.html?modulo=${escapeHtml(currentKey)}&vista=${escapeHtml(key)}"${
          key === currentViewKey ? ' class="active" aria-current="page"' : ""
        }>${escapeHtml(section.label)}</a>`
    )
    .join("");
}

function numericValue(value) {
  const normalized = String(value ?? "").replace(/[^\d,.-]/g, "").replaceAll(",", "");
  return Number.parseFloat(normalized) || 0;
}

function purchaseRows(viewKey) {
  if (currentKey === "compras" && viewKey === currentViewKey) return rows;
  const viewDefinition = modules.compras?.views?.[viewKey];
  return loadRows("compras", viewKey, viewDefinition?.rows || []);
}

function moduleRows(moduleKey, viewKey) {
  if (currentKey === moduleKey && viewKey === currentViewKey) return rows;
  const viewDefinition = modules[moduleKey]?.views?.[viewKey];
  return loadRows(moduleKey, viewKey, viewDefinition?.rows || []);
}

function metricDependencies(metricType) {
  const dependencies = {
    "purchase-suppliers": [["compras", "proveedores"]],
    "purchase-orders": [["compras", "proveedores"], ["compras", "ordenes"], ["compras", "recepciones"]],
    "purchase-payables": [["compras", "pagos"]],
    "sales-clients": [["ventas", "clientes"], ["ventas", "cobranza"]],
    "sales-invoices": [["ventas", "clientes"], ["ventas", "pedidos"], ["ventas", "facturas"]],
    "sales-receivables": [["ventas", "cobranza"]],
    "inventory-products": [["inventarios", "productos"], ["inventarios", "almacenes"]],
    "accounting-summary": [["contabilidad", "bancos"], ["contabilidad", "movimientos"], ["ventas", "cobranza"], ["compras", "pagos"]],
    "cost-analysis": [["costos", "hojas"], ["costos", "margenes"], ["inventarios", "productos"]],
    "global-reports": [["ventas", "facturas"], ["inventarios", "productos"], ["compras", "ordenes"], ["contabilidad", "movimientos"]],
  };
  return dependencies[metricType] || [];
}

function currency(value, decimals = 0) {
  const u = activeUser();
  return `${u.currencySymbol || "L"} ${Number(value || 0).toLocaleString(u.locale || "es-HN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function totalAt(data, index) {
  return data.reduce((sum, row) => sum + numericValue(row[index]), 0);
}

function operationalMetrics(metricType) {
  const u = activeUser();
  if (metricType === "inventory-products") {
    const products = moduleRows("inventarios", "productos");
    const warehouses = moduleRows("inventarios", "almacenes").filter((row) => /activo/i.test(row[6]));
    const active = products.filter((row) => /activo/i.test(row[6]));
    const lowStock = products.filter((row) => /bajo minimo|existencia negativa/i.test(row[6]));
    const activeProducts = products.filter((row) => !/inactivo/i.test(row[6]));
    const totalKg = activeProducts.reduce((sum, row) => {
      const q = numericValue(row[4]);
      const isLb = String(row[3] || "").toLowerCase().includes("libra");
      return sum + (isLb ? q * 0.453592 : q);
    }, 0);
    const totalLb = totalKg * 2.20462;
    const negativeStock = products.filter((row) => numericValue(row[4]) < 0);
    const categories = new Set(active.map((row) => row[2]).filter(Boolean)).size;
    return [
      ["Productos activos", String(active.length), `${categories} categorias textiles`],
      ["Existencia total", `${totalKg.toLocaleString(u.locale || "es-HN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`, `Equivale a ${totalLb.toLocaleString(u.locale || "es-HN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} lb (${warehouses.length} almacenes)`],
      ["Bajo minimo", String(lowStock.length), "Requieren abastecimiento"],
      ["Existencia negativa", String(negativeStock.length), negativeStock.length ? "Requiere regularizacion" : "Inventario regularizado"],
    ];
  }

  if (metricType === "accounting-summary") {
    const bankRows = moduleRows("contabilidad", "bancos");
    const journalRows = moduleRows("contabilidad", "movimientos");
    const receivables = moduleRows("ventas", "cobranza").filter((row) => !/pagado/i.test(row[6]));
    const payables = moduleRows("compras", "pagos").filter((row) => !/pagado/i.test(row[6]));
    const reconciled = bankRows.filter((row) => /conciliado/i.test(row[6]));
    const balance = totalAt(bankRows, 5);
    return [
      ["Saldo en bancos", currency(balance), `${reconciled.length} de ${bankRows.length} movimientos conciliados`],
      ["Cuentas por cobrar", currency(totalAt(receivables, 4)), `${receivables.length} facturas abiertas`],
      ["Cuentas por pagar", currency(totalAt(payables, 4)), `${payables.length} documentos pendientes`],
      ["Polizas contables", String(journalRows.length), "Movimientos registrados en el diario"],
    ];
  }

  if (metricType === "cost-analysis") {
    const sheets = moduleRows("costos", "hojas");
    const marginsList = moduleRows("costos", "margenes");
    const avgCost = sheets.length ? totalAt(sheets, 5) / sheets.length : 0;
    const avgTargetMargin = marginsList.length ? totalAt(marginsList, 3) / marginsList.length : 0;
    return [
      ["Hojas de costo", String(sheets.length), "Lotes textiles costeados"],
      ["Costo unitario prom.", currency(avgCost, 2), `Sobre ${sheets.length} hojas registradas`],
      ["Politicas de margen", String(marginsList.length), "Categorias configuradas"],
      ["Margen objetivo prom.", `${avgTargetMargin.toFixed(1)}%`, "Meta comercial configurada"],
    ];
  }

  if (metricType === "global-reports") {
    const invoices = moduleRows("ventas", "facturas");
    const products = moduleRows("inventarios", "productos");
    const orders = moduleRows("compras", "ordenes");
    return [
      ["Reportes disponibles", String(reports.length), "Listos para descarga en CSV"],
      ["Facturas emitidas", String(invoices.length), "En Ventas"],
      ["Telas en catalogo", String(products.length), "En Inventarios"],
      ["Ordenes de compra", String(orders.length), "En Compras"],
    ];
  }
  return [];
}

function salesMetrics(metricType) {
  const clients = moduleRows("ventas", "clientes");
  const orders = moduleRows("ventas", "pedidos");
  const invoices = moduleRows("ventas", "facturas");
  const receivables = moduleRows("ventas", "cobranza");
  const activeClients = clients.filter((row) => /activo/i.test(row[6]));
  const openInvoices = invoices.filter((row) => !/pagada|anulada/i.test(row[5]));
  const pendingOrders = orders.filter((row) => !/entregado|cancelado/i.test(row[7]));
  const openReceivables = receivables.filter((row) => !/pagado/i.test(row[6]));
  const dueSoon = openReceivables.filter((row) => /por vencer|parcial/i.test(row[6]));
  const overdue = openReceivables.filter((row) => /vencido/i.test(row[6]));
  const total = (data, index) => data.reduce((sum, row) => sum + numericValue(row[index]), 0);
  const fmtCurrency = (value) => currency(Math.round(value), 0);
  const invoiceSales = total(invoices.filter((row) => !/anulada/i.test(row[5])), 4);
  const authorizedCredit = total(clients, 4);
  const usedCredit = total(clients, 5);
  const portfolio = total(openReceivables, 4);
  const healthyPortfolio = total(openReceivables.filter((row) => !/vencido/i.test(row[6])), 4);

  if (metricType === "sales-clients") {
    return [
      ["Clientes activos", String(activeClients.length), `${clients.length} clientes registrados`],
      ["Credito autorizado", fmtCurrency(authorizedCredit), `${authorizedCredit ? Math.round((usedCredit / authorizedCredit) * 100) : 0}% utilizado`],
      ["Cartera al dia", `${portfolio ? Math.round((healthyPortfolio / portfolio) * 100) : 100}%`, `${overdue.length} documentos vencidos`],
      ["Retencion", `${clients.length ? Math.round((activeClients.length / clients.length) * 100) : 0}%`, "Clientes activos del total registrado"],
    ];
  }
  if (metricType === "sales-invoices") {
    return [
      ["Ventas registradas", fmtCurrency(invoiceSales), `${invoices.length} facturas emitidas`],
      ["Facturas abiertas", String(openInvoices.length), `${fmtCurrency(total(openInvoices, 4))} por cobrar`],
      ["Pedidos por facturar", String(pendingOrders.length), `${fmtCurrency(total(pendingOrders, 6))} en pedidos abiertos`],
      ["Ticket promedio", fmtCurrency(invoices.length ? invoiceSales / invoices.length : 0), `${activeClients.length} clientes activos`],
    ];
  }
  if (metricType === "sales-receivables") {
    return [
      ["Cartera total", fmtCurrency(portfolio), `${openReceivables.length} facturas abiertas`],
      ["Por vencer", fmtCurrency(total(dueSoon, 4)), `${dueSoon.length} documentos vigentes o parciales`],
      ["Vencido", fmtCurrency(total(overdue, 4)), `${new Set(overdue.map((row) => row[1])).size} clientes`],
      ["Saldo promedio", fmtCurrency(openReceivables.length ? portfolio / openReceivables.length : 0), "Por factura abierta"],
    ];
  }
  return [];
}

function purchaseMetrics(metricType) {
  const suppliers = purchaseRows("proveedores");
  const orders = purchaseRows("ordenes");
  const receipts = purchaseRows("recepciones");
  const payables = purchaseRows("pagos");
  const activeSuppliers = suppliers.filter((row) => String(row[6]).toLowerCase() === "activo");
  const openOrders = orders.filter((row) => !/recibida|cancelada/i.test(row[5]));
  const inTransit = orders.filter((row) => /transito/i.test(row[5]));
  const validReceipts = receipts.filter((row) => /validada/i.test(row[6]));
  const fmtCurrency = (value) => currency(Math.round(value), 0);

  if (metricType === "purchase-suppliers") {
    return [
      ["Proveedores activos", String(activeSuppliers.length), `${suppliers.length} proveedores registrados`],
      ["Credito disponible", fmtCurrency(suppliers.reduce((total, row) => total + numericValue(row[4]), 0)), `${suppliers.filter((row) => numericValue(row[4]) > 0).length} lineas autorizadas`],
      ["Con saldo abierto", String(suppliers.filter((row) => numericValue(row[5]) > 0).length), "Proveedores con saldo por pagar"],
      ["Saldo acumulado", fmtCurrency(suppliers.reduce((total, row) => total + numericValue(row[5]), 0)), "En cuentas de proveedores"],
    ];
  }
  if (metricType === "purchase-orders") {
    return [
      ["Ordenes abiertas", String(openOrders.length), `${openOrders.filter((row) => /pendiente|borrador/i.test(row[5])).length} en gestion`],
      ["En transito", fmtCurrency(inTransit.reduce((total, row) => total + numericValue(row[4]), 0)), `${inTransit.length} ordenes en camino`],
      ["Proveedores activos", String(activeSuppliers.length), `${suppliers.length} proveedores registrados`],
      ["Recepciones conformes", `${receipts.length ? Math.round((validReceipts.length / receipts.length) * 100) : 0}%`, `${validReceipts.length} de ${receipts.length} recepciones validadas`],
    ];
  }
  if (metricType === "purchase-payables") {
    const openPayables = payables.filter((row) => !/pagado/i.test(row[6]));
    const overdue = openPayables.filter((row) => /vencido/i.test(row[6]));
    const partial = openPayables.filter((row) => /parcial/i.test(row[6]));
    return [
      ["Saldo total", fmtCurrency(openPayables.reduce((total, row) => total + numericValue(row[4]), 0)), `${openPayables.length} documentos abiertos`],
      ["Por vencer", fmtCurrency(openPayables.filter((row) => /por vencer/i.test(row[6])).reduce((total, row) => total + numericValue(row[4]), 0)), "Segun documentos registrados"],
      ["Pagos parciales", fmtCurrency(partial.reduce((total, row) => total + numericValue(row[4]), 0)), `${partial.length} documentos con abonos`],
      ["Vencido", fmtCurrency(overdue.reduce((total, row) => total + numericValue(row[4]), 0)), `${overdue.length} documentos requieren atencion`],
    ];
  }
  return [];
}

function renderMetrics() {
  const dynamicMetrics = currentKey === "ventas" ? salesMetrics : currentKey === "compras" ? purchaseMetrics : operationalMetrics;
  let metrics = typeof currentView.metrics === "string" ? dynamicMetrics(currentView.metrics) : currentView.metrics || [];
  if (Array.isArray(currentView.metrics)) {
    metrics = currentView.metrics.map(([label, value, detail]) => [
      localizeBusinessText(label),
      localizeBusinessText(value),
      localizeBusinessText(detail),
    ]);
  }
  metricsContainer.innerHTML = metrics
    .map(
      ([label, value, detail]) =>
        `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`
    )
    .join("");
  metricsContainer.hidden = metrics.length === 0;
}

function statusClass(value) {
  const normalized = String(value).toLowerCase();
  if (/activo|activa|aprobada|recibida|pagada|registrado|conciliado|validada|liberado|aplicada|acreditada|completado|recomendada|vigente/.test(normalized)) return "complete";
  if (/transito|preparacion|enviada|parcial|revision|proceso|alternativa|temporal|listo/.test(normalized)) return "processing";
  return "pending";
}

function renderActions(index) {
  const perm = getModulePermissionConfig(currentKey);
  const canEdit = perm.actions[2];
  const canDelete = perm.actions[3];
  const actions = [];
  if (currentView.workflow && canEdit) {
    actions.push(
      `<button class="module-workflow-action" type="button" data-action="workflow" title="${escapeHtml(currentView.workflow.label)}">${escapeHtml(currentView.workflow.label)}</button>`
    );
  }
  if (currentView.fields) {
    if (canEdit) {
      actions.push('<button type="button" data-action="edit" title="Editar" aria-label="Editar"><img src="./assets/icons/inventory-edit.svg" alt="" /></button>');
    }
    if (canDelete) {
      actions.push('<button type="button" data-action="delete" title="Eliminar" aria-label="Eliminar"><img src="./assets/icons/inventory-delete.svg" alt="" /></button>');
    }
  }
  return `<span class="row-actions" data-index="${index}">${actions.join("")}</span>`;
}

function filteredRows() {
  const term = searchInput.value.trim().toLowerCase();
  const status = filterInput.value;
  const statusIndex = Number.isInteger(currentView.statusIndex) ? currentView.statusIndex : -1;
  const category = document.querySelector("#inventory-category-filter")?.value || "";
  const stock = document.querySelector("#inventory-stock-filter")?.value || "";
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      const quantity = currentKey === "inventarios" && currentViewKey === "productos" ? numericValue(row[4]) : 0;
      const matchesStock = !stock || (stock === "negative" ? quantity < 0 : stock === "positive" ? quantity > 0 : quantity === 0);
      return (
        row.join(" ").toLowerCase().includes(term) &&
        (!status || row[statusIndex] === status) &&
        (!category || row[2] === category) &&
        matchesStock
      );
    });
}

function renderTable() {
  const statusIndex = Number.isInteger(currentView.statusIndex) ? currentView.statusIndex : -1;
  const visibleRows = filteredRows();
  const displayColumns = [...currentView.columns];
  const hasActionsColumn = displayColumns.at(-1) === "Acciones";
  if (hasActionsColumn) {
    displayColumns.splice(-1, 0, "No. de serie");
  } else {
    displayColumns.push("No. de serie");
  }
  const expectedDataCells = hasActionsColumn ? displayColumns.length - 1 : displayColumns.length;

  const body = visibleRows
    .map(({ row, index }) => {
      const alignedRow = row.slice(0, expectedDataCells);
      while (alignedRow.length < expectedDataCells) {
        alignedRow.push(alignedRow.length === expectedDataCells - 1 ? "Asignando..." : "-");
      }
      const serialIndex = alignedRow.length - 1;
      const cells = alignedRow
        .map((cell, cellIndex) => {
          const isInvProd = currentKey === "inventarios" && currentViewKey === "productos";
          const weightNote = isInvProd && cellIndex === 4 ? escapeHtml(formatWeightConversion(cell, alignedRow[3])) : isInvProd && cellIndex === 5 ? escapeHtml(formatPriceConversion(cell, alignedRow[3])) : "";
          const baseText = isInvProd ? localizeBusinessText(cell) : formatInlineWeightText(localizeBusinessText(cell));
          const renderedText = escapeHtml(baseText) + weightNote;
          // baseText + weightNote already in renderedText
          if (cellIndex === statusIndex) {
            return `<span><b class="status ${statusClass(cell)}">${renderedText}</b></span>`;
          }
          if (cellIndex === serialIndex && /^SER-/.test(String(cell))) {
            return `<span class="serial-cell"><code>${renderedText}</code></span>`;
          }
          return `<span>${renderedText}</span>`;
        })
        .join("");
      return `<div class="module-table-row" data-row-index="${index}">${cells}${hasActionsColumn ? renderActions(index) : ""}</div>`;
    })
    .join("");

  view.innerHTML = `<div class="module-table-wrap"><div class="module-table" style="--columns:${displayColumns.length}">
    <div class="module-table-row module-table-head">${displayColumns
      .map((column) => `<span>${escapeHtml(localizeBusinessText(column))}</span>`)
      .join("")}</div>${body}</div>
    ${visibleRows.length ? "" : '<p class="module-empty-state">Aun no hay registros en esta vista. Usa el boton superior para agregar el primero.</p>'}</div>`;
}

function renderFilterOptions() {
  const statusIndex = Number.isInteger(currentView.statusIndex) ? currentView.statusIndex : -1;
  filterControl.hidden = statusIndex < 0;
  if (statusIndex >= 0) {
    const currentSelection = filterInput.value;
    const statuses = [...new Set(rows.map((row) => row[statusIndex]).filter(Boolean))];
    filterInput.innerHTML =
      '<option value="">Todos</option>' +
      statuses
        .map((status) => `<option value="${escapeHtml(status)}"${status === currentSelection ? " selected" : ""}>${escapeHtml(status)}</option>`)
        .join("");
  }
  if (currentKey === "inventarios" && currentViewKey === "productos") {
    const categories = [...new Set(rows.map((row) => row[2]).filter(Boolean))];
    let categorySelect = document.querySelector("#inventory-category-filter");
    if (!categorySelect) {
      filterControl.insertAdjacentHTML(
        "afterend",
        `<label class="module-filter"><span>Categoria</span><select id="inventory-category-filter"><option value="">Todas</option></select></label><label class="module-filter"><span>Existencia</span><select id="inventory-stock-filter"><option value="">Todas</option><option value="positive">Positiva</option><option value="zero">En cero</option><option value="negative">Negativa</option></select></label><a class="secondary-action" href="./registrar-ingreso.html">+ Costear lote</a>`
      );
      categorySelect = document.querySelector("#inventory-category-filter");
      categorySelect.addEventListener("change", renderTable);
      document.querySelector("#inventory-stock-filter").addEventListener("change", renderTable);
      document.querySelector("#inventory-export")?.addEventListener("click", exportInventory);
    }
    const previousCat = categorySelect.value;
    categorySelect.innerHTML =
      '<option value="">Todas</option>' +
      categories
        .map((category) => `<option value="${escapeHtml(category)}"${category === previousCat ? " selected" : ""}>${escapeHtml(category)}</option>`)
        .join("");
  }
}

function refreshDataView() {
  renderFilterOptions();
  renderTable();
  renderMetrics();
}

function handleStoredRowsChange(event) {
  if (!event.key?.startsWith(`${STORAGE_PREFIX}-c${activeCompanyId()}-`) || event.newValue === null) return;

  if (event.key === storageKey) {
    try {
      const savedRows = JSON.parse(event.newValue);
      if (Array.isArray(savedRows)) rows = normalizeDatasetRows(currentKey, currentViewKey, savedRows);
    } catch (error) {
      return;
    }
    refreshDataView();
    return;
  }

  if (
    typeof currentView.metrics === "string" &&
    metricDependencies(currentView.metrics).some(([moduleKey]) => event.key.startsWith(`${STORAGE_PREFIX}-c${activeCompanyId()}-${moduleKey}-`))
  ) {
    renderMetrics();
  }
}

function renderReports() {
  toolbar.hidden = true;
  view.innerHTML = `<div class="report-grid">${reports
    .map(
      ([title, description], index) =>
        `<article class="report-card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><div><small>CSV consolidado (${escapeHtml(
          activeUser().company || "Empresa activa"
        )})</small><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" data-report-excel="${index}">Excel (.xlsx)</button><button type="button" data-report-pdf="${index}">PDF</button><button type="button" data-report="${index}">CSV</button></div></div></article>`
    )
    .join("")}</div>`;
}

function guideHref(moduleKey, viewKey) {
  return moduleKey === "inventario.html"
    ? "./modulo.html?modulo=inventarios&vista=productos"
    : `./modulo.html?modulo=${encodeURIComponent(moduleKey)}&vista=${encodeURIComponent(viewKey)}`;
}

function renderGuides() {
  metricsContainer.hidden = true;
  toolbar.innerHTML = `<label class="search-control help-search" for="help-search"><img src="./assets/icons/inventory-search.svg" alt="" /><input id="help-search" type="search" placeholder="Buscar una guia, modulo o proceso textil..." /></label>`;
  const input = toolbar.querySelector("input");
  const draw = () => {
    const term = input.value.trim().toLowerCase();
    const matches = guides.filter((guide) => guide.join(" ").toLowerCase().includes(term));
    view.innerHTML = `<h2 class="module-section-title">Guias operativas por proceso</h2><div class="help-grid">${
      matches.length
        ? matches
            .map(
              ([title, description, route, moduleKey, viewKey]) =>
                `<a class="help-card" href="${guideHref(moduleKey, viewKey)}"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(
                  description
                )}</span><small>${escapeHtml(route)} &gt;</small></a>`
            )
            .join("")
        : '<p class="module-empty-state">No se encontraron guias con ese criterio.</p>'
    }</div>`;
  };
  input.addEventListener("input", draw);
  draw();
}

function getPosProducts() {
  const inventoryRows = moduleRows("inventarios", "productos");
  if (!inventoryRows.length) return [];
  const priceRows = moduleRows("inventarios", "precios");
  return inventoryRows
    .filter((row) => !/inactivo/i.test(String(row[6] || "")))
    .map((row) => ({
      id: String(row[0] || "TELA-0001"),
      name: String(row[1] || "Tela comercial"),
      stock: `${numericValue(row[4]).toFixed(2)}${formatWeightConversion(row[4], row[3])}`,
      price: (() => {
        const base = Math.max(0.01, numericValue(row[5]) || 1);
        const match = priceRows.find((p) => String(p[0]).trim() === String(row[0]).trim() || String(p[1]).trim() === String(row[1]).trim());
        const tiers = match
          ? [numericValue(match[2]) || base, numericValue(match[3]) || base * 0.92, numericValue(match[4]) || base * 0.85, numericValue(match[5]) || base * 0.8, numericValue(match[6]) || base * 0.75]
          : [base, base * 0.92, base * 0.85, base * 0.8, base * 0.75];
        return Math.round((tiers[posPriceListIndex] || base) * 100) / 100;
      })(),
      unit: String(row[3] || "Kilogramo (kg)").toLowerCase().includes("libra") || String(row[3] || "").toLowerCase() === "lb" ? "lb" : "kg",
    }));
}

function money(value) {
  const u = activeUser();
  return new Intl.NumberFormat(u.locale || "es-HN", {
    style: "currency",
    currency: u.currencyCode || "HNL",
    minimumFractionDigits: 2,
  }).format(value);
}

function renderPosProducts(products) {
  if (!products.length) {
    return '<p class="module-empty-state">Aun no hay telas registradas en Inventarios. Agrega productos en Inventarios &gt; Productos para vender en mostrador.</p>';
  }
  return products
    .map(
      (product) =>
        `<article class="pos-product-card"><span>${escapeHtml(product.id)}</span><h3>${escapeHtml(product.name)}</h3><small>Disponible: ${escapeHtml(
          product.stock
        )}</small><div><strong>${money(product.price)} / ${escapeHtml(product.unit)}</strong><button type="button" data-pos="add" data-id="${escapeHtml(
          product.id
        )}" aria-label="Agregar ${escapeHtml(product.name)}">+</button></div></article>`
    )
    .join("");
}

function renderPos() {
  toolbar.hidden = true;
  const availableProducts = getPosProducts();
  const clientRows = moduleRows("ventas", "clientes");
  const clientNames = ["Publico general", ...new Set(clientRows.map((row) => row[1]).filter(Boolean))];
  const subtotal = posCart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const taxRate = Number.isFinite(posTaxRate) ? Math.min(100, Math.max(0, posTaxRate)) : 0;
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;
  view.innerHTML = `<div class="pos-layout"><section class="pos-products">
    <div class="pos-section-heading"><div><h2>Catalogo de telas en mostrador (Kilos / Libras)</h2><p>Selecciona productos en Kilos (kg) o Libras (lb) con conversion automatica para agregar a la venta.</p></div><label class="search-control pos-search"><img src="./assets/icons/inventory-search.svg" alt="" /><input id="pos-search" type="search" placeholder="Buscar tela o codigo..." /></label></div>
    <div class="pos-product-grid" id="pos-product-grid">${renderPosProducts(availableProducts)}</div></section>
    <aside class="pos-cart"><div class="pos-cart-heading"><div><h2>Venta de mostrador</h2><p>${escapeHtml(
      activeUser().company || "Sucursal Principal"
    )}</p></div><button type="button" data-pos="clear"${posCart.length ? "" : " disabled"}>Vaciar</button></div>
    <label class="pos-field"><span>Cliente</span><select id="pos-client-select">${clientNames
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
      .join("")}</select></label>
    <label class="pos-field"><span>Lista de precio (5 listas)</span><select id="pos-price-list-select">${PRICE_LIST_NAMES.map((lbl, idx) => `<option value="${idx}"${idx === posPriceListIndex ? " selected" : ""}>${escapeHtml(lbl)}</option>`).join("")}</select></label>
    <label class="pos-field"><span>Esquema de impuestos</span><select id="pos-tax-scheme-select"><option value="ISV:15">ISV General (15%)</option><option value="ISV:18">ISV Especial (18%)</option><option value="IVA:16">IVA General (16%)</option><option value="Exento:0">Exento (0%)</option>${moduleRows("inventarios", "impuestos").map((t) => `<option value="${escapeHtml(t[1] || "Impuesto")}:${numericValue(t[2]) + numericValue(t[3])}">${escapeHtml(t[0])} - ${escapeHtml(t[1])} (${numericValue(t[2]) + numericValue(t[3])}%)</option>`).join("")}</select></label>
    <div class="pos-cart-items">${
      posCart.length
        ? posCart
            .map(
              (item) =>
                `<div class="pos-cart-row"><div><strong>${escapeHtml(item.name)}</strong><small>${money(item.price)} / ${escapeHtml(
                  item.unit
                )}</small><small style="display:block;color:#1e40af">${item.unit === "lb" ? `${(item.quantity * 0.453592).toFixed(2)} kg` : `${(item.quantity * 2.20462).toFixed(2)} lb`}</small></div><div class="pos-quantity"><button type="button" data-pos="toggle-unit" data-id="${escapeHtml(item.id)}" title="Convertir entre Kilos (kg) y Libras (lb)" style="font-size:0.74rem;padding:2px 6px;width:auto">${escapeHtml(item.unit.toUpperCase())} ⇄</button><button type="button" data-pos="decrease" data-id="${escapeHtml(
                  item.id
                )}" aria-label="Reducir cantidad">-</button><span>${item.quantity}</span><button type="button" data-pos="increase" data-id="${escapeHtml(
                  item.id
                )}" aria-label="Aumentar cantidad">+</button></div><strong>${money(item.price * item.quantity)}</strong></div>`
            )
            .join("")
        : '<div class="pos-empty"><strong>Sin telas en la orden</strong><span>Selecciona telas del catalogo izquierdo para iniciar el corte o venta.</span></div>'
    }</div>
    <div class="pos-summary"><div><span>Peso total</span><strong>${posCart.reduce((s, it) => s + (it.unit === "lb" ? it.quantity * 0.453592 : it.quantity), 0).toFixed(2)} kg (${posCart.reduce((s, it) => s + (it.unit === "lb" ? it.quantity : it.quantity * 2.20462), 0).toFixed(2)} lb)</strong></div><div><span>Subtotal</span><strong>${money(subtotal)}</strong></div>
    <div class="pos-tax-editor"><label><span>Impuesto</span><input id="pos-tax-name" type="text" value="${escapeHtml(
      posTaxName
    )}" maxlength="30" placeholder="Impuesto" aria-label="Nombre del impuesto" /></label><label><span>Porcentaje</span><span class="pos-tax-rate"><input id="pos-tax-rate" type="number" value="${taxRate}" min="0" max="100" step="0.01" aria-label="Porcentaje del impuesto" /><b>%</b></span></label></div>
    <div><span id="pos-tax-label">${escapeHtml(posTaxName || "Impuesto")} ${taxRate}%</span><strong id="pos-tax-amount">${money(
      tax
    )}</strong></div><div class="pos-total"><span>Total</span><strong id="pos-total-amount">${money(total)}</strong></div></div>
    <label class="pos-field"><span>Forma de pago</span><select id="pos-payment-method"><option>Efectivo</option><option>Tarjeta</option><option>Transferencia</option><option>Credito autorizado</option></select></label>
    <button class="primary-action pos-complete" type="button" data-pos="complete"${
      posCart.length ? "" : " disabled"
    }>Cobrar y emitir factura</button></aside></div>`;

  const posSearch = document.querySelector("#pos-search");
  posSearch.addEventListener("input", () => {
    const term = posSearch.value.toLowerCase().trim();
    document.querySelector("#pos-product-grid").innerHTML = renderPosProducts(
      availableProducts.filter((product) => `${product.id} ${product.name}`.toLowerCase().includes(term))
    );
  });
  const taxNameInput = document.querySelector("#pos-tax-name");
  const taxRateInput = document.querySelector("#pos-tax-rate");
  const updateTax = () => {
    posTaxName = taxNameInput.value;
    const enteredRate = Number(taxRateInput.value);
    posTaxRate = Number.isFinite(enteredRate) ? Math.min(100, Math.max(0, enteredRate)) : 0;
    const updatedTax = subtotal * (posTaxRate / 100);
    document.querySelector("#pos-tax-label").textContent = `${posTaxName.trim() || "Impuesto"} ${posTaxRate}%`;
    document.querySelector("#pos-tax-amount").textContent = money(updatedTax);
    document.querySelector("#pos-total-amount").textContent = money(subtotal + updatedTax);
  };
  taxNameInput.addEventListener("input", updateTax);
  taxRateInput.addEventListener("input", updateTax);
  document.querySelector("#pos-price-list-select")?.addEventListener("change", (e) => {
    posPriceListIndex = Number(e.target.value || 0);
    const updatedProducts = getPosProducts();
    posCart = posCart.map((c) => {
      const found = updatedProducts.find((p) => p.id === c.id);
      return found ? { ...c, price: found.price } : c;
    });
    renderPos();
  });
  document.querySelector("#pos-tax-scheme-select")?.addEventListener("change", (e) => {
    const [schemeName, schemeRate] = String(e.target.value || "ISV:15").split(":");
    taxNameInput.value = schemeName || "ISV";
    taxRateInput.value = String(Number(schemeRate || 0));
    updateTax();
  });
}

async function handlePosAction(button) {
  const action = button.dataset.pos;
  const availableProducts = getPosProducts();
  const product = availableProducts.find((item) => item.id === button.dataset.id);
  const cartItem = posCart.find((item) => item.id === button.dataset.id);
  if (action === "add" && product) {
    cartItem ? (cartItem.quantity += 1) : posCart.push({ ...product, quantity: 1 });
  }
  if (action === "toggle-unit" && cartItem) {
    if (cartItem.unit === "kg") {
      cartItem.unit = "lb";
      cartItem.quantity = Math.round(cartItem.quantity * 2.20462 * 100) / 100;
      cartItem.price = Math.round((cartItem.price / 2.20462) * 100) / 100;
    } else {
      cartItem.unit = "kg";
      cartItem.quantity = Math.round(cartItem.quantity * 0.453592 * 100) / 100;
      cartItem.price = Math.round((cartItem.price * 2.20462) * 100) / 100;
    }
  }
  if (action === "increase" && cartItem) cartItem.quantity = Math.round((cartItem.quantity + 1) * 100) / 100;
  if (action === "decrease" && cartItem) {
    cartItem.quantity -= 1;
    if (cartItem.quantity <= 0) posCart = posCart.filter((item) => item.id !== cartItem.id);
  }
  if (action === "clear") posCart = [];
  if (action === "complete" && posCart.length) {
    const client = document.querySelector("#pos-client-select")?.value || "Publico general";
    const subtotal = posCart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const total = subtotal * (1 + (Number.isFinite(posTaxRate) ? posTaxRate : 0) / 100);
    button.disabled = true;
    button.textContent = "Emitiendo factura...";
    try {
      const today = new Intl.DateTimeFormat(activeUser().locale || "es-HN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
        .format(new Date())
        .replace(".", "");
      const { targetView, documentNumber } = await nextTargetDocument("ventas", "facturas");
      const sequence = documentNumber.match(/(\d+)$/)?.[1] || "1";
      const correlative = `${targetView.autoCorrelative.prefix}-${sequence.padStart(targetView.autoCorrelative.digits, "0")}`;
      await appendTargetRow("ventas", "facturas", [documentNumber, client, correlative, today, currency(total, 2), "Pagada"]);
      posCart = [];
      showToast(`Factura ${documentNumber} emitida y registrada en Ventas.`);
    } catch (error) {
      showToast(error.message || "No se pudo registrar la venta.", true);
    }
  }
  renderPos();
}

function normalizeInputValue(value, type) {
  if (type === "number") return String(value ?? "").replace(/[^\d.]/g, "");
  if (type === "quantity") return String(value ?? "").replace(/[^\d.-]/g, "");
  if (type !== "date" || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const months = {
    ene: "01",
    feb: "02",
    mar: "03",
    abr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    ago: "08",
    sept: "09",
    sep: "09",
    oct: "10",
    nov: "11",
    dic: "12",
  };
  const match = String(value).toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  return match && months[match[2]] ? `${match[3]}-${months[match[2]]}-${match[1].padStart(2, "0")}` : "";
}

function buildForm(row = []) {
  formFields.innerHTML = currentView.fields
    .map(([label, type, option], index) => {
      const generatedValue = editIndex === null ? automaticFieldValue(index) : "";
      const rawCellValue = row[index] !== undefined ? localizeBusinessText(row[index]) : generatedValue;
      const value = normalizeInputValue(rawCellValue, type);
      if (type === "select") {
        const localizedOptions = option.map((item) => localizeBusinessText(item));
        return `<label class="field"><span>${escapeHtml(localizeBusinessText(label))}</span><select name="field-${index}" required>${localizedOptions
          .map((item) => `<option value="${escapeHtml(item)}"${item === value ? " selected" : ""}>${escapeHtml(item)}</option>`)
          .join("")}</select></label>`;
      }
      const isAutomatic = currentView.autoNumber?.index === index || currentView.autoCorrelative?.index === index;
      const inputType = type === "quantity" ? "number" : type;
      const isClient = currentKey === "ventas" && /^cliente$/i.test(label);
      const list = isClient ? ' list="sales-client-list" autocomplete="off"' : "";
      return `<label class="field"><span>${escapeHtml(localizeBusinessText(label))}</span><input name="field-${index}" type="${escapeHtml(
        inputType
      )}" value="${escapeHtml(value)}"${type === "quantity" ? ' step="any"' : ""}${type === "number" ? ' step="0.01" min="0"' : ""} placeholder="${escapeHtml(
        localizeBusinessText(option)
      )}"${list}${isAutomatic ? ' readonly aria-readonly="true"' : ""} required /></label>`;
    })
    .join("");
  if (currentKey === "ventas" && currentView.fields.some(([label]) => /^cliente$/i.test(label))) {
    const clientNames = moduleRows("ventas", "clientes")
      .map((client) => client[1])
      .filter(Boolean);
    formFields.insertAdjacentHTML(
      "beforeend",
      `<datalist id="sales-client-list">${clientNames.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("")}</datalist>`
    );
  }
  if (currentKey === "inventarios" && currentViewKey === "productos") {
    formFields.insertAdjacentHTML("beforeend", '<div id="modal-weight-preview" style="grid-column:1/-1;padding:8px 12px;border-radius:8px;background:#eff6ff;color:#1e40af;font-size:0.84rem;font-weight:600">Conversion base: 1.00 kg = 2.20 lb | 1.00 lb = 0.45 kg</div>');
    const unitSel = formFields.querySelector('select[name="field-3"]');
    const qtyInp = formFields.querySelector('input[name="field-4"]');
    const priceInp = formFields.querySelector('input[name="field-5"]');
    const previewEl = formFields.querySelector("#modal-weight-preview");
    const refreshModalConversion = () => {
      const q = numericValue(qtyInp?.value);
      const p = numericValue(priceInp?.value);
      const isLb = String(unitSel?.value || "").toLowerCase().includes("libra");
      const kg = isLb ? q * 0.453592 : q;
      const lb = isLb ? q : q * 2.20462;
      const pKg = isLb ? p * 2.20462 : p;
      const pLb = isLb ? p : p / 2.20462;
      if (previewEl) {
        previewEl.textContent = q > 0 || p > 0
          ? `Conversion automatica: ${kg.toFixed(2)} kg = ${lb.toFixed(2)} lb  |  Precio: ${currency(pKg, 2)}/kg (${currency(pLb, 2)}/lb)`
          : "Conversion base: 1.00 kg = 2.20 lb | 1.00 lb = 0.45 kg";
      }
    };
    [unitSel, qtyInp, priceInp].forEach((el) => {
      el?.addEventListener("input", refreshModalConversion);
      el?.addEventListener("change", refreshModalConversion);
    });
    refreshModalConversion();
  }
  if (false) {
    void (0
    );
  }
}

function openForm(index = null) {
  if (!currentView.fields) return;
  editIndex = index;
  document.querySelector("#module-form-title").textContent = index === null ? currentView.action.replace("+ ", "") : "Editar registro";
  document.querySelector("#module-form-help").textContent = `Completa la informacion de ${currentView.label.toLowerCase()} para ${
    activeUser().company || "la empresa activa"
  }.`;
  formError.hidden = true;
  buildForm(index === null ? [] : rows[index]);
  dialog.showModal();
}

function closeForm() {
  dialog.close();
  form.reset();
  editIndex = null;
}

function formatFieldValue(value, type) {
  const u = activeUser();
  if (type === "quantity") return String(value).trim();
  if (type === "date") {
    return new Intl.DateTimeFormat(u.locale || "es-HN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${value}T12:00:00Z`))
      .replace(".", "");
  }
  if (type === "number") {
    return `${u.currencySymbol || "L"} ${Number(value).toLocaleString(u.locale || "es-HN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })}`;
  }
  return String(value).trim();
}

async function appendTargetRow(moduleKey, viewKey, row) {
  const targetView = modules[moduleKey].views[viewKey];
  let targetRows = loadRows(moduleKey, viewKey, targetView.rows || []);
  try {
    const dataset = await window.gestionUserDb.getDataset(moduleKey, viewKey, activeCompanyId());
    if (dataset.initialized && Array.isArray(dataset.rows)) {
      targetRows = normalizeDatasetRows(moduleKey, viewKey, dataset.rows);
    }
  } catch (error) {
    // Se conserva la copia sincronizada en caso de fallo de red temporal.
  }
  targetRows.unshift([...row, "Asignando..."]);
  localStorage.setItem(rowsStorageKey(moduleKey, viewKey), JSON.stringify(targetRows));
  const saved = await window.gestionUserDb.saveDataset(moduleKey, viewKey, targetRows, activeCompanyId());
  localStorage.setItem(rowsStorageKey(moduleKey, viewKey), JSON.stringify(saved.rows));
}

function renderAccountingHub() {
  toolbar.hidden = true;
  metricsContainer.hidden = true;
  const documents = [
    ["income-statement", "Estado de resultados", "Ingresos por venta de tela, costo de ventas, gastos operativos y utilidad neta."],
    ["balance-sheet", "Balance general", "Activos circulantes (inventario de rollos, bancos), pasivos y capital contable."],
    ["trial-balance", "Balanza de comprobacion", "Saldos iniciales, cargos, abonos y saldos finales por cuenta contable."],
    ["payroll-catalog", "Percepciones y deducciones", "Catalogo fiscal de conceptos y acumulados de nomina segun pais de la empresa."],
    ["sales-profit", "Ventas y utilidad por tela", "Metros/rollos vendidos, costo total, precio de venta, utilidad y margen comercial."],
    ["purchase-invoice", "Factura de importacion / compra", "Desglose de factura de proveedor textil, orden de trabajo, pesos e impuestos."],
  ];
  view.innerHTML = `<div class="accounting-document-grid">${documents
    .map(
      ([type, title, description]) => `
    <a class="accounting-document-card" href="./reportes-contables.html?tipo=${type}"><span>Documento contable</span><h2>${escapeHtml(
        title
      )}</h2><p>${escapeHtml(description)}</p><strong>Abrir documento &gt;</strong></a>`
    )
    .join("")}</div>`;
}

function sequentialNumber(definition, sourceRows = rows) {
  const year = new Date().getFullYear();
  const prefixes = [definition.prefix, ...(definition.aliases || [])];
  const highest = sourceRows.reduce((maximum, row) => {
    const value = String(row[definition.index ?? 0] || "");
    const matchesPrefix = prefixes.some((prefix) => value.startsWith(`${prefix}-`));
    if (!matchesPrefix) return maximum;
    const match = value.match(/(\d+)$/);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  const sequence = String(highest + 1).padStart(definition.digits, "0");
  return definition.year ? `${definition.prefix}-${year}-${sequence}` : `${definition.prefix}-${sequence}`;
}

function automaticFieldValue(index) {
  if (currentView.autoNumber?.index === index) return sequentialNumber(currentView.autoNumber);
  if (currentView.autoCorrelative?.index === index) {
    const source = sequentialNumber(currentView.autoNumber);
    const sequence = source.match(/(\d+)$/)?.[1] || "1";
    return `${currentView.autoCorrelative.prefix}-${sequence.padStart(currentView.autoCorrelative.digits, "0")}`;
  }
  return "";
}

async function nextTargetDocument(moduleKey, viewKey) {
  const targetView = modules[moduleKey].views[viewKey];
  let targetRows = loadRows(moduleKey, viewKey, targetView.rows || []);
  try {
    const dataset = await window.gestionUserDb.getDataset(moduleKey, viewKey, activeCompanyId());
    if (dataset.initialized && Array.isArray(dataset.rows)) {
      targetRows = normalizeDatasetRows(moduleKey, viewKey, dataset.rows);
    }
  } catch (error) {
    // Utiliza la copia local si el servidor no responde.
  }
  const documentNumber = sequentialNumber(targetView.autoNumber, targetRows);
  return { targetView, documentNumber };
}

async function runWorkflow(index) {
  const row = rows[index];
  const type = currentView.workflow.type;
  const sym = activeUser().currencySymbol || "L";
  if (type === "requisition-to-order") {
    await appendTargetRow("compras", "ordenes", [
      `OC-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`,
      "Proveedor por asignar",
      row[2],
      row[3],
      `${sym} 0`,
      "Borrador",
    ]);
    navigate("compras", "ordenes");
  } else if (type === "order-to-receipt") {
    await appendTargetRow("compras", "recepciones", [
      `REC-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`,
      row[0],
      row[1],
      "LOT-PENDIENTE",
      "0.00 kg (0.00 lb)",
      "0.00 kg (0.00 lb)",
      "Pendiente",
    ]);
    navigate("compras", "recepciones");
  } else if (type === "receipt-to-stock") {
    sessionStorage.setItem("textiles-gh-flash", `Recepcion ${row[0]} verificada en inventario.`);
    navigate("inventarios", "productos");
  } else if (type === "quote-to-order") {
    const { documentNumber } = await nextTargetDocument("ventas", "pedidos");
    const detail = String(row[2] || "");
    const quantity = detail.match(/[+-]?\d+(?:[.,]\d+)?/)?.[0] || "1";
    const product = detail.replace(/^[+-]?\d+(?:[.,]\d+)?\s*(?:kg|kilos?|kilogramos?|lb|lbs|libras?)?\s*/i, "") || detail;
    await appendTargetRow("ventas", "pedidos", [documentNumber, row[1], product, quantity, "Detalle", row[3], row[4], "Pendiente"]);
    navigate("ventas", "pedidos");
  } else if (type === "order-to-invoice") {
    const today = new Intl.DateTimeFormat(activeUser().locale || "es-HN", { day: "numeric", month: "short", year: "numeric" })
      .format(new Date())
      .replace(".", "");
    const { targetView, documentNumber } = await nextTargetDocument("ventas", "facturas");
    const sequence = documentNumber.match(/(\d+)$/)?.[1] || "1";
    const correlative = `${targetView.autoCorrelative.prefix}-${sequence.padStart(targetView.autoCorrelative.digits, "0")}`;
    await appendTargetRow("ventas", "facturas", [documentNumber, row[1], correlative, today, row[6], "Borrador"]);
    navigate("ventas", "facturas");
  } else if (type === "invoice-to-payment") {
    await appendTargetRow("ventas", "cobranza", [row[0], row[1], row[3], row[4], row[4], "0-15 dias", "Por vencer"]);
    navigate("ventas", "cobranza");
  } else if (type === "client-to-collections") {
    navigate("ventas", "cobranza");
  }
}

function exportCurrentView(format = "excel") {
  const dataRows = filteredRows().map(({ row }) => row.map((c) => localizeBusinessText(c)));
  const headers = [...(currentView.columns || [])];
  if (headers.at(-1) === "Acciones") {
    headers.splice(-1, 0, "No. de serie");
    headers.pop();
  }
  const title = `${currentModule.title} - ${currentView.label}`;
  const fname = `${currentKey}-${currentViewKey}`;
  if (format === "pdf") {
    window.gestionExport?.toPdf({ filename: fname, title, columns: headers, rows: dataRows });
  } else {
    window.gestionExport?.toExcel({ filename: fname, sheetName: currentView.label, title, columns: headers, rows: dataRows });
  }
}

function exportReportFormat(index = 0, format = "excel") {
  const reportSources = [
    ["ventas", "facturas"],
    ["inventarios", "productos"],
    ["compras", "ordenes"],
    ["costos", "hojas"],
    ["ventas", "cobranza"],
    ["contabilidad", "movimientos"],
  ];
  const [targetModule, targetView] = reportSources[index] || ["ventas", "facturas"];
  const viewDef = modules[targetModule]?.views?.[targetView] || currentView;
  const datasetRows = moduleRows(targetModule, targetView).map((r) => r.map((c) => localizeBusinessText(c)));
  const headers = [...(viewDef.columns || ["Columna"])];
  if (headers.at(-1) === "Acciones") {
    headers.splice(-1, 0, "No. de serie");
    headers.pop();
  }
  const title = reports[index]?.[0] || viewDef.label;
  if (format === "pdf") {
    window.gestionExport?.toPdf({ filename: title, title, columns: headers, rows: datasetRows });
  } else {
    window.gestionExport?.toExcel({ filename: title, sheetName: title, title, columns: headers, rows: datasetRows });
  }
}

function exportInventory() {
  return exportCurrentView("excel");
}

function exportInventoryLegacy() {
  const dataRows = filteredRows().map(({ row }) => row);
  const headers = [...currentView.columns];
  headers.splice(-1, 0, "No. de serie");
  headers.pop();
  const xmlCell = (value) => `<Cell><Data ss:Type="String">${escapeHtml(localizeBusinessText(value))}</Data></Cell>`;
  const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Inventario Textil"><Table><Row>${headers
    .map(xmlCell)
    .join("")}</Row>${dataRows.map((row) => `<Row>${row.map(xmlCell).join("")}</Row>`).join("")}</Table></Worksheet></Workbook>`;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" }));
  link.download = `inventario-textil-${(activeUser().companySlug || "empresa")}-${new Date().toISOString().slice(0, 10)}.xls`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast(`${dataRows.length} registros exportados a Excel.`);
}

function exportReport(index = 0) {
  const reportSources = [
    ["ventas", "facturas"],
    ["inventarios", "productos"],
    ["compras", "ordenes"],
    ["costos", "hojas"],
    ["ventas", "cobranza"],
    ["contabilidad", "movimientos"],
  ];
  const [targetModule, targetView] = currentView.type === "reports" ? reportSources[index] || ["ventas", "facturas"] : [currentKey, currentViewKey];
  const viewDef = modules[targetModule]?.views?.[targetView] || currentView;
  const datasetRows = targetModule === currentKey && targetView === currentViewKey ? rows : moduleRows(targetModule, targetView);
  const headers = [...(viewDef.columns || ["Columna"])];
  if (headers.at(-1) === "Acciones") {
    headers.splice(-1, 0, "No. de serie");
    headers.pop();
  }
  const csvCell = (val) => `"${String(localizeBusinessText(val ?? "")).replaceAll('"', '""')}"`;
  const csvLines = [headers.map(csvCell).join(","), ...datasetRows.map((row) => row.map(csvCell).join(","))];
  const title = reports[index]?.[0] || currentView.label;
  const blob = new Blob([`\ufeff${csvLines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${title.toLowerCase().replace(/\s+/g, "-")}-${activeUser().companySlug || "erp"}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast(`Reporte "${title}" exportado en CSV (${datasetRows.length} registros).`);
}

function handlePrimaryAction() {
  if (currentView.type === "accounting-hub") {
    window.location.href = "./reportes-contables.html";
    return;
  }
  if (currentView.fields) return openForm();
  if (/exportar/i.test(currentView.action || "")) return exportReport();
}

function initializePage() {
  document.title = `Gestion Empresarial | ${currentModule.title} - ${currentView.label}`;
  document.querySelector("#module-title").textContent = currentModule.title;
  document.querySelector("#crumb-title").textContent = `${currentModule.title} / ${currentView.label}`;
  document.querySelector("#module-description").textContent = localizeBusinessText(currentView.description);
  document.querySelectorAll(".side-nav a").forEach((link) => link.classList.toggle("active", link.dataset.module === currentKey));
  renderTabs();
  renderMetrics();

  const perm = getModulePermissionConfig(currentKey);
  const canCreate = perm.actions[1];
  const hasValidPrimaryAction =
    (Boolean(currentView.fields) && canCreate) ||
    currentView.type === "accounting-hub" ||
    /exportar/i.test(currentView.action || "");
  actionButton.hidden = !currentView.action || !hasValidPrimaryAction;
  actionButton.textContent = currentView.action || "";
  actionButton.addEventListener("click", handlePrimaryAction);

  const flash = sessionStorage.getItem("textiles-gh-flash");
  if (flash) {
    sessionStorage.removeItem("textiles-gh-flash");
    showToast(flash);
  }

  if (currentView.type === "reports") {
    renderReports();
    syncDataset();
    return;
  }
  if (currentView.type === "help") return renderGuides();
  if (currentView.type === "pos") {
    renderPos();
    window.gestionUserDb
      .getDataset("inventarios", "productos", activeCompanyId())
      .then((dataset) => {
        const cleanRows = dataset.initialized && Array.isArray(dataset.rows)
          ? normalizeDatasetRows("inventarios", "productos", dataset.rows)
          : [];
        localStorage.setItem(rowsStorageKey("inventarios", "productos"), JSON.stringify(cleanRows));
        renderPos();
      })
      .catch(() => {});
    return;
  }
  if (currentView.type === "accounting-hub") return renderAccountingHub();

  toolbar.hidden = false;
  searchInput.placeholder = localizeBusinessText(currentView.search || "Buscar...");
  renderFilterOptions();
  renderTable();
  searchInput.addEventListener("input", renderTable);
  searchInput.addEventListener("input", renderTable);
  filterInput.addEventListener("change", renderTable);
  document.querySelector("#module-export-excel")?.addEventListener("click", () => exportCurrentView("excel"));
  document.querySelector("#module-export-pdf")?.addEventListener("click", () => exportCurrentView("pdf"));
  syncDataset();
}

view.addEventListener("click", async (event) => {
  const posButton = event.target.closest("[data-pos]");
  if (posButton) return handlePosAction(posButton);
  const reportExcelBtn = event.target.closest("[data-report-excel]");
  if (reportExcelBtn) return exportReportFormat(Number(reportExcelBtn.dataset.reportExcel), "excel");
  const reportPdfBtn = event.target.closest("[data-report-pdf]");
  if (reportPdfBtn) return exportReportFormat(Number(reportPdfBtn.dataset.reportPdf), "pdf");
  const reportButton = event.target.closest("[data-report]");
  if (reportButton) return exportReport(Number(reportButton.dataset.report));
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const index = Number(button.closest(".row-actions")?.dataset.index);
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return;
  if (button.dataset.action === "edit") openForm(index);
  if (button.dataset.action === "workflow") {
    button.disabled = true;
    const prevText = button.textContent;
    button.textContent = "Procesando...";
    try {
      await runWorkflow(index);
    } catch (error) {
      button.disabled = false;
      button.textContent = prevText;
      showToast(error.message, true);
    }
  }
  if (button.dataset.action === "delete") {
    button.disabled = true;
    rows.splice(index, 1);
    refreshDataView();
    await saveRows();
    showToast("Registro eliminado correctamente.");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.checkValidity()) {
    formError.hidden = false;
    form.reportValidity();
    return;
  }
  const submitBtn = form.querySelector("button[type='submit']");
  const wasEditing = editIndex !== null;
  const data = new FormData(form);
  const values = currentView.fields.map(([, type], index) => formatFieldValue(data.get(`field-${index}`), type));
  values.push(wasEditing ? rows[editIndex].at(-1) : "Asignando...");
  if (wasEditing) rows[editIndex] = values;
  else rows.unshift(values);

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Guardando...";
  }
  try {
    closeForm();
    refreshDataView();
    await saveRows();
    showToast(wasEditing ? "Registro actualizado correctamente." : "Registro guardado correctamente.");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Guardar";
    }
  }
});

document.querySelector("#module-dialog-close").addEventListener("click", closeForm);
document.querySelector("#module-dialog-cancel").addEventListener("click", closeForm);
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeForm();
});
window.addEventListener("storage", handleStoredRowsChange);
initializePage();
