const ADMIN_ROLE = "Administrador";
const ROLE_MODULES = Object.freeze({
  Administrador: ["compras", "ventas", "inventarios", "contabilidad", "nomina", "costos", "reportes", "ayuda", "administrador"],
  Compras: ["compras", "ayuda"],
  Ventas: ["ventas", "ayuda"],
  Inventarios: ["inventarios", "ayuda"],
  Contabilidad: ["contabilidad", "nomina", "costos", "ayuda"],
  Empleado: ["ayuda"],
});

const ADMIN_PAGES = [
  "/admin.html",
  "/empleados.html",
  "/empleado.html",
  "/catalogos.html",
  "/permisos.html",
  "/configuracion.html",
  "/bitacora.html",
];

function getSessionUser() {
  return window.gestionUserDb?.getCurrentUser() || null;
}

function isAdminUser(user) {
  return Boolean(user?.isGlobalAdmin || user?.role === ADMIN_ROLE);
}

function canAccessModule(user, moduleKey, viewKey = null) {
  if (!moduleKey || moduleKey === "dashboard" || moduleKey === "ayuda") return true;
  if (isAdminUser(user)) return true;
  if (moduleKey === "administrador") return false;

  const perms = user?.permissions;
  if (perms && typeof perms === "object") {
    if (moduleKey === "reportes") {
      return Object.values(perms).some((m) => m && Array.isArray(m.actions) && m.actions[0]);
    }
    const modPerm = perms[moduleKey];
    if (!modPerm || !Array.isArray(modPerm.actions) || !modPerm.actions[0]) {
      return false;
    }
    if (viewKey && Array.isArray(modPerm.views)) {
      return modPerm.views.includes(viewKey);
    }
    return true;
  }

  return (ROLE_MODULES[user?.role] || []).includes(moduleKey);
}

function moduleFromHref(href) {
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) return "";
  try {
    const url = new URL(href, window.location.href);
    if (url.pathname.endsWith("/inventario.html") || url.pathname.endsWith("/registrar-ingreso.html")) {
      return "inventarios";
    }
    if (url.pathname.endsWith("/reportes-contables.html")) return "contabilidad:estados";
    if (url.pathname.endsWith("/contabilidad.html")) return "contabilidad";
    if (url.pathname.endsWith("/nomina.html")) return "nomina";
    if (ADMIN_PAGES.some((page) => url.pathname.endsWith(page))) return "administrador";
    const mod = url.searchParams.get("modulo") || "";
    const view = url.searchParams.get("vista") || "";
    return mod && view ? `${mod}:${view}` : mod;
  } catch (error) {
    return "";
  }
}

function requestedPageModule() {
  const { pathname, search } = window.location;
  if (pathname.endsWith("/inventario.html") || pathname.endsWith("/registrar-ingreso.html")) {
    return "inventarios:productos";
  }
  if (pathname.endsWith("/reportes-contables.html")) return "contabilidad:estados";
  if (pathname.endsWith("/contabilidad.html")) return "contabilidad";
  if (pathname.endsWith("/nomina.html")) return "nomina";
  if (ADMIN_PAGES.some((page) => pathname.endsWith(page))) return "administrador";
  if (pathname.endsWith("/modulo.html")) {
    const params = new URLSearchParams(search);
    return params.get("modulo") || "compras";
  }
  return "";
}

function canAccessTarget(user, targetSpec) {
  if (!targetSpec) return true;
  const [moduleKey, viewKey] = String(targetSpec).split(":");
  return canAccessModule(user, moduleKey, viewKey || null);
}

function hideUnauthorizedModules(user) {
  document.querySelectorAll("a[href]").forEach((link) => {
    const targetSpec = link.dataset.module || moduleFromHref(link.getAttribute("href"));
    if (targetSpec === "administrador" && !isAdminUser(user)) {
      link.hidden = true;
      return;
    }
    if (targetSpec && !canAccessTarget(user, targetSpec)) {
      link.hidden = true;
    } else if (targetSpec) {
      link.hidden = false;
    }
  });
}

function showAccessNotice() {
  if (!new URLSearchParams(window.location.search).has("acceso")) return;
  const content = document.querySelector(".content-area");
  if (!content || content.querySelector(".access-notice")) return;
  const notice = document.createElement("p");
  notice.className = "access-notice";
  notice.setAttribute("role", "alert");
  notice.textContent = "Tu perfil no tiene permiso para abrir ese modulo.";
  content.insertBefore(notice, content.firstElementChild);
}

function getInitials(user) {
  const firstInitial = user?.firstName?.trim().charAt(0) || "";
  const lastInitial = user?.lastName?.trim().charAt(0) || "";
  return `${firstInitial}${lastInitial}`.toUpperCase() || "U";
}

