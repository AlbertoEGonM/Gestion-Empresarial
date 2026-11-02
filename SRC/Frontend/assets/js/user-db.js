const GESTION_SESSION_KEY = "gestionSession";
const GESTION_TOKEN_KEY = "gestionAuthToken";
const GESTION_ACTIVE_COMPANY_KEY = "gestionActiveCompany";
const API_BASE_URL = `${window.location.origin}/api`;

function normalizeLoginValue(value) {
  return String(value || "").trim().toLowerCase();
}

function getAuthToken() {
  return sessionStorage.getItem(GESTION_TOKEN_KEY) || "";
}

function getStoredActiveCompany() {
  try {
    return JSON.parse(sessionStorage.getItem(GESTION_ACTIVE_COMPANY_KEY) || "null");
  } catch (error) {
    return null;
  }
}

function mergeActiveCompany(user) {
  if (!user) return null;
  if (!user.isGlobalAdmin) return user;
  const activeCompany = getStoredActiveCompany();
  if (!activeCompany || !Number.isInteger(Number(activeCompany.id))) return user;
  return {
    ...user,
    companyId: Number(activeCompany.id),
    company: activeCompany.name || user.company,
    companySlug: activeCompany.slug || user.companySlug,
    countryCode: activeCompany.countryCode || user.countryCode,
    countryName: activeCompany.countryName || user.countryName,
    currencyCode: activeCompany.currencyCode || user.currencyCode,
    currencySymbol: activeCompany.currencySymbol || user.currencySymbol,
    taxIdLabel: activeCompany.taxIdLabel || user.taxIdLabel,
    taxId: activeCompany.taxId || user.taxId,
    taxRate: Number(activeCompany.taxRate ?? user.taxRate ?? 15),
    city: activeCompany.city || user.city,
    locale: activeCompany.locale || user.locale,
  };
}

function setActiveCompany(company) {
  if (!company || !company.id) return null;
  sessionStorage.setItem(GESTION_ACTIVE_COMPANY_KEY, JSON.stringify(company));
  const rawUser = getCurrentUser();
  if (rawUser) {
    const updated = mergeActiveCompany(rawUser);
    sessionStorage.setItem(GESTION_SESSION_KEY, JSON.stringify(updated));
    return updated;
  }
  return null;
}

async function requestJson(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = getAuthToken();
  if (token && options.auth !== false) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method || "GET",
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new Error("No se pudo conectar con el servidor. Verifica que el backend este activo.");
  }
  const responseType = response.headers.get("content-type") || "";
  const data = responseType.includes("application/json") ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    if (response.status === 401) clearSession();
    if (!responseType.includes("application/json")) {
      throw new Error("El backend no respondio correctamente. Abre la aplicacion desde http://localhost:3000 y verifica que npm start este activo.");
    }
    throw new Error(data.message || `No se pudo completar la solicitud (HTTP ${response.status}).`);
  }
  return data;
}

function storeSession(user, token) {
  const merged = mergeActiveCompany(user);
  sessionStorage.setItem(GESTION_SESSION_KEY, JSON.stringify(merged));
  if (token) sessionStorage.setItem(GESTION_TOKEN_KEY, token);
  sessionStorage.setItem("gestionUser", merged.username);
}

function clearSession() {
  sessionStorage.removeItem(GESTION_SESSION_KEY);
  sessionStorage.removeItem(GESTION_TOKEN_KEY);
  sessionStorage.removeItem(GESTION_ACTIVE_COMPANY_KEY);
  sessionStorage.removeItem("gestionUser");
}

async function listCompanies() {
  try {
    const cached = JSON.parse(sessionStorage.getItem("gestionCompaniesCache") || "null");
    if (Array.isArray(cached) && cached.length > 0) return cached;
  } catch (error) {
    // Ignore cache read error
  }
  const data = await requestJson("/companies", { auth: false });
  const companies = data.companies || [];
  if (companies.length > 0) {
    sessionStorage.setItem("gestionCompaniesCache", JSON.stringify(companies));
  }
  return companies;
}

async function createUser(userData) {
  const data = await requestJson("/auth/register", { method: "POST", body: userData, auth: false });
  return data.registration;
}

async function loginUser(username, password, botMeta = {}) {
  try {
    const data = await requestJson("/auth/login", {
      method: "POST",
      body: {
        username: normalizeLoginValue(username),
        password,
        ...(botMeta || {}),
      },
      auth: false,
    });
    sessionStorage.removeItem(GESTION_ACTIVE_COMPANY_KEY);
    storeSession(data.user, data.token);
    return getCurrentUser();
  } catch (error) {
    if (/Usuario o contrasena/.test(error.message)) return null;
    throw error;
  }
}

function getCurrentUser() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(GESTION_SESSION_KEY) || "null");
    return mergeActiveCompany(parsed);
  } catch (error) {
    return null;
  }
}

