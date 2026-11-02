const employeeSearch = document.querySelector("#employee-search");
const employeeTable = document.querySelector("#employee-table");
const employeeMessage = document.querySelector("#employee-message");
const employeeStatus = document.querySelector("#employee-status");
const companyFilter = document.querySelector("#employee-company-filter");
const companySelect = document.querySelector("#employee-company");
const deleteDialog = document.querySelector("#delete-employee-dialog");
const deleteForm = document.querySelector("#delete-employee-form");
const deleteDescription = document.querySelector("#delete-employee-description");
const deleteConfirmation = document.querySelector("#delete-employee-confirmation");
const deleteError = document.querySelector("#delete-employee-error");
const currentEmployeeUser = window.gestionUserDb.getCurrentUser();

let employees = [];
let selectedEmployee = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function initials(employee) {
  return `${employee.firstName?.charAt(0) || ""}${employee.lastName?.charAt(0) || ""}`.toUpperCase();
}

function showMessage(message, error = false) {
  employeeMessage.textContent = message;
  employeeMessage.classList.toggle("error", error);
  employeeMessage.hidden = false;
  window.setTimeout(() => { employeeMessage.hidden = true; }, 3200);
}

function updateSummary(rows) {
  document.querySelector("#employee-total").textContent = rows.length;
  document.querySelector("#employee-inventory").textContent = rows.filter((row) => row.systemRole === "Inventarios").length;
  document.querySelector("#employee-sales").textContent = rows.filter((row) => row.systemRole === "Ventas").length;
  document.querySelector("#employee-accounting").textContent = rows.filter((row) => row.systemRole === "Contabilidad").length;
}

function renderEmployees() {
  employeeTable.querySelectorAll(".employee-row:not(.head), .employee-empty").forEach((row) => row.remove());
  const term = employeeSearch.value.trim().toLowerCase();
  const filtered = employees.filter((employee) =>
    [employee.firstName, employee.lastName, employee.secondLastName, employee.email, employee.position, employee.branch, employee.company, employee.systemRole]
      .join(" ")
      .toLowerCase()
      .includes(term)
  );
  updateSummary(filtered);
  if (!filtered.length) {
    employeeTable.insertAdjacentHTML("beforeend", '<div class="employee-empty">No hay empleados que coincidan con los filtros.</div>');
    return;
  }
  employeeTable.insertAdjacentHTML(
    "beforeend",
    filtered
      .map(
        (employee) => `
    <div class="employee-row" data-employee-id="${employee.id}">
      <div class="employee-name"><b>${initials(employee)}</b><strong>${escapeHtml(
        [employee.firstName, employee.lastName, employee.secondLastName].filter(Boolean).join(" ")
      )}</strong><span>${escapeHtml(employee.email)}</span></div>
      <span>${escapeHtml(employee.position)}<br><small style="color:#6b7280">Salario: ${Number(employee.baseSalary || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} · Correo: ${employee.payrollEmailEnabled === false ? "NO" : "SI"}</small></span><span>${escapeHtml(
        employee.company ? `${employee.branch} · ${employee.company}` : employee.branch
      )}</span><b class="status ${employee.status === "Activo" ? "complete" : "pending"}">${escapeHtml(employee.systemRole)}</b>
      <span class="row-actions"><a href="./empleado.html?id=${employee.id}" title="Editar empleado" aria-label="Editar empleado"><img src="./assets/icons/inventory-edit.svg" alt="" /></a><button type="button" data-action="delete" title="Eliminar empleado" aria-label="Eliminar empleado"><img src="./assets/icons/inventory-delete.svg" alt="" /></button></span>
    </div>`
      )
      .join("")
  );
}

async function loadEmployees() {
  employeeTable.querySelectorAll(".employee-row:not(.head), .employee-empty").forEach((row) => row.remove());
  employeeTable.insertAdjacentHTML("beforeend", '<div class="employee-empty">Cargando empleados...</div>');
  try {
    const selectedCompanyId = companySelect.value || (currentEmployeeUser?.isGlobalAdmin ? "all" : currentEmployeeUser?.companyId);
    employees = await window.gestionUserDb.listEmployees({ companyId: selectedCompanyId, status: employeeStatus.value });
    renderEmployees();
  } catch (error) {
    employees = [];
    renderEmployees();
    showMessage(error.message, true);
  }
}