function formatCurrentTopbarDate(locale = "es-HN") {
  const formatted = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function updateTopbarDate(user) {
  const dateText = formatCurrentTopbarDate(user?.locale || "es-HN");
  const dateNode = document.querySelector("#current-date") || document.querySelector(".topbar-actions > span:first-child");
  if (dateNode) {
    dateNode.textContent = dateText;
  }
}

async function setupGlobalCompanySwitcher(user) {
  const topbarActions = document.querySelector(".topbar-actions");
  if (!topbarActions || !user?.isGlobalAdmin) return;
  if (document.querySelector("#global-company-switcher")) return;

  try {
    const companies = await window.gestionUserDb.listCompanies();
    if (!companies.length) return;
    if (document.querySelector("#global-company-switcher")) return;

    const wrapper = document.createElement("label");
    wrapper.className = "topbar-company-switcher";
    wrapper.setAttribute("aria-label", "Cambiar empresa activa");

    const select = document.createElement("select");
    select.id = "global-company-switcher";
    companies.forEach((company) => {
      const option = document.createElement("option");
      option.value = String(company.id);
      option.textContent = `${company.name} (${company.countryCode} · ${company.currencyCode})`;
      if (Number(company.id) === Number(user.companyId)) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    select.addEventListener("change", () => {
      const selected = companies.find((item) => Number(item.id) === Number(select.value));
      if (!selected) return;
      window.gestionUserDb.setActiveCompany(selected);
      window.location.reload();
    });

    wrapper.appendChild(select);
    topbarActions.insertBefore(wrapper, topbarActions.firstElementChild);
  } catch (error) {
    // Si falla la carga de empresas, se conserva la empresa actual de la sesion.
  }
}

function applyRegionalSettings(user) {
  if (!user) return;
  const isMexico = user.countryCode === "MX";
  const taxName = isMexico ? "IVA" : "ISV";
  const authority = isMexico ? "SAT" : "SAR";
  document.documentElement.lang = isMexico ? "es-MX" : "es-HN";
  document.body.dataset.country = user.countryCode || "HN";

  const businessName = document.querySelector("#business-name");
  if (businessName && !businessName.dataset.userEdited) {
    businessName.value = user.company || "";
  }
  const taxIdLabel = document.querySelector('label[for="business-rtn"]');
  if (taxIdLabel) {
    taxIdLabel.textContent = `${user.taxIdLabel || (isMexico ? "RFC" : "RTN")} (${isMexico ? "Registro Federal de Contribuyentes" : "Registro Tributario Nacional"})`;
  }
  const taxIdInput = document.querySelector("#business-rtn");
  if (taxIdInput && !taxIdInput.dataset.userEdited) {
    taxIdInput.value = user.taxId || "";
    taxIdInput.inputMode = isMexico ? "text" : "numeric";
    taxIdInput.maxLength = isMexico ? 13 : 14;
    taxIdInput.placeholder = isMexico ? "Ej. TOL0805129A1" : "Ej. 0801-1990-00123";
    taxIdInput.removeAttribute("pattern");
  }
  const exchangeLabel = document.querySelector('label[for="exchange-rate"]');
  if (exchangeLabel) {
    exchangeLabel.textContent = `Tasa de Cambio Oficial (USD a ${user.currencyCode || "HNL"})`;
  }
  const exchangePrefix = document.querySelector("#exchange-rate")?.previousElementSibling;
  if (exchangePrefix) {
    exchangePrefix.textContent = user.currencySymbol || "L";
  }
  const taxLabel = document.querySelector('label[for="sales-tax"]');
  if (taxLabel) {
    taxLabel.textContent = `${isMexico ? "Impuesto al Valor Agregado" : "Impuesto sobre Ventas"} (${taxName})`;
  }
  const taxInput = document.querySelector("#sales-tax");
  if (taxInput && !taxInput.dataset.userEdited) {
    taxInput.value = String(user.taxRate ?? (isMexico ? 16 : 15));
  }
  const taxHelp = taxInput?.closest(".config-field")?.querySelector("small");
  if (taxHelp) {
    taxHelp.textContent = `Tasa estandar ${user.countryName || (isMexico ? "Mexico" : "Honduras")}: ${user.taxRate ?? (isMexico ? 16 : 15)}%. Los conceptos exentos utilizan 0%.`;
  }
  const billingTitle = document.querySelector("#billing-title");
  if (billingTitle) {
    billingTitle.textContent = `Parametros de Facturacion ${authority}`;
  }
  const billingDescription = billingTitle?.nextElementSibling;
  if (billingDescription) {
    billingDescription.textContent = isMexico
      ? "Configuracion fiscal para CFDI y folios autorizados por el SAT."
      : "Autorizacion de facturacion emitida por el SAR de Honduras.";
  }
  const authorizationLabel = document.querySelector('label[for="billing-cai"]');
  if (authorizationLabel) {
    authorizationLabel.textContent = isMexico
      ? "Serie, folio y regimen fiscal CFDI"
      : "CAI - Clave de Autorizacion de Impresion";
  }

  const socialSecurityLabel = document.querySelector('label[for="imss"]');
  if (socialSecurityLabel) {
    socialSecurityLabel.textContent = isMexico ? "NSS / IMSS" : "IHSS / Seguro Social";
  }
  const identityLabel = document.querySelector('label[for="curp"]');
  if (identityLabel) {
    identityLabel.textContent = isMexico ? "CURP (18 caracteres)" : "DNI / Identidad (13 digitos)";
  }
  const employeeTaxLabel = document.querySelector('label[for="rfc"]');
  if (employeeTaxLabel) {
    employeeTaxLabel.textContent = isMexico ? "RFC" : "RTN";
  }

  const localCurrency = document.querySelector('input[name="currency"]:not([value="USD"])');
  if (localCurrency) {
    localCurrency.value = user.currencyCode || "HNL";
    const optionText = localCurrency.closest("label")?.querySelector("span");
    if (optionText) {
      optionText.innerHTML = `${isMexico ? "Pesos mexicanos" : "Lempiras"} <small>${user.currencyCode || "HNL"} (${user.currencySymbol || "L"})</small>`;
    }
  }
  const incomeExchangeLabel = document.querySelector('label[for="exchangeRate"]');
  if (incomeExchangeLabel && incomeExchangeLabel.childNodes[0]) {
    incomeExchangeLabel.childNodes[0].nodeValue = `Tasa de cambio a ${user.currencyCode || "HNL"} `;
  }
  const incomeExchangePrefix = document.querySelector("#exchangeRate")?.previousElementSibling;
  if (incomeExchangePrefix) {
    incomeExchangePrefix.textContent = user.currencySymbol || "L";
  }
  document.querySelectorAll(".results-grid").forEach((grid) => {
    const description = grid.previousElementSibling;
    if (description?.tagName === "P") {
      description.textContent = `Calculado automaticamente en ${user.currencyCode || "HNL"} (${user.currencySymbol || "L"}).`;
    }
  });
}

function applySessionUser(user) {
  if (!user) return;
  document.querySelectorAll(".user-box").forEach((box) => {
    const avatar = box.querySelector(".avatar");
    const username = box.querySelector("strong");
    const role = box.querySelector("span");

    if (avatar) avatar.textContent = getInitials(user);
    if (username) username.textContent = user.username;
    if (role) role.textContent = user.isGlobalAdmin ? `${user.role} Global` : user.role;
    if (!box.querySelector(".account-link")) {
      const accountLink = document.createElement("a");
      accountLink.className = "account-link";
      accountLink.href = "./cuenta.html";
      accountLink.title = "Mi cuenta";
      accountLink.setAttribute("aria-label", "Abrir mi cuenta");
      accountLink.innerHTML = '<img src="./assets/icons/admin.svg" alt="" />';
      box.insertBefore(accountLink, box.querySelector(".logout"));
    }
  });
  document.querySelectorAll(".brand").forEach((brand) => {
    if (!brand.dataset.staticBrand && user.company && brand.childNodes[0]) {
      brand.childNodes[0].nodeValue = `${user.company} `;
    }
  });
  document.querySelectorAll("[data-session-company]").forEach((element) => {
    element.textContent = user.company;
  });
  updateTopbarDate(user);
  applyRegionalSettings(user);
  setupGlobalCompanySwitcher(user);
}

function setupLogout() {
  document.querySelectorAll(".logout").forEach((link) => {
    if (link.dataset.logoutBound === "true") return;
    link.dataset.logoutBound = "true";
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      await window.gestionUserDb?.logoutUser();
      window.location.href = "./login.html";
    });
  });
}

const currentUser = getSessionUser();

if (!currentUser) {
  window.location.href = "./login.html";
} else if (document.body.dataset.adminOnly === "true" && !isAdminUser(currentUser)) {
  window.location.replace("./dashboard.html?acceso=denegado");
} else if (!canAccessTarget(currentUser, requestedPageModule())) {
  window.location.replace("./dashboard.html?acceso=denegado");
} else {
  applySessionUser(currentUser);
  hideUnauthorizedModules(currentUser);
  showAccessNotice();
  setupLogout();
  window.gestionUserDb.validateSession().then((validatedUser) => {
    if (!validatedUser) {
      window.location.href = "./login.html";
      return;
    }
    if (document.body.dataset.adminOnly === "true" && !isAdminUser(validatedUser)) {
      window.location.replace("./dashboard.html?acceso=denegado");
      return;
    }
    if (!canAccessTarget(validatedUser, requestedPageModule())) {
      window.location.replace("./dashboard.html?acceso=denegado");
      return;
    }
    applySessionUser(validatedUser);
    hideUnauthorizedModules(validatedUser);
  });
}
