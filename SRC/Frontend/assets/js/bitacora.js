const auditSearch = document.querySelector("#audit-search");
const auditSeverity = document.querySelector("#audit-severity");
const auditRowsContainer = document.querySelector("#audit-rows");
const exportCsvButton = document.querySelector("#audit-export-csv");

let auditLogs = [];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}

function describeAuditEvent(log) {
  const details = log.details || {};
  switch (log.action) {
    case "LOGIN_SUCCESS":
      return ["Inicio de sesion autenticado", "Autenticacion"];
    case "LOGIN_FAILED":
      return [`Intento fallido de inicio de sesion (${details.reason || "credenciales"})`, "Seguridad"];
    case "REGISTRATION_REQUESTED":
      return [`Solicitud de acceso enviada (${details.requestedRole || "Operacion"})`, "Registro"];
    case "REGISTRATION_APPROVED":
      return [`Cuenta aprobada con rol ${details.assignedRole || "Operativo"}`, "Administrador"];
    case "REGISTRATION_REJECTED":
      return ["Solicitud de cuenta rechazada", "Administrador"];
    case "EMPLOYEE_CREATED":
      return [`Alta de expediente laboral (${details.email || "empleado"})`, "Recursos Humanos"];
    case "EMPLOYEE_UPDATED":
      return [`Actualizacion de expediente laboral (#${details.employeeId || ""})`, "Recursos Humanos"];
    case "EMPLOYEE_DELETED":
      return [`Baja logica de empleado (#${details.employeeId || ""})`, "Recursos Humanos"];
    case "DATASET_UPDATED":
      return [
        `Actualizacion de registros en ${details.moduleKey || "modulo"} / ${details.viewKey || "vista"} (${details.totalRows ?? 0} filas)`,
        (details.moduleKey || "Operacion").toUpperCase(),
      ];
    case "PASSWORD_RECOVERY_REQUESTED":
      return ["Solicitud de recuperacion de contrasena", "Seguridad"];
    case "PASSWORD_RESET_COMPLETED":
      return ["Restablecimiento de contrasena completado", "Seguridad"];
    default:
      return [log.action, "Sistema"];
  }
}

function severityBadge(severity) {
  const norm = String(severity || "INFO").toUpperCase();
  if (norm === "INFO") return '<b class="status complete">INFO</b>';
  if (norm === "WARN") return '<b class="status pending">WARN</b>';
  return `<b class="status pending">${escapeHtml(norm)}</b>`;
}

function formatDate(value) {
  if (!value) return "-";
  const user = window.gestionUserDb.getCurrentUser();
  try {
    return new Intl.DateTimeFormat(user?.locale || "es-HN", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value));
  } catch (error) {
    return String(value);
  }
}

function filteredLogs() {
  const term = auditSearch.value.trim().toLowerCase();
  const sev = auditSeverity.value;
  return auditLogs.filter((log) => {
    const [description, moduleName] = describeAuditEvent(log);
    const matchesSeverity = !sev || String(log.severity).toUpperCase() === sev;
    const text = `${description} ${moduleName} ${log.username} ${log.ipAddress} ${log.action}`.toLowerCase();
    return matchesSeverity && text.includes(term);
  });
}

function renderAuditLogs() {
  const rows = filteredLogs();
  if (!rows.length) {
    auditRowsContainer.innerHTML = '<div class="employee-empty">No hay eventos registrados que coincidan con el filtro.</div>';
    return;
  }
  auditRowsContainer.innerHTML = rows
    .map((log) => {
      const [description, moduleName] = describeAuditEvent(log);
      return `<div class="audit-row">
        <strong>${escapeHtml(description)}</strong>
        <span>${escapeHtml(moduleName)}</span>
        <span>${escapeHtml(log.username || "sistema")}</span>
        <span>${escapeHtml(formatDate(log.createdAt))}</span>
        ${severityBadge(log.severity)}
      </div>`;
    })
    .join("");
}

function exportAuditCsv() {
  const rows = filteredLogs();
  if (!rows.length) return;
  const csvCell = (val) => `"${String(val ?? "").replaceAll('"', '""')}"`;
  const headers = ["ID", "Evento", "Modulo", "Usuario", "Empresa", "Fecha", "Nivel", "IP"];
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((log) => {
      const [description, moduleName] = describeAuditEvent(log);
      return [
        log.id,
        description,
        moduleName,
        log.username,
        log.companyName,
        formatDate(log.createdAt),
        log.severity,
        log.ipAddress,
      ]
        .map(csvCell)
        .join(",");
    }),
  ];
  const blob = new Blob([`\ufeff${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `bitacora-auditoria-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

auditSearch.addEventListener("input", renderAuditLogs);
auditSeverity.addEventListener("change", renderAuditLogs);
exportCsvButton.addEventListener("click", exportAuditCsv);

(async function loadAuditLogs() {
  try {
    auditLogs = await window.gestionUserDb.getAuditLogs({ limit: 100 });
    renderAuditLogs();
  } catch (error) {
    auditRowsContainer.innerHTML = `<div class="employee-empty">${escapeHtml(error.message)}</div>`;
  }
})();