async function validateSession() {
  try {
    const data = await requestJson("/auth/session");
    const merged = mergeActiveCompany(data.user);
    sessionStorage.setItem(GESTION_SESSION_KEY, JSON.stringify(merged));
    return merged;
  } catch (error) {
    clearSession();
    return null;
  }
}

async function logoutUser() {
  try { await requestJson("/auth/logout", { method: "POST", body: {} }); }
  catch (error) { /* La sesion local debe limpiarse siempre. */ }
  clearSession();
}

async function recoverPassword(email, botMeta = {}) {
  return requestJson("/auth/recover", {
    method: "POST",
    body: {
      email: normalizeLoginValue(email),
      ...(botMeta || {}),
    },
    auth: false,
  });
}

async function resetPassword(token, password) {
  return requestJson("/auth/reset", { method: "POST", body: { token, password }, auth: false });
}

async function deleteOwnAccount(password, confirmation) {
  const result = await requestJson("/auth/account", { method: "DELETE", body: { password, confirmation } });
  clearSession();
  return result;
}

async function getRegistrations(filters = {}) {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.companyId) query.set("companyId", filters.companyId);
  if (filters.limit) query.set("limit", filters.limit);
  if (filters.offset) query.set("offset", filters.offset);
  const data = await requestJson(`/admin/registrations?${query}`);
  return data.registrations || [];
}

async function approveRegistration(id) {
  const data = await requestJson("/admin/registrations/approve", { method: "POST", body: { id } });
  return data.user;
}

async function rejectRegistration(id, reason = "") {
  return requestJson("/admin/registrations/reject", { method: "POST", body: { id, reason } });
}

async function getAuditLogs(filters = {}) {
  const query = new URLSearchParams();
  const targetCompanyId = filters.companyId || getCurrentUser()?.companyId;
  if (targetCompanyId) query.set("companyId", targetCompanyId);
  if (filters.limit) query.set("limit", filters.limit);
  if (filters.offset) query.set("offset", filters.offset);
  const data = await requestJson(`/admin/audit-logs?${query}`);
  return data.logs || [];
}

async function listEmployees(filters = {}) {
  const query = new URLSearchParams();
  const targetCompanyId = filters.companyId || getCurrentUser()?.companyId;
  if (targetCompanyId) query.set("companyId", targetCompanyId);
  if (filters.status) query.set("status", filters.status);
  if (filters.limit) query.set("limit", filters.limit);
  if (filters.offset) query.set("offset", filters.offset);
  const data = await requestJson(`/employees?${query}`);
  return data.employees || [];
}

async function getEmployee(id) {
  const data = await requestJson(`/employees/${encodeURIComponent(id)}`);
  return data.employee;
}

async function createEmployee(employee) {
  const payload = { ...employee };
  if (!payload.companyId && getCurrentUser()?.companyId) {
    payload.companyId = getCurrentUser().companyId;
  }
  const data = await requestJson("/employees", { method: "POST", body: payload });
  return data.employee;
}

async function updateEmployee(id, employee) {
  const data = await requestJson(`/employees/${encodeURIComponent(id)}`, { method: "PUT", body: employee });
  return data.employee;
}

async function deleteEmployee(id, confirmation) {
  return requestJson(`/employees/${encodeURIComponent(id)}`, { method: "DELETE", body: { confirmation } });
}

async function getDataset(moduleKey, viewKey, companyId) {
  const targetCompanyId = companyId || getCurrentUser()?.companyId;
  const query = new URLSearchParams({ module: moduleKey, view: viewKey });
  if (targetCompanyId) query.set("companyId", targetCompanyId);
  return requestJson(`/records?${query}`);
}

async function saveDataset(moduleKey, viewKey, rows, companyId) {
  const targetCompanyId = companyId || getCurrentUser()?.companyId;
  return requestJson("/records", { method: "PUT", body: { moduleKey, viewKey, rows, companyId: targetCompanyId } });
}

async function getAccountingReport(type, period, companyId) {
  const targetCompanyId = companyId || getCurrentUser()?.companyId;
  const query = new URLSearchParams({ type, period });
  if (targetCompanyId) query.set("companyId", targetCompanyId);
  const data = await requestJson(`/accounting/reports?${query}`);
  return data.report;
}

window.gestionUserDb = {
  approveRegistration,
  createEmployee,
  createUser,
  deleteEmployee,
  deleteOwnAccount,
  getAccountingReport,
  getAuditLogs,
  getAuthToken,
  getCurrentUser,
  getDataset,
  getEmployee,
  getRegistrations,
  listCompanies,
  listEmployees,
  loginUser,
  logoutUser,
  recoverPassword,
  rejectRegistration,
  resetPassword,
  saveDataset,
  setActiveCompany,
  updateEmployee,
  validateSession,
};
