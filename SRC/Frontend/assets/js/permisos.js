const employeeListContainer = document.querySelector("#permission-employee-list");
const employeeTitle = document.querySelector("#permission-employee-title");
const employeeSubtitle = document.querySelector("#permission-employee-subtitle");
const roleSelect = document.querySelector("#permission-role-select");
const saveButton = document.querySelector("#permission-save-btn");
const matrixRowsContainer = document.querySelector("#permission-matrix-rows");
const toast = document.querySelector("#permission-toast");

const MODULE_DEFINITIONS = [
  {
    key: "inventarios",
    label: "Inventarios de Rollos, Lotes y Kardex",
    views: [
      { key: "productos", label: "Productos y Rollos" },
      { key: "kardex", label: "Kardex" },
      { key: "almacenes", label: "Almacenes" },
      { key: "lotes", label: "Lotes y Series" },
      { key: "impuestos", label: "Esquemas de Impuestos" },
    ],
  },
  {
    key: "compras",
    label: "Compras, Importaciones y Proveedores Textiles",
    views: [
      { key: "proveedores", label: "Proveedores" },
      { key: "requisiciones", label: "Requisiciones" },
      { key: "ordenes", label: "Ordenes de Compra" },
      { key: "recepciones", label: "Recepciones" },
      { key: "pagos", label: "Cuentas por Pagar" },
    ],
  },
  {
    key: "ventas",
    label: "Facturacion, Proformas, Pedidos y POS",
    views: [
      { key: "clientes", label: "Clientes" },
      { key: "cotizaciones", label: "Proformas" },
      { key: "pedidos", label: "Pedidos" },
      { key: "facturas", label: "Facturas" },
      { key: "cobranza", label: "Cobranza" },
      { key: "pos", label: "Punto de Venta (POS)" },
    ],
  },
  {
    key: "contabilidad",
    label: "Contabilidad, Bancos y Estados Financieros",
    views: [
      { key: "cuentas", label: "Catalogo de Cuentas" },
      { key: "polizas", label: "Polizas" },
      { key: "auxiliares", label: "Auxiliares" },
      { key: "balanza", label: "Balanza de Comprobacion" },
      { key: "estados", label: "Estados Financieros" },
      { key: "tipocambio", label: "Tipo de Cambio" },
      { key: "bancos", label: "Bancos y Conciliacion" },
    ],
  },
  {
    key: "nomina",
    label: "Nomina, Recibos, Acumulados y Cierres",
    views: [
      { key: "empleados", label: "Datos del Trabajador" },
      { key: "conceptos", label: "Percepciones y Deducciones" },
      { key: "nominas", label: "Nominas" },
      { key: "reportes", label: "Reporte de Nomina" },
      { key: "acumulados", label: "Reporte de Acumulados" },
      { key: "cierre", label: "Cierre de Periodo" },
    ],
  },
  {
    key: "costos",
    label: "Analisis de Costos y Margenes por Tela",
    views: [
      { key: "hojas", label: "Hojas de Costo" },
      { key: "margenes", label: "Margenes Comerciales" },
    ],
  },
];

const ACTION_LABELS = ["Consultar", "Registrar", "Editar", "Eliminar"];

function buildPresetForRole(roleName) {
  const presets = {
    Administrador: {
      inventarios: [true, true, true, true],
      compras: [true, true, true, true],
      ventas: [true, true, true, true],
      contabilidad: [true, true, true, true],
      nomina: [true, true, true, true],
      costos: [true, true, true, true],
    },
    Inventarios: {
      inventarios: [true, true, true, false],
      compras: [false, false, false, false],
      ventas: [false, false, false, false],
      contabilidad: [false, false, false, false],
      nomina: [false, false, false, false],
      costos: [false, false, false, false],
    },
    Compras: {
      inventarios: [false, false, false, false],
      compras: [true, true, true, false],
      ventas: [false, false, false, false],
      contabilidad: [false, false, false, false],
      nomina: [false, false, false, false],
      costos: [false, false, false, false],
    },
    Ventas: {
      inventarios: [false, false, false, false],
      compras: [false, false, false, false],
      ventas: [true, true, true, false],
      contabilidad: [false, false, false, false],
      nomina: [false, false, false, false],
      costos: [false, false, false, false],
    },
    Contabilidad: {
      inventarios: [false, false, false, false],
      compras: [false, false, false, false],
      ventas: [false, false, false, false],
      contabilidad: [true, true, true, false],
      nomina: [true, true, true, false],
      costos: [true, true, true, false],
    },
    Empleado: {
      inventarios: [false, false, false, false],
      compras: [false, false, false, false],
      ventas: [false, false, false, false],
      contabilidad: [false, false, false, false],
      nomina: [false, false, false, false],
      costos: [false, false, false, false],
    },
  };
  const roleFlags = presets[roleName] || presets.Empleado;
  const result = {};
  for (const mod of MODULE_DEFINITIONS) {
    const actions = [...(roleFlags[mod.key] || [false, false, false, false])];
    result[mod.key] = {
      actions,
      views: actions[0] ? mod.views.map((v) => v.key) : [],
    };
  }
  return result;
}

