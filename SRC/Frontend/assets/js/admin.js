const approvalList = document.querySelector("#approval-list");
const approvalStatus = document.querySelector("#approval-status");
const companyFilter = document.querySelector("#approval-company");
const statusFilter = document.querySelector("#approval-filter-status");
const rejectionDialog = document.querySelector("#rejection-dialog");
const rejectionForm = document.querySelector("#rejection-form");
const rejectionReason = document.querySelector("#rejection-reason");
let rejectionId = null;

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function setApprovalStatus(message, isError = false) {
  approvalStatus.textContent = message;
  approvalStatus.classList.toggle("approval-error", isError);
  approvalStatus.hidden = false;
  window.clearTimeout(setApprovalStatus.timeout);
  setApprovalStatus.timeout = window.setTimeout(() => {
    approvalStatus.hidden = true;
  }, 3500);
}

function formatDate(value) {
  if (!value) return "-";
  const user = window.gestionUserDb.getCurrentUser();
  return new Intl.DateTimeFormat(user?.locale || "es-HN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)).replace(".", "");
}

function statusClass(status) {
  if (status === "Aprobada") return "complete";
  if (status === "Rechazada") return "pending";
  return "processing";
}

function createApprovalRow(registration) {
  const row = document.createElement("article");
  row.className = "approval-row approval-row-detailed";
  const actions =
    registration.status === "Pendiente"
      ? `
    <div class="approval-actions">
      <button type="button" class="approve-button" data-action="approve" data-id="${registration.id}">Aprobar</button>
      <button type="button" class="reject-button" data-action="reject" data-id="${registration.id}">Rechazar</button>
    </div>`
      : '<span class="approval-processed">Procesada</span>';
  row.innerHTML = `
    <div class="approval-person"><strong>${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)}</strong><span>${escapeHtml(
      registration.email
    )}</span><small>@${escapeHtml(registration.username)}</small></div>
    <span><strong>${escapeHtml(registration.company)}</strong><small>${escapeHtml(registration.companyCode)}</small></span>
    <span>${escapeHtml(registration.role)}</span>
    <span>${formatDate(registration.createdAt)}</span>
    <span><b class="status ${statusClass(registration.status)}">${escapeHtml(registration.status)}</b></span>
    ${actions}`;
  return row;
}

async function loadAdminMetrics() {
  const user = window.gestionUserDb.getCurrentUser();
  const companies = await window.gestionUserDb.listCompanies().catch(() => []);

  if (companyFilter.options.length <= 1) {
    if (user?.isGlobalAdmin) {
      const prev = companyFilter.value;
      companyFilter.innerHTML =
        '<option value="">Todas las empresas</option>' +
        companies.map((company) => `<option value="${company.id}"${String(company.id) === String(prev) ? " selected" : ""}>${escapeHtml(company.name)}</option>`).join("");
    } else {
      companyFilter.innerHTML = companies
        .filter((c) => Number(c.id) === Number(user?.companyId))
        .map((company) => `<option value="${company.id}" selected>${escapeHtml(company.name)}</option>`)
        .join("");
      companyFilter.disabled = true;
    }
  }

  const targetCompanyId = companyFilter.value || (user?.isGlobalAdmin ? "all" : user?.companyId);
  const [employees, auditLogs] = await Promise.all([
    window.gestionUserDb.listEmployees({ status: "Activo", companyId: targetCompanyId }).catch(() => []),
    window.gestionUserDb.getAuditLogs({ limit: 200, companyId: companyFilter.value || user?.companyId }).catch(() => []),
  ]);

  const companyCountEl = document.querySelector("#admin-company-count");
  const employeeCountEl = document.querySelector("#admin-employee-count");
  const auditCountEl = document.querySelector("#admin-audit-count");

  if (companyCountEl) companyCountEl.textContent = String(companies.length || 1);
  if (employeeCountEl) employeeCountEl.textContent = String(employees.length);
  if (auditCountEl) auditCountEl.textContent = String(auditLogs.length);
}

async function loadApprovals() {
  approvalList.innerHTML = '<div class="approval-empty">Cargando solicitudes...</div>';
  try {
    const registrations = await window.gestionUserDb.getRegistrations({ status: statusFilter.value, companyId: companyFilter.value });
    approvalList.innerHTML = "";
    if (statusFilter.value === "Pendiente") {
      document.querySelector("#admin-pending-count").textContent = String(registrations.length);
    }
    if (!registrations.length) {
      approvalList.innerHTML = '<div class="approval-empty">No hay solicitudes que coincidan con los filtros seleccionados.</div>';
      return;
    }
    registrations.forEach((registration) => approvalList.appendChild(createApprovalRow(registration)));
  } catch (error) {
    approvalList.innerHTML = '<div class="approval-empty">No se pudieron cargar las solicitudes.</div>';
    throw error;
  }
}

approvalList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = Number(button.dataset.id);
  if (button.dataset.action === "reject") {
    rejectionId = id;
    rejectionReason.value = "";
    rejectionDialog.showModal();
    return;
  }
  try {
    button.disabled = true;
    button.textContent = "Aprobando...";
    await window.gestionUserDb.approveRegistration(id);
    setApprovalStatus("Cuenta aprobada y asignada a su empresa correctamente.");
    await Promise.all([loadApprovals(), loadAdminMetrics()]);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Aprobar";
    setApprovalStatus(error.message, true);
  }
});

rejectionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!rejectionForm.checkValidity()) return rejectionForm.reportValidity();
  const submitBtn = rejectionForm.querySelector("button[type='submit']");
  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Rechazando...";
    }
    await window.gestionUserDb.rejectRegistration(rejectionId, rejectionReason.value);
    rejectionDialog.close();
    setApprovalStatus("Solicitud rechazada y registrada en la bitacora de auditoria.");
    await Promise.all([loadApprovals(), loadAdminMetrics()]);
  } catch (error) {
    setApprovalStatus(error.message, true);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Confirmar rechazo";
    }
  }
});

document.querySelector("#rejection-close").addEventListener("click", () => rejectionDialog.close());
document.querySelector("#rejection-cancel").addEventListener("click", () => rejectionDialog.close());
companyFilter.addEventListener("change", () => {
  Promise.all([loadApprovals(), loadAdminMetrics()]).catch((error) => setApprovalStatus(error.message, true));
});
statusFilter.addEventListener("change", () => loadApprovals().catch((error) => setApprovalStatus(error.message, true)));

Promise.all([loadAdminMetrics(), loadApprovals()]).catch((error) => setApprovalStatus(error.message, true));
