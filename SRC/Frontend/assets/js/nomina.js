(function () {
  const VIEW_META = {
    empleados: { title: "Datos Personales, Salario y Nómina al Correo [SI/NO]", crumb: "Datos Personales y Salario" },
    conceptos: { title: "Conceptos para la Nómina (P001-P050 / D001-D050)", crumb: "Conceptos de Nómina" },
    nominas: { title: "Captura y Reporte de Nómina", crumb: "Reporte de Nómina" },
    acumulados: { title: "Reporte de Acumulados por Periodo de Tiempo", crumb: "Reporte de Acumulados" },
    cierre: { title: "Cierre de Nómina (No permitir más nóminas)", crumb: "Cierre de Nómina" },
  };

  let currentView = new URLSearchParams(window.location.search).get("vista") || "empleados";
  if (!VIEW_META[currentView]) currentView = "empleados";

  let employeesCache = [];
  let conceptsCache = [];
  let receiptsCache = [];
  let accumulatedCache = null;
  let closuresCache = [];

  const toastEl = document.querySelector("#noi-toast");

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
    if (!VIEW_META[viewKey]) viewKey = "empleados";
    currentView = viewKey;
    document.querySelectorAll(".coi-flow-step[data-view]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewKey);
    });
    Object.keys(VIEW_META).forEach((key) => {
      const section = document.querySelector(`#view-${key}`);
      if (section) section.hidden = key !== viewKey;
    });
    document.querySelector("#noi-title").textContent = VIEW_META[viewKey].title;
    document.querySelector("#noi-crumb").textContent = VIEW_META[viewKey].crumb;
    if (pushUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("vista", viewKey);
      window.history.replaceState({}, "", url.toString());
    }
    loadCurrentView();
  }

  function renderNoiMetrics() {
    const metricsEl = document.querySelector("#noi-metrics");
    if (!metricsEl) return;
    const totalEmp = employeesCache.length;
    const emailSi = employeesCache.filter((e) => e.payrollEmailEnabled).length;
    const totalP = conceptsCache.filter((c) => c.conceptType === "P").length;
    const totalD = conceptsCache.filter((c) => c.conceptType === "D").length;
    const totalNet = receiptsCache.reduce((acc, r) => acc + Number(r.netPay || 0), 0);
    metricsEl.innerHTML = [
      { label: "Trabajadores en nómina", value: String(totalEmp), delta: `${emailSi} con envío por correo (SI)` },
      { label: "Conceptos P001-P050 / D001-D050", value: String(conceptsCache.length), delta: `${totalP} percepciones · ${totalD} deducciones` },
      { label: "Recibos del periodo", value: String(receiptsCache.length), delta: `Neto: ${money(totalNet)}` },
      { label: "Periodos cerrados", value: String(closuresCache.length), delta: "Cierre de nómina NOI 11.00.20" },
    ]
      .map(
        (m) => `
        <article>
          <p class="metric-label">${escapeHtml(m.label)}</p>
          <p class="metric-value">${escapeHtml(m.value)}</p>
          <p class="metric-delta">${escapeHtml(m.delta)}</p>
        </article>`
      )
      .join("");
  }

  // -------------------- 1. DATOS PERSONALES / SALARIO / NOMINA AL CORREO SI/NO --------------------
  async function loadEmployees() {
    const data = await api("/api/payroll/employees");
    employeesCache = data.employees || [];
    renderEmployeesTable();
    populateEmployeeSelect();
    renderNoiMetrics();
  }

  function renderEmployeesTable() {
    const term = document.querySelector("#emp-search").value.trim().toLowerCase();
    const filtered = employeesCache.filter((e) =>
      [e.fullName, e.email, e.position, e.branch, e.bankAccount, e.identityNumber, e.taxNumber]
        .join(" ")
        .toLowerCase()
        .includes(term)
    );
    const tbody = document.querySelector("#noi-emp-tbody");
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#6b7280;padding:20px">No hay trabajadores registrados en esta empresa. Usa <b>+ Registrar Trabajador</b> para dar de alta personal.</td></tr>`;
      return;
    }
    tbody.innerHTML = filtered
      .map(
        (e) => `<tr>
          <td><strong>${e.workerNo}</strong></td>
          <td><strong>${escapeHtml(e.fullName)}</strong><br><small style="color:#6b7280">${escapeHtml(e.email)} · ${escapeHtml(e.gender)}</small></td>
          <td>${escapeHtml(e.position)} (${escapeHtml(e.branch)})<br><small style="color:#6b7280">DNI: ${escapeHtml(e.identityNumber || "-")} · RTN: ${escapeHtml(e.taxNumber || "-")}</small></td>
          <td><code>${escapeHtml(e.bankAccount || "Sin cuenta")}</code></td>
          <td class="num-col"><strong>${money(e.baseSalary)}</strong></td>
          <td>${escapeHtml(e.paymentFrequency)}</td>
          <td><span class="yes-no-pill ${e.payrollEmailEnabled ? "yes" : "no"}">${e.payrollEmailEnabled ? "SI" : "NO"}</span></td>
          <td>
            <button type="button" class="mini-btn" data-edit-emp="${e.id}">Configurar Salario / Correo</button>
            <a class="mini-btn" href="./empleado.html?id=${e.id}" style="text-decoration:none">Expediente</a>
          </td>
        </tr>`
      )
      .join("");
  }

  function populateEmployeeSelect() {
    const sel = document.querySelector("#rec-employee");
    if (!sel) return;
    if (!employeesCache.length) {
      sel.innerHTML = `<option value="">Sin trabajadores registrados</option>`;
      return;
    }
    sel.innerHTML = employeesCache
      .map((e) => `<option value="${e.id}">${e.workerNo}. ${escapeHtml(e.fullName)} - Salario: ${money(e.baseSalary)} (${escapeHtml(e.paymentFrequency)})</option>`)
      .join("");
    syncReceiptEmployeeDefaults();
  }

  function syncReceiptEmployeeDefaults() {
    const sel = document.querySelector("#rec-employee");
    const emp = employeesCache.find((e) => String(e.id) === String(sel?.value));
    if (!emp) return;
    document.querySelector("#rec-frequency").value = emp.paymentFrequency || "Quincenal";
    document.querySelector("#rec-account").value = emp.bankAccount || "";
    document.querySelector("#rec-base-salary").value = Number(emp.baseSalary || 0).toFixed(2);
  }

  // -------------------- 2. CONCEPTOS (P001-P050 / D001-D050) --------------------
  function updateConceptKeyPreview() {
    const type = document.querySelector("#con-type").value === "D" ? "D" : "P";
    const numVal = Math.min(Math.max(Number(document.querySelector("#con-number").value || 1), 1), 50);
    document.querySelector("#con-key-preview").value = `${type}${String(numVal).padStart(3, "0")}`;
  }

  async function loadConcepts() {
    const data = await api("/api/payroll/concepts");
    conceptsCache = data.concepts || [];
    renderNoiMetrics();
    const tbody = document.querySelector("#concepts-tbody");
    const datalist = document.querySelector("#payroll-concepts-datalist");
    if (datalist) {
      datalist.innerHTML = conceptsCache
        .map((c) => `<option value="${escapeHtml(c.conceptKey)}">${escapeHtml(c.conceptKey)} - ${escapeHtml(c.description)}</option>`)
        .join("");
    }
    if (!conceptsCache.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:20px">No hay conceptos registrados. Captura arriba un concepto <b>P001..P050</b> (Prestación) o <b>D001..D050</b> (Deducción).</td></tr>`;
      return;
    }
    tbody.innerHTML = conceptsCache
      .map(
        (c) => `<tr>
          <td><span class="code-badge">${escapeHtml(c.conceptKey)}</span></td>
          <td>${escapeHtml(c.conceptTypeLabel)}</td>
          <td><strong>${escapeHtml(c.description)}</strong></td>
          <td>${escapeHtml(c.integratesSalary)}</td>
          <td class="num-col"><strong>${money(c.accumulated)}</strong></td>
          <td><button type="button" class="mini-btn danger" data-del-con="${c.id}">Eliminar</button></td>
        </tr>`
      )
      .join("");
  }

  // -------------------- 3. CAPTURA Y REPORTE DE NOMINA --------------------
  async function loadReceipts() {
    if (!employeesCache.length) await loadEmployees();
    if (!conceptsCache.length) await loadConcepts();
    const period = document.querySelector("#pay-filter-period").value;
    const data = await api(`/api/payroll/receipts?period=${encodeURIComponent(period)}`);
    receiptsCache = data.receipts || [];
    const closedAlert = document.querySelector("#payroll-closed-alert");
    const newBtn = document.querySelector("#btn-new-receipt");
    if (data.periodClosed) {
      closedAlert.hidden = false;
      newBtn.disabled = true;
    } else {
      closedAlert.hidden = true;
      newBtn.disabled = false;
    }
    renderReceiptsTable();
    renderNoiMetrics();
  }

  function renderReceiptsTable() {
    const tbody = document.querySelector("#receipts-tbody");
    const tfoot = document.querySelector("#receipts-tfoot");
    if (!receiptsCache.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#6b7280;padding:20px">No hay nóminas emitidas en este periodo.</td></tr>`;
      tfoot.innerHTML = "";
      return;
    }
    let sumP = 0;
    let sumD = 0;
    let sumNet = 0;
    tbody.innerHTML = receiptsCache
      .map((r) => {
        sumP += Number(r.totalPerceptions || 0);
        sumD += Number(r.totalDeductions || 0);
        sumNet += Number(r.netPay || 0);
        const emp = r.employee || {};
        return `<tr>
          <td><strong>${r.rowNo}</strong></td>
          <td><strong>${escapeHtml(emp.fullName)}</strong><br><small style="color:#6b7280">${escapeHtml(r.paymentFrequency)} · ${escapeHtml(r.payDate)}</small></td>
          <td>
            <code>${escapeHtml(r.bankAccount || "Sin cuenta")}</code><br>
            <small style="color:#4b5563">Puesto: ${escapeHtml(emp.position || "-")} · DNI: ${escapeHtml(emp.identityNumber || "-")} · Correo: ${escapeHtml(emp.email || "-")}</small>
          </td>
          <td class="num-col">${money(r.totalPerceptions)}</td>
          <td class="num-col">${money(r.totalDeductions)}</td>
          <td class="num-col"><strong>${money(r.netPay)}</strong></td>
          <td><span class="yes-no-pill ${emp.payrollEmailEnabled ? "yes" : "no"}">${emp.payrollEmailEnabled ? "SI" : "NO"}</span></td>
          <td>
            <button type="button" class="mini-btn" data-pdf-rec="${r.id}">PDF Recibo</button>
            <button type="button" class="mini-btn" data-mail-rec="${r.id}">Enviar Correo</button>
            <button type="button" class="mini-btn danger" data-del-rec="${r.id}">Eliminar</button>
          </td>
        </tr>`;
      })
      .join("");
    tfoot.innerHTML = `<tr>
      <td colspan="3">Totales de Nómina (${receiptsCache.length} trabajadores)</td>
      <td class="num-col">${money(sumP)}</td>
      <td class="num-col">${money(sumD)}</td>
      <td class="num-col">${money(sumNet)}</td>
      <td colspan="2"></td>
    </tr>`;
  }

  function addReceiptConceptLine(line = { conceptKey: "P002", conceptType: "P", description: "", amount: "" }) {
    const tbody = document.querySelector("#rec-lines-tbody");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" list="payroll-concepts-datalist" class="rec-line-key" value="${escapeHtml(line.conceptKey)}" placeholder="P002 o D001" required /></td>
      <td>
        <select class="rec-line-type">
          <option value="P"${line.conceptType === "P" ? " selected" : ""}>Prestación (P)</option>
          <option value="D"${line.conceptType === "D" ? " selected" : ""}>Deducción (D)</option>
        </select>
      </td>
      <td><input type="text" class="rec-line-desc" value="${escapeHtml(line.description)}" placeholder="Descripción del concepto" required /></td>
      <td><input type="number" step="0.01" min="0" class="rec-line-amount num-col" value="${line.amount}" placeholder="0.00" required /></td>
      <td><button type="button" class="mini-btn danger rec-remove-line">✕</button></td>
    `;
    tbody.appendChild(tr);
  }

  // -------------------- 4. REPORTE DE ACUMULADOS --------------------
  async function loadAccumulated() {
    const from = document.querySelector("#acc-from").value;
    const to = document.querySelector("#acc-to").value;
    const data = await api(`/api/payroll/accumulated?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    accumulatedCache = data.accumulated;

    const conTbody = document.querySelector("#accum-concepts-tbody");
    if (!accumulatedCache.byConcept.length) {
      conTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#6b7280;padding:18px">Sin conceptos acumulados en el periodo ${escapeHtml(from)} a ${escapeHtml(to)}.</td></tr>`;
    } else {
      conTbody.innerHTML = accumulatedCache.byConcept
        .map(
          (c) => `<tr>
            <td><span class="code-badge">${escapeHtml(c.conceptKey)}</span></td>
            <td>${c.conceptType === "P" ? "Prestación / Percepción (P)" : "Deducción (D)"}</td>
            <td>${escapeHtml(c.description)}</td>
            <td class="num-col">${c.receiptsCount}</td>
            <td class="num-col"><strong>${money(c.totalAmount)}</strong></td>
          </tr>`
        )
        .join("");
    }

    const empTbody = document.querySelector("#accum-emp-tbody");
    if (!accumulatedCache.byEmployee.length) {
      empTbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#6b7280;padding:18px">Sin nóminas emitidas para trabajadores en este rango de tiempo.</td></tr>`;
    } else {
      empTbody.innerHTML = accumulatedCache.byEmployee
        .map(
          (e) => `<tr>
            <td><strong>${e.workerNo}</strong></td>
            <td><strong>${escapeHtml(e.fullName)}</strong></td>
            <td>${escapeHtml(e.position)}</td>
            <td><code>${escapeHtml(e.bankAccount)}</code></td>
            <td class="num-col">${money(e.perceptions)}</td>
            <td class="num-col">${money(e.deductions)}</td>
            <td class="num-col"><strong>${money(e.netPay)}</strong></td>
          </tr>`
        )
        .join("");
    }
  }

  // -------------------- 5. CIERRE DE NOMINA --------------------
  async function loadClosures() {
    const data = await api("/api/payroll/closures");
    closuresCache = data.closures || [];
    renderNoiMetrics();
    const tbody = document.querySelector("#closures-tbody");
    if (!closuresCache.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#6b7280;padding:18px">No hay periodos cerrados todavía.</td></tr>`;
      return;
    }
    tbody.innerHTML = closuresCache
      .map(
        (c) => `<tr>
          <td><strong>${escapeHtml(c.period)}</strong></td>
          <td><span class="yes-no-pill no">CERRADO (No permite más nóminas)</span></td>
          <td>${escapeHtml(c.notes)}</td>
          <td>${escapeHtml(String(c.closedAt).slice(0, 19).replace("T", " "))}</td>
        </tr>`
      )
      .join("");
  }

  function loadCurrentView() {
    if (currentView === "empleados") return loadEmployees().catch((e) => showToast(e.message, true));
    if (currentView === "conceptos") return loadConcepts().catch((e) => showToast(e.message, true));
    if (currentView === "nominas") return loadReceipts().catch((e) => showToast(e.message, true));
    if (currentView === "acumulados") return loadAccumulated().catch((e) => showToast(e.message, true));
    if (currentView === "cierre") return loadClosures().catch((e) => showToast(e.message, true));
  }

  // -------------------- EVENTOS --------------------
  document.querySelectorAll(".coi-flow-step[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Vista 1: Empleados
  document.querySelector("#emp-search").addEventListener("input", () => renderEmployeesTable());
  document.querySelector("#noi-emp-tbody").addEventListener("click", (e) => {
    const id = e.target.closest("[data-edit-emp]")?.dataset.editEmp;
    if (!id) return;
    const emp = employeesCache.find((x) => String(x.id) === String(id));
    if (!emp) return;
    const form = document.querySelector("#emp-payroll-form");
    form.hidden = false;
    document.querySelector("#emp-payroll-form-title").textContent = `Parámetros de Nómina: ${emp.fullName}`;
    document.querySelector("#emp-edit-id").value = emp.id;
    document.querySelector("#emp-edit-salary").value = Number(emp.baseSalary || 0).toFixed(2);
    document.querySelector("#emp-edit-freq").value = emp.paymentFrequency || "Quincenal";
    document.querySelector("#emp-edit-account").value = emp.bankAccount || "";
    document.querySelector("#emp-edit-email-flag").value = emp.payrollEmailEnabled ? "SI" : "NO";
  });
  document.querySelector("#emp-edit-cancel").addEventListener("click", () => {
    document.querySelector("#emp-payroll-form").hidden = true;
  });
  document.querySelector("#emp-payroll-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const id = document.querySelector("#emp-edit-id").value;
      await api(`/api/payroll/employees/${id}`, {
        method: "PUT",
        body: {
          baseSalary: Number(document.querySelector("#emp-edit-salary").value || 0),
          paymentFrequency: document.querySelector("#emp-edit-freq").value,
          bankAccount: document.querySelector("#emp-edit-account").value,
          payrollEmailEnabled: document.querySelector("#emp-edit-email-flag").value,
        },
      });
      showToast("Salario, cuenta y preferencia de correo actualizados.");
      document.querySelector("#emp-payroll-form").hidden = true;
      await loadEmployees();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  document.querySelector("#emp-excel").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#noi-emp-table"));
    window.gestionExport.toExcel({ filename: "trabajadores-nomina", sheetName: "Trabajadores", title: "Padrón de Trabajadores y Salarios", columns, rows });
  });
  document.querySelector("#emp-pdf").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#noi-emp-table"));
    window.gestionExport.toPdf({ filename: "trabajadores-nomina", title: "Padrón de Trabajadores y Salarios", columns, rows });
  });

  // Vista 2: Conceptos
  document.querySelector("#con-type").addEventListener("change", updateConceptKeyPreview);
  document.querySelector("#con-number").addEventListener("input", updateConceptKeyPreview);
  document.querySelector("#concept-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/payroll/concepts", {
        method: "POST",
        body: {
          conceptType: document.querySelector("#con-type").value,
          conceptNumber: Number(document.querySelector("#con-number").value),
          description: document.querySelector("#con-desc").value,
          integratesSalary: document.querySelector("#con-integrates").value,
        },
      });
      showToast("Concepto de nómina guardado.");
      document.querySelector("#con-desc").value = "";
      await loadConcepts();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  document.querySelector("#concepts-tbody").addEventListener("click", async (e) => {
    const id = e.target.closest("[data-del-con]")?.dataset.delCon;
    if (!id) return;
    try {
      await api(`/api/payroll/concepts/${id}`, { method: "DELETE" });
      showToast("Concepto eliminado.");
      await loadConcepts();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  document.querySelector("#concepts-excel").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#concepts-table"));
    window.gestionExport.toExcel({ filename: "conceptos-nomina", sheetName: "Conceptos", title: "Catálogo de Conceptos de Nómina (P / D)", columns, rows });
  });
  document.querySelector("#concepts-pdf").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#concepts-table"));
    window.gestionExport.toPdf({ filename: "conceptos-nomina", title: "Catálogo de Conceptos de Nómina (P / D)", columns, rows });
  });

  // Vista 3: Nominas y Reporte
  document.querySelector("#pay-filter-period").addEventListener("change", (e) => {
    document.querySelector("#rec-period").value = e.target.value;
    loadReceipts();
  });
  document.querySelector("#rec-employee").addEventListener("change", syncReceiptEmployeeDefaults);
  document.querySelector("#btn-new-receipt").addEventListener("click", () => {
    const form = document.querySelector("#receipt-form");
    form.hidden = false;
    document.querySelector("#rec-period").value = document.querySelector("#pay-filter-period").value || "2026-01";
    document.querySelector("#rec-date").value = `${document.querySelector("#rec-period").value}-15`;
    document.querySelector("#rec-lines-tbody").innerHTML = "";
    syncReceiptEmployeeDefaults();
  });
  document.querySelector("#rec-cancel").addEventListener("click", () => {
    document.querySelector("#receipt-form").hidden = true;
  });
  document.querySelector("#rec-add-line").addEventListener("click", () => addReceiptConceptLine());
  document.querySelector("#rec-lines-tbody").addEventListener("input", (e) => {
    if (e.target.classList.contains("rec-line-key")) {
      const key = e.target.value.trim().toUpperCase();
      const tr = e.target.closest("tr");
      const found = conceptsCache.find((c) => c.conceptKey === key);
      if (found) {
        tr.querySelector(".rec-line-type").value = found.conceptType;
        tr.querySelector(".rec-line-desc").value = found.description;
      } else if (key.startsWith("D")) {
        tr.querySelector(".rec-line-type").value = "D";
      }
    }
  });
  document.querySelector("#rec-lines-tbody").addEventListener("click", (e) => {
    const btn = e.target.closest(".rec-remove-line");
    if (btn) btn.closest("tr").remove();
  });

  document.querySelector("#receipt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const lines = [...document.querySelectorAll("#rec-lines-tbody tr")].map((tr) => ({
        conceptKey: tr.querySelector(".rec-line-key").value.trim().toUpperCase(),
        conceptType: tr.querySelector(".rec-line-type").value,
        description: tr.querySelector(".rec-line-desc").value.trim(),
        amount: Number(tr.querySelector(".rec-line-amount").value || 0),
      }));
      const res = await api("/api/payroll/receipts", {
        method: "POST",
        body: {
          employeeId: Number(document.querySelector("#rec-employee").value),
          period: document.querySelector("#rec-period").value,
          paymentFrequency: document.querySelector("#rec-frequency").value,
          payDate: document.querySelector("#rec-date").value,
          bankAccount: document.querySelector("#rec-account").value,
          baseSalary: Number(document.querySelector("#rec-base-salary").value || 0),
          lines,
        },
      });
      showToast(res.message || "Nómina registrada.");
      document.querySelector("#receipt-form").hidden = true;
      await loadReceipts();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  document.querySelector("#receipts-tbody").addEventListener("click", async (e) => {
    const pdfId = e.target.closest("[data-pdf-rec]")?.dataset.pdfRec;
    if (pdfId) {
      const cid = activeCompanyId();
      window.open(`/api/payroll/receipts/${pdfId}/pdf?companyId=${encodeURIComponent(cid)}`, "_blank");
      return;
    }
    const mailId = e.target.closest("[data-mail-rec]")?.dataset.mailRec;
    if (mailId) {
      try {
        const res = await api(`/api/payroll/receipts/${mailId}/send-email`, { method: "POST", body: {} });
        showToast(res.message);
      } catch (error) {
        showToast(error.message, true);
      }
      return;
    }
    const delId = e.target.closest("[data-del-rec]")?.dataset.delRec;
    if (delId) {
      try {
        await api(`/api/payroll/receipts/${delId}`, { method: "DELETE" });
        showToast("Recibo eliminado.");
        await loadReceipts();
      } catch (error) {
        showToast(error.message, true);
      }
    }
  });

  document.querySelector("#receipts-excel").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#receipts-table"));
    window.gestionExport.toExcel({ filename: `reporte-nomina-${document.querySelector("#pay-filter-period").value}`, sheetName: "Nomina", title: "Reporte de Nómina", columns, rows });
  });
  document.querySelector("#receipts-pdf").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#receipts-table"));
    window.gestionExport.toPdf({ filename: `reporte-nomina-${document.querySelector("#pay-filter-period").value}`, title: `Reporte de Nómina (${document.querySelector("#pay-filter-period").value})`, columns, rows });
  });

  // Vista 4: Acumulados
  document.querySelector("#acc-query").addEventListener("click", () => loadAccumulated());
  document.querySelector("#accum-excel").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#accum-emp-table"), { skipColumns: [] });
    window.gestionExport.toExcel({ filename: "acumulados-nomina", sheetName: "Acumulados", title: "Reporte de Acumulados de Nómina", columns, rows });
  });
  document.querySelector("#accum-pdf").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#accum-emp-table"), { skipColumns: [] });
    window.gestionExport.toPdf({ filename: "acumulados-nomina", title: "Reporte de Acumulados de Nómina", columns, rows });
  });

  // Vista 5: Cierre
  document.querySelector("#closure-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await api("/api/payroll/closures", {
        method: "POST",
        body: {
          period: document.querySelector("#close-period").value,
          notes: document.querySelector("#close-notes").value,
        },
      });
      showToast(res.message);
      document.querySelector("#close-notes").value = "";
      await loadClosures();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  document.querySelector("#closures-excel").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#closures-table"), { skipColumns: [] });
    window.gestionExport.toExcel({ filename: "cierres-nomina", sheetName: "Cierres", title: "Bitácora de Cierres de Nómina", columns, rows });
  });
  document.querySelector("#closures-pdf").addEventListener("click", () => {
    const { columns, rows } = window.gestionExport.tableData(document.querySelector("#closures-table"), { skipColumns: [] });
    window.gestionExport.toPdf({ filename: "cierres-nomina", title: "Bitácora de Cierres de Nómina", columns, rows });
  });

  window.addEventListener("gestion:company-changed", () => loadCurrentView());
  renderNoiMetrics();
  switchView(currentView, false);
})();