function clonePermissions(rawPermissions, fallbackRole = "Empleado") {
  const preset = buildPresetForRole(fallbackRole);
  if (!rawPermissions || typeof rawPermissions !== "object") return preset;
  const copy = {};
  for (const mod of MODULE_DEFINITIONS) {
    const entry = rawPermissions[mod.key];
    if (entry && Array.isArray(entry.actions)) {
      const actions = [
        Boolean(entry.actions[0]),
        Boolean(entry.actions[1]),
        Boolean(entry.actions[2]),
        Boolean(entry.actions[3]),
      ];
      if (actions[1] || actions[2] || actions[3]) actions[0] = true;
      const validViewKeys = mod.views.map((v) => v.key);
      let views = Array.isArray(entry.views)
        ? entry.views.filter((v) => validViewKeys.includes(v))
        : actions[0]
          ? [...validViewKeys]
          : [];
      if (!actions[0]) views = [];
      else if (views.length === 0) views = [...validViewKeys];
      copy[mod.key] = { actions, views };
    } else {
      copy[mod.key] = preset[mod.key];
    }
  }
  return copy;
}

let employees = [];
let selectedEmployee = null;
let currentPermissions = buildPresetForRole("Empleado");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}

function showToast(message, isError = false) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("error", Boolean(isError));
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3400);
}

function renderMatrix() {
  const isDisabled = !selectedEmployee;
  matrixRowsContainer.innerHTML = MODULE_DEFINITIONS.map((mod) => {
    const modPerm = currentPermissions[mod.key] || { actions: [false, false, false, false], views: [] };
    const flags = modPerm.actions;
    const activeViews = new Set(modPerm.views || []);

    const viewChips = mod.views
      .map((view) => {
        const checked = flags[0] && activeViews.has(view.key);
        return `<label class="perm-view-chip ${checked ? "active" : ""}">
          <input type="checkbox" data-mod="${escapeHtml(mod.key)}" data-view="${escapeHtml(view.key)}" ${checked ? "checked" : ""} ${isDisabled ? "disabled" : ""} />
          <span>${escapeHtml(view.label)}</span>
        </label>`;
      })
      .join("");

    const actionCells = flags
      .map(
        (enabled, idx) =>
          `<button type="button" class="toggle ${enabled ? "on" : "off"}" data-mod="${escapeHtml(mod.key)}" data-action-idx="${idx}" aria-pressed="${enabled}" aria-label="${escapeHtml(ACTION_LABELS[idx])} en ${escapeHtml(mod.label)}" title="${escapeHtml(ACTION_LABELS[idx])}: ${enabled ? "Permitido" : "Restringido"}" ${isDisabled ? "disabled" : ""}></button>`
      )
      .join("");

    return `<div class="matrix-row">
      <div class="perm-module-cell">
        <strong>${escapeHtml(mod.label)}</strong>
        <div class="perm-views-list">${viewChips}</div>
      </div>
      ${actionCells}
    </div>`;
  }).join("");
}

function renderEmployeeList() {
  if (!employees.length) {
    employeeListContainer.innerHTML = '<p class="employee-empty">No hay empleados activos registrados.</p>';
    employeeTitle.textContent = "Sin personal seleccionado";
    employeeSubtitle.textContent = "Registra o aprueba empleados para personalizar sus privilegios por modulo.";
    roleSelect.disabled = true;
    saveButton.disabled = true;
    currentPermissions = buildPresetForRole("Empleado");
    renderMatrix();
    return;
  }

  employeeListContainer.innerHTML = employees
    .map((emp) => {
      const fullName = [emp.firstName, emp.lastName, emp.secondLastName].filter(Boolean).join(" ");
      const isActive = selectedEmployee && selectedEmployee.id === emp.id;
      const meta = [emp.company, emp.systemRole].filter(Boolean).join(" · ");
      return `<button class="${isActive ? "active" : ""}" type="button" data-employee-id="${emp.id}">
        <strong>${escapeHtml(fullName)}</strong>
        <span>${escapeHtml(meta)}</span>
      </button>`;
    })
    .join("");
}