async function setupCompanies() {
  if (!currentEmployeeUser?.isGlobalAdmin) return;
  try {
    const companies = await window.gestionUserDb.listCompanies();
    companySelect.innerHTML =
      '<option value="all" selected>Todas las empresas</option>' +
      companies.map((company) => `<option value="${company.id}">${escapeHtml(company.name)}</option>`).join("");
    companyFilter.hidden = false;
  } catch (error) {
    showMessage(error.message, true);
  }
}

employeeSearch.addEventListener("input", renderEmployees);
employeeStatus.addEventListener("change", loadEmployees);
companySelect.addEventListener("change", loadEmployees);

employeeTable.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='delete']");
  if (!button) return;
  selectedEmployee = employees.find((employee) => employee.id === Number(button.closest(".employee-row").dataset.employeeId));
  if (!selectedEmployee) return;
  deleteDescription.textContent = `${selectedEmployee.firstName} ${selectedEmployee.lastName} dejara de aparecer como personal activo. La operacion quedara registrada en su expediente.`;
  deleteConfirmation.value = "";
  deleteError.hidden = true;
  deleteDialog.showModal();
  deleteConfirmation.focus();
});

document.querySelector("#cancel-delete-employee").addEventListener("click", () => deleteDialog.close());
document.querySelector("#export-employees-excel")?.addEventListener("click", () => {
  const columns = ["Empleado", "Correo", "Puesto", "Sucursal", "Area", "Salario Base", "Periodicidad", "Cuenta", "Nomina al Correo"];
  const rows = employees.map((e) => [[e.firstName, e.lastName, e.secondLastName].filter(Boolean).join(" "), e.email, e.position, e.branch, e.systemRole, Number(e.baseSalary || 0).toFixed(2), e.paymentFrequency || "Quincenal", e.bankAccount || "-", e.payrollEmailEnabled === false ? "NO" : "SI"]);
  window.gestionExport?.toExcel({ filename: "expedientes-empleados", sheetName: "Empleados", title: "Expedientes de Empleados", columns, rows });
});
document.querySelector("#export-employees-pdf")?.addEventListener("click", () => {
  const columns = ["Empleado", "Correo", "Puesto", "Sucursal", "Salario Base", "Periodicidad", "Cuenta", "Correo SI/NO"];
  const rows = employees.map((e) => [[e.firstName, e.lastName, e.secondLastName].filter(Boolean).join(" "), e.email, e.position, e.branch, Number(e.baseSalary || 0).toFixed(2), e.paymentFrequency || "Quincenal", e.bankAccount || "-", e.payrollEmailEnabled === false ? "NO" : "SI"]);
  window.gestionExport?.toPdf({ filename: "expedientes-empleados", title: "Expedientes de Empleados", columns, rows });
});
deleteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  deleteError.hidden = true;
  if (deleteConfirmation.value.trim().toUpperCase() !== "ELIMINAR") {
    deleteError.textContent = "Escribe ELIMINAR exactamente para continuar.";
    deleteError.hidden = false;
    deleteConfirmation.focus();
    return;
  }
  const submitButton = deleteForm.querySelector("button[type='submit']");
  try {
    submitButton.disabled = true;
    submitButton.textContent = "Eliminando...";
    await window.gestionUserDb.deleteEmployee(selectedEmployee.id, deleteConfirmation.value);
    deleteDialog.close();
    showMessage("Empleado eliminado correctamente.");
    await loadEmployees();
  } catch (error) {
    deleteError.textContent = error.message;
    deleteError.hidden = false;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Eliminar empleado";
  }
});

(async function initializeEmployees() {
  await setupCompanies();
  await loadEmployees();
  const flash = sessionStorage.getItem("employeeFlash");
  if (flash) {
    sessionStorage.removeItem("employeeFlash");
    showMessage(flash);
  }
})();
