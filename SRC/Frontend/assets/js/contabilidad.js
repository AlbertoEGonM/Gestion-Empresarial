(function () {
  const VIEW_META = {
    cuentas: { title: "Catálogo de Cuentas", crumb: "Catálogo de Cuentas" },
    polizas: { title: "Pólizas Contables (Co, Di, Eg, Ig, Vt)", crumb: "Pólizas" },
    auxiliares: { title: "Auxiliar de Cuentas Contables", crumb: "Auxiliares" },
    balanza: { title: "Balanza de Comprobación", crumb: "Balanza de Comprobación" },
    estados: { title: "Estado de Resultados y Balance General", crumb: "Estados Financieros" },
    tipocambio: { title: "Tipo de Cambio ($USD / $LEM)", crumb: "Tipo de Cambio" },
  };

  let currentView = new URLSearchParams(window.location.search).get("vista") || "cuentas";
  if (!VIEW_META[currentView]) currentView = "cuentas";

  let accountsCache = [];
  let policiesCache = [];
  let auxiliaryCache = null;
  let trialCache = null;
  let statementsCache = null;
  let ratesCache = [];

  const toastEl = document.querySelector("#coi-toast");

  function escapeHtml(val) {
    return String(val ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function money(val) {
    return Number(val || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function activeCompanyId() {
    return window.gestionUserDb?.getCurrentUser?.()?.companyId || "";
  }

  function showToast(msg, isError = false) {
    if (!toastEl) return;
    toastEl.hidden = false;
    toastEl.textContent = msg;
    toastEl.classList.toggle("error", Boolean(isError));
    void (0
    );
    renderCoiMetrics();
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toastEl.hidden = true;
    }, 4500);
  }

  function api(path, options = {}) {
    const cid = activeCompanyId();
    const sep = path.includes("?") ? "&" : "?";
    const fullPath = cid ? `${path}${sep}companyId=${encodeURIComponent(cid)}` : path;
    return window.gestionUserDb.apiRequest(fullPath, options);
  }

  function switchView(viewKey, pushUrl = true) {
    if (!VIEW_META[viewKey]) viewKey = "cuentas";
    currentView = viewKey;
    document.querySelectorAll(".coi-flow-step[data-view]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewKey);
    });
    Object.keys(VIEW_META).forEach((key) => {
      const section = document.querySelector(`#view-${key}`);
      if (section) section.hidden = key !== viewKey;
    });
    document.querySelector("#coi-title").textContent = VIEW_META[viewKey].title;
    document.querySelector("#coi-crumb").textContent = VIEW_META[viewKey].crumb;
    if (pushUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("vista", viewKey);
      window.history.replaceState({}, "", url.toString());
    }
    loadCurrentView();
  }

  // -------------------- 1. CATALOGO DE CUENTAS --------------------
  async function loadAccounts() {
    const search = document.querySelector("#accounts-search").value.trim();
    const period = document.querySelector("#accounts-period").value;
    const data = await api(`/api/ledger/accounts?q=${encodeURIComponent(search)}&period=${encodeURIComponent(period)}`);
    accountsCache = data.accounts || [];
    renderAccountsTable();
    renderCoiMetrics();
    populateAccountSelects();
  }

  function renderAccountsTable() {
    const tbody = document.querySelector("#accounts-tbody");
    const tfoot = document.querySelector("#accounts-tfoot");
    if (!accountsCache.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:20px">No hay cuentas contables registradas en esta empresa. Usa el botón <b>+ Nueva Cuenta</b> para comenzar.</td></tr>`;
      tfoot.innerHTML = "";
      return;
    }
    let sumOpen = 0;
    let sumClose = 0;
    tbody.innerHTML = accountsCache
      .map((acc) => {
        sumOpen += Number(acc.openingBalance || 0);
        sumClose += Number(acc.closingBalance || 0);
        return `<tr>
          <td><span class="code-badge">${escapeHtml(acc.code)}</span></td>
          <td><strong>${escapeHtml(acc.name)}</strong><br><small style="color:#6b7280">${escapeHtml(acc.accountTypeLabel)}</small></td>
          <td>${escapeHtml(acc.groupingCode || "-")}</td>
          <td class="num-col">${money(acc.openingBalance)}</td>
          <td class="num-col"><strong>${money(acc.closingBalance)}</strong></td>
          <td>
            <button type="button" class="mini-btn" data-edit-acc="${acc.id}">Editar</button>
            <button type="button" class="mini-btn danger" data-del-acc="${acc.id}">Eliminar</button>
          </td>
        </tr>`;
      })
      .join("");
    tfoot.innerHTML = `<tr>
      <td colspan="3">Total (${accountsCache.length} cuentas)</td>
      <td class="num-col">${money(sumOpen)}</td>
      <td class="num-col">${money(sumClose)}</td>
      <td></td>
    </tr>`;
  }

  function populateAccountSelects() {
    const datalist = document.querySelector("#ledger-accounts-datalist");
    if (datalist) {
      datalist.innerHTML = accountsCache
        .map((acc) => `<option value="${escapeHtml(acc.code)}">${escapeHtml(acc.code)} - ${escapeHtml(acc.name)}</option>`)
        .join("");
    }
    const fromSel = document.querySelector("#aux-from");
    const toSel = document.querySelector("#aux-to");
    if (fromSel && toSel) {
      const prevFrom = fromSel.value;
      const prevTo = toSel.value;
      const opts = accountsCache
        .map((acc) => `<option value="${escapeHtml(acc.code)}">${escapeHtml(acc.code)} - ${escapeHtml(acc.name)}</option>`)
        .join("");
      fromSel.innerHTML = `<option value="">Todas (Inicio)</option>${opts}`;
      toSel.innerHTML = `<option value="">Todas (Fin)</option>${opts}`;
      fromSel.value = prevFrom;
      toSel.value = prevTo;
    }
  }

  function openAccountForm(acc = null) {
    const form = document.querySelector("#account-form");
    form.hidden = false;
    document.querySelector("#account-form-title").textContent = acc ? `Editar Cuenta ${acc.code}` : "Registrar Cuenta Contable";
    document.querySelector("#acc-id").value = acc ? acc.id : "";
    document.querySelector("#acc-code").value = acc ? acc.code : "";
    document.querySelector("#acc-name").value = acc ? acc.name : "";
    document.querySelector("#acc-group").value = acc ? acc.groupingCode : "";
    document.querySelector("#acc-type").value = acc ? acc.accountType : "ASSET_CURRENT";
    document.querySelector("#acc-opening").value = acc ? Number(acc.openingBalance).toFixed(2) : "0.00";
    document.querySelector("#acc-currency").value = acc ? acc.currency : "HNL";
    document.querySelector("#acc-code").focus();
  }

  // -------------------- 2. POLIZAS --------------------
  async function loadPolicies() {
    if (!accountsCache.length) {
      const accRes = await api("/api/ledger/accounts");
      accountsCache = accRes.accounts || [];
      populateAccountSelects();
    }
    const period = document.querySelector("#policy-filter-period").value;
    const type = document.querySelector("#policy-filter-type").value;
    const data = await api(`/api/ledger/policies?period=${encodeURIComponent(period)}&type=${encodeURIComponent(type)}`);
    policiesCache = data.policies || [];
    renderPoliciesTable();
    renderCoiMetrics();
  }

  function renderPoliciesTable() {
    const tbody = document.querySelector("#policies-tbody");
    if (!policiesCache.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#6b7280;padding:20px">No hay pólizas registradas en este periodo.</td></tr>`;
      return;
    }
    tbody.innerHTML = policiesCache
      .map((p) => {
        const linesSummary = p.lines
          .map((l) => `${escapeHtml(l.accountCode)}: ${l.debit > 0 ? `C ${money(l.debit)}` : `A ${money(l.credit)}`}`)
          .join(" · ");
        return `<tr>
          <td><strong>${escapeHtml(p.folio)}</strong></td>
          <td><span class="policy-badge type-${escapeHtml(p.policyType)}">${escapeHtml(p.policyTypeLabel)}</span></td>
          <td>${escapeHtml(p.policyDate)}</td>
          <td><strong>${escapeHtml(p.concept)}</strong><br><small style="color:#6b7280">${linesSummary}</small></td>
          <td>${escapeHtml(p.currency)}${p.currency === "USD" ? ` (TC ${p.exchangeRate})` : ""}</td>
          <td class="num-col">${money(p.totalDebit)}</td>
          <td class="num-col">${money(p.totalCredit)}</td>
          <td>${escapeHtml(p.status)}</td>
          <td>
            <button type="button" class="mini-btn" data-edit-pol="${p.id}">Editar</button>
            <button type="button" class="mini-btn" data-pdf-pol="${p.id}">PDF</button>
            ${p.status === "Registrada" ? `<button type="button" class="mini-btn danger" data-cancel-pol="${p.id}">Cancelar</button>` : ""}
          </td>
        </tr>`;
      })
      .join("");
  }

  function addPolicyLineRow(line = { accountCode: "", concept: "", debit: "", credit: "" }) {
    const tbody = document.querySelector("#pol-lines-tbody");
    const tr = document.createElement("tr");
    const rowIdx = tbody.children.length + 1;
    tr.innerHTML = `
      <td>${rowIdx}</td>
      <td><input type="text" list="ledger-accounts-datalist" class="pol-line-acc" placeholder="Ej. 1101-001" value="${escapeHtml(line.accountCode)}" required /></td>
      <td><input type="text" class="pol-line-concept" placeholder="Detalle partida" value="${escapeHtml(line.concept)}" /></td>
      <td><input type="number" step="0.01" min="0" class="pol-line-debit num-col" value="${line.debit ? Number(line.debit).toFixed(2) : ""}" placeholder="0.00" /></td>
      <td><input type="number" step="0.01" min="0" class="pol-line-credit num-col" value="${line.credit ? Number(line.credit).toFixed(2) : ""}" placeholder="0.00" /></td>
      <td><button type="button" class="mini-btn danger pol-remove-line">✕</button></td>
    `;
    tbody.appendChild(tr);
    recalcPolicyTotals();
  }

  function recalcPolicyTotals() {
    const tbody = document.querySelector("#pol-lines-tbody");
    let debit = 0;
    let credit = 0;
    [...tbody.children].forEach((tr, idx) => {
      tr.firstElementChild.textContent = String(idx + 1);
      debit += Number(tr.querySelector(".pol-line-debit")?.value || 0);
      credit += Number(tr.querySelector(".pol-line-credit")?.value || 0);
    });
    document.querySelector("#pol-total-debit").textContent = money(debit);
    document.querySelector("#pol-total-credit").textContent = money(credit);
    const diff = Math.abs(debit - credit);
    const statusEl = document.querySelector("#pol-diff-status");
    if (debit > 0 && diff < 0.005) {
      statusEl.textContent = "Cuadrada";
      statusEl.className = "balance-Diff-ok";
    } else {
      statusEl.textContent = `Dif: ${money(diff)}`;
      statusEl.className = "balance-Diff-err";
    }
  }

  function openPolicyForm(policy = null) {
    const form = document.querySelector("#policy-form");
    form.hidden = false;
    document.querySelector("#policy-form-title").textContent = policy ? `Editar Póliza ${policy.folio}` : "Captura de Póliza Contable";
    document.querySelector("#pol-id").value = policy ? policy.id : "";
    document.querySelector("#pol-type").value = policy ? policy.policyType : "DI";
    const defaultDate = `${document.querySelector("#policy-filter-period").value || "2026-01"}-01`;
    document.querySelector("#pol-date").value = policy ? policy.policyDate : defaultDate;
    document.querySelector("#pol-concept").value = policy ? policy.concept : "";
    document.querySelector("#pol-currency").value = policy ? policy.currency : "HNL";
    document.querySelector("#pol-rate").value = policy ? policy.exchangeRate : "24.7500";
    document.querySelector("#pol-rate-wrap").hidden = (policy ? policy.currency : "HNL") !== "USD";

    const tbody = document.querySelector("#pol-lines-tbody");
    tbody.innerHTML = "";
    const lines = policy?.lines?.length
      ? policy.lines
      : [
          { accountCode: "", concept: "", debit: "", credit: "" },
          { accountCode: "", concept: "", debit: "", credit: "" },
        ];
    lines.forEach((line) => addPolicyLineRow(line));
  }

  // -------------------- 3. AUXILIARES --------------------
  async function loadAuxiliary() {
    if (!accountsCache.length) {
      const accRes = await api("/api/ledger/accounts");
      accountsCache = accRes.accounts || [];
      populateAccountSelects();
    }
    const year = document.querySelector("#aux-year").value;
    const month = document.querySelector("#aux-month").value;
    const from = document.querySelector("#aux-from").value;
    const to = document.querySelector("#aux-to").value;
    const data = await api(
      `/api/ledger/auxiliary?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    auxiliaryCache = data.auxiliary;
    renderAuxiliary();
  }

  function renderAuxiliary() {
    const container = document.querySelector("#aux-results");
    const accounts = auxiliaryCache?.accounts || [];
    if (!accounts.length) {
      container.innerHTML = `<p style="color:#6b7280;text-align:center;padding:18px">No hay cuentas en el rango seleccionado para el periodo ${escapeHtml(auxiliaryCache?.period || "")}.</p>`;
      return;
    }
    container.innerHTML = accounts
      .map((acc) => {
        const movRows = acc.movements.length
          ? acc.movements
              .map(
                (m) => `<tr>
                  <td>${escapeHtml(m.date)}</td>
                  <td><strong>${escapeHtml(m.folio)}</strong></td>
                  <td>${escapeHtml(m.concept)}</td>
                  <td class="num-col">${money(m.debit)}</td>
                  <td class="num-col">${money(m.credit)}</td>
                  <td class="num-col"><strong>${money(m.balance)}</strong></td>
                </tr>`
              )
              .join("")
          : `<tr><td colspan="6" style="text-align:center;color:#6b7280">Sin movimientos en este mes.</td></tr>`;
        return `<article class="aux-account-card">
          <header class="aux-account-header">
            <div><span class="code-badge">${escapeHtml(acc.code)}</span> <strong>${escapeHtml(acc.name)}</strong></div>
            <div>
              <span>Saldo Inicial: <b>${money(acc.openingBalance)}</b></span> &nbsp;|&nbsp;
              <span>Cargos: <b>${money(acc.debit)}</b></span> &nbsp;|&nbsp;
              <span>Abonos: <b>${money(acc.credit)}</b></span> &nbsp;|&nbsp;
              <span>Saldo Final: <b>${money(acc.closingBalance)}</b></span>
            </div>
          </header>
          <table class="coi-boxed-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Póliza</th>
                <th>Concepto</th>
                <th class="num-col">Debe (Cargo)</th>
                <th class="num-col">Haber (Abono)</th>
                <th class="num-col">Saldo Acumulado</th>
              </tr>
            </thead>
            <tbody>${movRows}</tbody>
          </table>
        </article>`;
      })
      .join("");
  }

  // -------------------- 4. BALANZA DE COMPROBACION --------------------
  async function loadTrialBalance() {
    const period = document.querySelector("#trial-period").value;
    const title = document.querySelector("#trial-title").value.trim() || "Balanza de Comprobacion";
    const data = await api(`/api/ledger/trial-balance?period=${encodeURIComponent(period)}&title=${encodeURIComponent(title)}`);
    trialCache = data.trialBalance;
    document.querySelector("#trial-heading-display").textContent = `${trialCache.title} (${trialCache.period})`;
    const tbody = document.querySelector("#trial-tbody");
    const tfoot = document.querySelector("#trial-tfoot");
    if (!trialCache.rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#6b7280;padding:20px">Sin cuentas registradas para generar la Balanza de Comprobación.</td></tr>`;
      tfoot.innerHTML = "";
      return;
    }
    tbody.innerHTML = trialCache.rows
      .map(
        (r) => `<tr>
          <td><span class="code-badge">${escapeHtml(r.code)}</span></td>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.groupingCode || "-")}</td>
          <td class="num-col">${money(r.opening)}</td>
          <td class="num-col">${money(r.debit)}</td>
          <td class="num-col">${money(r.credit)}</td>
          <td class="num-col"><strong>${money(r.closing)}</strong></td>
        </tr>`
      )
      .join("");
    tfoot.innerHTML = `<tr>
      <td colspan="3">Totales (${trialCache.rows.length} cuentas)</td>
      <td class="num-col">${money(trialCache.totals.opening)}</td>
      <td class="num-col">${money(trialCache.totals.debit)}</td>
      <td class="num-col">${money(trialCache.totals.credit)}</td>
      <td class="num-col">${money(trialCache.totals.closing)}</td>
    </tr>`;
  }

  // -------------------- 5. ESTADOS FINANCIEROS --------------------
  async function loadStatements() {
    const period = document.querySelector("#stmt-period").value;
    const currency = document.querySelector("#stmt-currency").value;
    const data = await api(`/api/ledger/statements?period=${encodeURIComponent(period)}&currency=${encodeURIComponent(currency)}`);
    statementsCache = data.statements;
    renderStatements();
  }

  function renderStatements() {
    if (!statementsCache) return;
    const type = document.querySelector("#stmt-type").value;
    const sym = statementsCache.currencySymbol || "L";
    document.querySelector("#stmt-rate-banner").textContent =
      statementsCache.currency === "USD"
        ? `Cifras expresadas en Dólares ($USD) convirtiendo con tipo de cambio L ${Number(statementsCache.exchangeRate).toFixed(4)} por $1 USD.`
        : `Cifras expresadas en Lempiras ($LEM / HNL). Tipo de cambio de referencia: L ${Number(statementsCache.exchangeRate).toFixed(4)} por $1 USD.`;

    const thead = document.querySelector("#stmt-thead");
    const tbody = document.querySelector("#stmt-tbody");
    const tfoot = document.querySelector("#stmt-tfoot");

    if (type === "income") {
      const inc = statementsCache.incomeStatement;
      thead.innerHTML = `<tr><th>Rubro / Concepto</th><th class="num-col">Importe (${sym})</th><th class="num-col">% Sobre Ventas</th></tr>`;
      const pct = (val) => (inc.income ? ((Number(val) / Number(inc.income)) * 100).toFixed(2) + "%" : "0.00%");
      tbody.innerHTML = `
        <tr><td><strong>Ingresos / Ventas Netas</strong></td><td class="num-col"><strong>${sym} ${money(inc.income)}</strong></td><td class="num-col">${pct(inc.income)}</td></tr>
        <tr><td>(-) Costo de Ventas</td><td class="num-col">${sym} ${money(inc.cost)}</td><td class="num-col">${pct(inc.cost)}</td></tr>
        <tr style="background:#f8fafc"><td><strong>(=) Utilidad Bruta</strong></td><td class="num-col"><strong>${sym} ${money(inc.grossProfit)}</strong></td><td class="num-col"><strong>${pct(inc.grossProfit)}</strong></td></tr>
        <tr><td>(-) Gastos Generales de Operación</td><td class="num-col">${sym} ${money(inc.expenses)}</td><td class="num-col">${pct(inc.expenses)}</td></tr>
        <tr style="background:#f8fafc"><td><strong>(=) Utilidad de Operación</strong></td><td class="num-col"><strong>${sym} ${money(inc.operatingProfit)}</strong></td><td class="num-col"><strong>${pct(inc.operatingProfit)}</strong></td></tr>
        <tr><td>(+) Otros Ingresos / Productos Financieros</td><td class="num-col">${sym} ${money(inc.otherIncome)}</td><td class="num-col">${pct(inc.otherIncome)}</td></tr>
        <tr><td>(-) Otros Gastos / Gastos Financieros</td><td class="num-col">${sym} ${money(inc.otherExpense)}</td><td class="num-col">${pct(inc.otherExpense)}</td></tr>
      `;
      tfoot.innerHTML = `<tr><td>UTILIDAD / RESULTADO NETO DEL PERIODO</td><td class="num-col">${sym} ${money(inc.netProfit)}</td><td class="num-col">${pct(inc.netProfit)}</td></tr>`;
    } else {
      const bal = statementsCache.balanceSheet;
      thead.innerHTML = `<tr><th>Clasificación</th><th>Cuenta</th><th class="num-col">Saldo (${sym})</th></tr>`;
      const renderGroup = (label, list) =>
        list.length
          ? list.map((item) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(item.code)} - ${escapeHtml(item.name)}</td><td class="num-col">${sym} ${money(item.amount)}</td></tr>`).join("")
          : `<tr><td>${escapeHtml(label)}</td><td style="color:#6b7280">Sin saldos registrados</td><td class="num-col">${sym} 0.00</td></tr>`;
      tbody.innerHTML = [
        renderGroup("Activo Circulante", bal.sections.currentAssets),
        renderGroup("Activo No Circulante", bal.sections.nonCurrentAssets),
        `<tr style="background:#eff6ff;font-weight:700"><td colspan="2">TOTAL ACTIVO</td><td class="num-col">${sym} ${money(bal.totals.assets)}</td></tr>`,
        renderGroup("Pasivo a Corto Plazo", bal.sections.currentLiabilities),
        renderGroup("Pasivo a Largo Plazo", bal.sections.longLiabilities),
        renderGroup("Capital Contable", bal.sections.equity),
      ].join("");
      tfoot.innerHTML = `<tr><td colspan="2">TOTAL PASIVO + CAPITAL CONTABLE</td><td class="num-col">${sym} ${money(bal.totals.liabilitiesAndEquity)}</td></tr>`;
    }
  }

  // -------------------- 6. TIPO DE CAMBIO --------------------
  async function loadExchangeRates() {
    const data = await api("/api/ledger/exchange-rates");
    ratesCache = data.exchangeRates || [];
    const tbody = document.querySelector("#rates-tbody");
    if (!ratesCache.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#6b7280;padding:20px">No hay tipos de cambio registrados. Registra el tipo de cambio ($LEM por $1 USD) arriba.</td></tr>`;
      return;
    }
    tbody.innerHTML = ratesCache
      .map(
        (r) => `<tr>
          <td><strong>${escapeHtml(r.rateDate)}</strong></td>
          <td>$1.00 USD</td>
          <td class="num-col"><strong>L ${Number(r.rate).toFixed(4)}</strong></td>
          <td>${escapeHtml(r.notes || "-")}</td>
          <td><button type="button" class="mini-btn danger" data-del-rate="${r.id}">Eliminar</button></td>
        </tr>`
      )
      .join("");
  }

  function loadCurrentView() {
    if (currentView === "cuentas") return loadAccounts().catch((e) => showToast(e.message, true));
    if (currentView === "polizas") return loadPolicies().catch((e) => showToast(e.message, true));
    if (currentView === "auxiliares") return loadAuxiliary().catch((e) => showToast(e.message, true));
    if (currentView === "balanza") return loadTrialBalance().catch((e) => showToast(e.message, true));
    if (currentView === "estados") return loadStatements().catch((e) => showToast(e.message, true));
    if (currentView === "tipocambio") return loadExchangeRates().catch((e) => showToast(e.message, true));
  }

  // -------------------- EVENTOS --------------------
  document.querySelectorAll(".coi-flow-step[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Cuentas
  document.querySelector("#accounts-search").addEventListener("input", () => loadAccounts());
  document.querySelector("#accounts-period").addEventListener("change", () => loadAccounts());
  document.querySelector("#btn-new-account").addEventListener("click", () => openAccountForm(null));
  document.querySelector("#acc-cancel").addEventListener("click", () => {
    document.querySelector("#account-form").hidden = true;
  });
  document.querySelector("#account-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const id = document.querySelector("#acc-id").value;
      const body = {
        code: document.querySelector("#acc-code").value,
        name: document.querySelector("#acc-name").value,
        groupingCode: document.querySelector("#acc-group").value,
        accountType: document.querySelector("#acc-type").value,
        openingBalance: Number(document.querySelector("#acc-opening").value || 0),
        currency: document.querySelector("#acc-currency").value,
      };
      if (id) {
        await api(`/api/ledger/accounts/${id}`, { method: "PUT", body });
        showToast("Cuenta actualizada correctamente.");
      } else {
        await api("/api/ledger/accounts", { method: "POST", body });
        showToast("Cuenta registrada en el catálogo.");
      }
      document.querySelector("#account-form").hidden = true;
      await loadAccounts();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  document.querySelector("#accounts-tbody").addEventListener("click", async (e) => {
    const editId = e.target.closest("[data-edit-acc]")?.dataset.editAcc;
    if (editId) {
      const acc = accountsCache.find((a) => String(a.id) === String(editId));
      if (acc) openAccountForm(acc);
      return;
    }
    const delId = e.target.closest("[data-del-acc]")?.dataset.delAcc;
    if (delId) {
      try {
        await api(`/api/ledger/accounts/${delId}`, { method: "DELETE" });
        showToast("Cuenta eliminada.");
        await loadAccounts();
      } catch (error) {
        showToast(error.message, true);
      }
    }
  });

  document.querySelector("#accounts-excel").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#accounts-table"));
    window.gestionExport.toExcel({ filename: "catalogo-cuentas", sheetName: "Cuentas", title: "Catálogo de Cuentas", columns, rows });
  });
  document.querySelector("#accounts-pdf").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#accounts-table"));
    window.gestionExport.toPdf({ filename: "catalogo-cuentas", title: "Catálogo de Cuentas", columns, rows });
  });

  // Polizas
  document.querySelector("#policy-filter-period").addEventListener("change", () => loadPolicies());
  document.querySelector("#policy-filter-type").addEventListener("change", () => loadPolicies());
  document.querySelector("#btn-new-policy").addEventListener("click", () => openPolicyForm(null));
  document.querySelector("#pol-cancel").addEventListener("click", () => {
    document.querySelector("#policy-form").hidden = true;
  });
  document.querySelector("#pol-currency").addEventListener("change", (e) => {
    document.querySelector("#pol-rate-wrap").hidden = e.target.value !== "USD";
  });
  document.querySelector("#pol-add-line").addEventListener("click", () => addPolicyLineRow());
  document.querySelector("#pol-lines-tbody").addEventListener("input", () => recalcPolicyTotals());
  document.querySelector("#pol-lines-tbody").addEventListener("click", (e) => {
    const btn = e.target.closest(".pol-remove-line");
    if (!btn) return;
    const tbody = document.querySelector("#pol-lines-tbody");
    if (tbody.children.length <= 2) {
      showToast("La póliza requiere mínimo 2 partidas.", true);
      return;
    }
    btn.closest("tr").remove();
    recalcPolicyTotals();
  });

  document.querySelector("#policy-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const id = document.querySelector("#pol-id").value;
      const lines = [...document.querySelectorAll("#pol-lines-tbody tr")].map((tr) => ({
        accountCode: tr.querySelector(".pol-line-acc").value.trim(),
        concept: tr.querySelector(".pol-line-concept").value.trim(),
        debit: Number(tr.querySelector(".pol-line-debit").value || 0),
        credit: Number(tr.querySelector(".pol-line-credit").value || 0),
      }));
      const body = {
        policyType: document.querySelector("#pol-type").value,
        policyDate: document.querySelector("#pol-date").value,
        concept: document.querySelector("#pol-concept").value,
        currency: document.querySelector("#pol-currency").value,
        exchangeRate: Number(document.querySelector("#pol-rate").value || 1),
        lines,
      };
      if (id) {
        await api(`/api/ledger/policies/${id}`, { method: "PUT", body });
        showToast("Póliza actualizada.");
      } else {
        await api("/api/ledger/policies", { method: "POST", body });
        showToast("Póliza registrada correctamente.");
      }
      document.querySelector("#policy-form").hidden = true;
      await loadPolicies();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  document.querySelector("#policies-tbody").addEventListener("click", async (e) => {
    const editId = e.target.closest("[data-edit-pol]")?.dataset.editPol;
    if (editId) {
      const p = policiesCache.find((x) => String(x.id) === String(editId));
      if (p) openPolicyForm(p);
      return;
    }
    const pdfId = e.target.closest("[data-pdf-pol]")?.dataset.pdfPol;
    if (pdfId) {
      const p = policiesCache.find((x) => String(x.id) === String(pdfId));
      if (p) {
        window.gestionExport.toPdf({
          filename: `poliza-${p.folio}`,
          title: `Póliza ${p.folio} (${p.policyTypeLabel})`,
          subtitle: `Fecha: ${p.policyDate} | Concepto: ${p.concept} | Moneda: ${p.currency}`,
          columns: ["#", "Cuenta", "Nombre Cuenta", "Concepto", "Debe (Cargo)", "Haber (Abono)"],
          rows: p.lines.map((l) => [l.lineNo, l.accountCode, l.accountName, l.concept, money(l.debit), money(l.credit)]),
          totals: ["", "", "", "Totales", money(p.totalDebit), money(p.totalCredit)],
        });
      }
      return;
    }
    const cancelId = e.target.closest("[data-cancel-pol]")?.dataset.cancelPol;
    if (cancelId) {
      try {
        await api(`/api/ledger/policies/${cancelId}`, { method: "DELETE" });
        showToast("Póliza cancelada.");
        await loadPolicies();
      } catch (error) {
        showToast(error.message, true);
      }
    }
  });

  document.querySelector("#policies-excel").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#policies-table"));
    window.gestionExport.toExcel({ filename: "polizas-contables", sheetName: "Polizas", title: "Listado de Pólizas Contables", columns, rows });
  });
  document.querySelector("#policies-pdf").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#policies-table"));
    window.gestionExport.toPdf({ filename: "polizas-contables", title: "Listado de Pólizas Contables", columns, rows });
  });

  // Auxiliares
  document.querySelector("#aux-query").addEventListener("click", () => loadAuxiliary());
  function flattenAuxiliaryRows() {
    const rows = [];
    (auxiliaryCache?.accounts || []).forEach((acc) => {
      rows.push([acc.code, acc.name, "SALDO INICIAL", "", money(acc.openingBalance), "0.00", money(acc.openingBalance)]);
      acc.movements.forEach((m) => {
        rows.push([acc.code, acc.name, m.date, `${m.folio} - ${m.concept}`, money(m.debit), money(m.credit), money(m.balance)]);
      });
    });
    return {
      columns: ["Cuenta", "Descripción", "Fecha", "Póliza / Concepto", "Debe", "Haber", "Saldo"],
      rows,
    };
  }
  document.querySelector("#aux-excel").addEventListener("click", () => {
    const { columns, rows } = flattenAuxiliaryRows();
    window.gestionExport.toExcel({ filename: `auxiliar-${auxiliaryCache?.period || "periodo"}`, sheetName: "Auxiliar", title: "Auxiliar de Cuentas", columns, rows });
  });
  document.querySelector("#aux-pdf").addEventListener("click", () => {
    const { columns, rows } = flattenAuxiliaryRows();
    window.gestionExport.toPdf({ filename: `auxiliar-${auxiliaryCache?.period || "periodo"}`, title: `Auxiliar de Cuentas (${auxiliaryCache?.period || ""})`, columns, rows });
  });

  // Balanza
  document.querySelector("#trial-refresh").addEventListener("click", () => loadTrialBalance());
  document.querySelector("#trial-title").addEventListener("input", (e) => {
    document.querySelector("#trial-heading-display").textContent = `${e.target.value || "Balanza de Comprobacion"} (${document.querySelector("#trial-period").value})`;
  });
  document.querySelector("#trial-excel").addEventListener("click", () => {
    const title = document.querySelector("#trial-title").value || "Balanza de Comprobación";
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#trial-table"));
    window.gestionExport.toExcel({ filename: "balanza-comprobacion", sheetName: "Balanza", title, columns, rows });
  });
  document.querySelector("#trial-pdf").addEventListener("click", () => {
    const title = document.querySelector("#trial-title").value || "Balanza de Comprobación";
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#trial-table"));
    window.gestionExport.toPdf({ filename: "balanza-comprobacion", title, subtitle: `Periodo: ${document.querySelector("#trial-period").value}`, columns, rows });
  });

  // Estados financieros
  document.querySelector("#stmt-refresh").addEventListener("click", () => loadStatements());
  document.querySelector("#stmt-type").addEventListener("change", () => renderStatements());
  document.querySelector("#stmt-currency").addEventListener("change", () => loadStatements());
  document.querySelector("#stmt-period").addEventListener("change", () => loadStatements());
  document.querySelector("#stmt-excel").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#stmt-table"), { skipColumns: [] });
    window.gestionExport.toExcel({ filename: "estado-financiero", sheetName: "Estado", title: document.querySelector("#stmt-type").selectedOptions[0].textContent, columns, rows });
  });
  document.querySelector("#stmt-pdf").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#stmt-table"), { skipColumns: [] });
    window.gestionExport.toPdf({
      filename: "estado-financiero",
      title: document.querySelector("#stmt-type").selectedOptions[0].textContent,
      subtitle: document.querySelector("#stmt-rate-banner").textContent,
      columns,
      rows,
    });
  });

  // Tipo de cambio
  document.querySelector("#rate-date").value = new Date().toISOString().slice(0, 10);
  document.querySelector("#rate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/ledger/exchange-rates", {
        method: "POST",
        body: {
          rateDate: document.querySelector("#rate-date").value,
          rate: Number(document.querySelector("#rate-value").value),
          notes: document.querySelector("#rate-notes").value,
        },
      });
      showToast("Tipo de cambio guardado.");
      document.querySelector("#rate-value").value = "";
      document.querySelector("#rate-notes").value = "";
      await loadExchangeRates();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  document.querySelector("#rates-tbody").addEventListener("click", async (e) => {
    const delId = e.target.closest("[data-del-rate]")?.dataset.delRate;
    if (!delId) return;
    try {
      await api(`/api/ledger/exchange-rates/${delId}`, { method: "DELETE" });
      showToast("Tipo de cambio eliminado.");
      await loadExchangeRates();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  document.querySelector("#rates-excel").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#rates-table"));
    window.gestionExport.toExcel({ filename: "tipos-de-cambio", sheetName: "TipoCambio", title: "Historial de Tipos de Cambio ($USD / $LEM)", columns, rows });
  });
  document.querySelector("#rates-pdf").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#rates-table"));
    window.gestionExport.toPdf({ filename: "tipos-de-cambio", title: "Historial de Tipos de Cambio ($USD / $LEM)", columns, rows });
  });

  function renderCoiMetrics() {
    const metricsEl = document.querySelector("#coi-metrics");
    if (!metricsEl) return;
    const totalClose = accountsCache.reduce((s, a) => s + Number(a.closingBalance || 0), 0);
    const totalDebit = policiesCache.reduce((s, p) => s + Number(p.totalDebit || 0), 0);
    const latestRate = ratesCache[0]?.rate || statementsCache?.exchangeRate || 24.75;
    const cards = [
      ["Cuentas en catalogo", String(accountsCache.length), "Cuentas contables activas"],
      ["Saldo neto acumulado", `L ${money(totalClose)}`, "En cuentas del periodo"],
      ["Polizas registradas", String(policiesCache.length), `Cargos: L ${money(totalDebit)}`],
      ["Tipo de cambio USD/LEM", `L ${Number(latestRate).toFixed(4)}`, "Conversion $USD ↔ $LEM"],
    ];
    metricsEl.innerHTML = cards
      .map(([label, val, sub]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(val)}</strong><small>${escapeHtml(sub)}</small></article>`)
      .join("");
  }

  window.addEventListener("gestion:company-changed", () => {
    accountsCache = [];
    policiesCache = [];
    loadCurrentView();
  });

  switchView(currentView, false);
  renderCoiMetrics();
})();