function selectEmployee(emp) {
  selectedEmployee = emp;
  const fullName = [emp.firstName, emp.lastName, emp.secondLastName].filter(Boolean).join(" ");
  employeeTitle.textContent = `Privilegios de ${fullName}`;
  employeeSubtitle.textContent = `${emp.position} (${emp.branch}${emp.company ? ` — ${emp.company}` : ""}) — ${emp.email}`;
  roleSelect.value = emp.systemRole || "Empleado";
  roleSelect.disabled = false;
  saveButton.disabled = false;
  currentPermissions = clonePermissions(emp.permissions, emp.systemRole || "Empleado");
  renderEmployeeList();
  renderMatrix();
}

employeeListContainer.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-employee-id]");
  if (!button) return;
  const emp = employees.find((item) => item.id === Number(button.dataset.employeeId));
  if (emp) selectEmployee(emp);
});

roleSelect.addEventListener("change", () => {
  currentPermissions = buildPresetForRole(roleSelect.value);
  renderMatrix();
});

matrixRowsContainer.addEventListener("click", (event) => {
  const toggleBtn = event.target.closest("button.toggle[data-mod]");
  if (!toggleBtn || !selectedEmployee) return;
  const modKey = toggleBtn.dataset.mod;
  const actionIdx = Number(toggleBtn.dataset.actionIdx);
  const modDef = MODULE_DEFINITIONS.find((m) => m.key === modKey);
  if (!modDef || !currentPermissions[modKey]) return;

  const entry = currentPermissions[modKey];
  const nextVal = !entry.actions[actionIdx];
  entry.actions[actionIdx] = nextVal;

  if (actionIdx === 0) {
    if (!nextVal) {
      entry.actions = [false, false, false, false];
      entry.views = [];
    } else if (!entry.views.length) {
      entry.views = modDef.views.map((v) => v.key);
    }
  } else if (nextVal) {
    entry.actions[0] = true;
    if (!entry.views.length) {
      entry.views = modDef.views.map((v) => v.key);
    }
  }

  renderMatrix();
});

matrixRowsContainer.addEventListener("change", (event) => {
  const checkbox = event.target.closest('input[type="checkbox"][data-mod][data-view]');
  if (!checkbox || !selectedEmployee) return;
  const modKey = checkbox.dataset.mod;
  const viewKey = checkbox.dataset.view;
  const modDef = MODULE_DEFINITIONS.find((m) => m.key === modKey);
  if (!modDef || !currentPermissions[modKey]) return;

  const entry = currentPermissions[modKey];
  const viewSet = new Set(entry.views || []);
  if (checkbox.checked) {
    viewSet.add(viewKey);
    entry.actions[0] = true;
  } else {
    viewSet.delete(viewKey);
  }
  entry.views = modDef.views.map((v) => v.key).filter((k) => viewSet.has(k));

  if (entry.views.length === 0) {
    entry.actions = [false, false, false, false];
  }

  renderMatrix();
});

saveButton.addEventListener("click", async () => {
  if (!selectedEmployee) return;
  saveButton.disabled = true;
  saveButton.textContent = "Guardando...";
  try {
    const detailed = await window.gestionUserDb.getEmployee(selectedEmployee.id);
    const updated = await window.gestionUserDb.updateEmployee(selectedEmployee.id, {
      firstName: detailed.firstName,
      lastName: detailed.lastName,
      secondLastName: detailed.secondLastName || "",
      email: detailed.email,
      birthDate: detailed.birthDate ? String(detailed.birthDate).slice(0, 10) : "",
      birthPlace: detailed.birthPlace || "",
      gender: detailed.gender || "No especificado",
      identityNumber: detailed.identityNumber || "",
      taxNumber: detailed.taxNumber || "",
      socialSecurityNumber: detailed.socialSecurityNumber || "",
      position: detailed.position,
      branch: detailed.branch,
      systemRole: roleSelect.value,
      permissions: currentPermissions,
    });
    const idx = employees.findIndex((item) => item.id === updated.id);
    if (idx >= 0) employees[idx] = updated;
    selectEmployee(updated);
    showToast(`Permisos personalizados de ${updated.firstName} ${updated.lastName} guardados correctamente.`);
  } catch (error) {
    showToast(error.message || "No se pudieron guardar los permisos del empleado.", true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Guardar permisos";
  }
});

(async function initPermissions() {
  renderMatrix();
  try {
    const user = window.gestionUserDb.getCurrentUser();
    employees = await window.gestionUserDb.listEmployees({
      status: "Activo",
      companyId: user?.isGlobalAdmin ? "all" : user?.companyId,
    });
    if (employees.length) {
      selectEmployee(employees[0]);
    } else {
      renderEmployeeList();
    }
  } catch (error) {
    employeeListContainer.innerHTML = `<p class="employee-empty">${escapeHtml(error.message)}</p>`;
  }
})();
