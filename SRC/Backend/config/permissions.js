const ROLE_MODULES = Object.freeze({
  Administrador: ["compras", "ventas", "inventarios", "contabilidad", "costos", "reportes", "pos", "ayuda", "administrador"],
  Compras: ["compras", "inventarios", "ayuda"],
  Ventas: ["ventas", "pos", "ayuda"],
  Inventarios: ["inventarios", "compras", "ayuda"],
  Contabilidad: ["contabilidad", "costos", "reportes", "ayuda"],
  Finanzas: ["contabilidad", "costos", "reportes", "pos", "ayuda"],
  Empleado: ["ayuda"],
});

const MODULE_VIEWS_MAP = Object.freeze({
  inventarios: ["productos", "kardex", "almacenes", "lotes"],
  compras: ["proveedores", "requisiciones", "ordenes", "recepciones", "pagos"],
  ventas: ["clientes", "cotizaciones", "pedidos", "facturas", "cobranza", "pos"],
  contabilidad: ["movimientos", "bancos", "estados"],
  costos: ["hojas", "margenes"],
});

const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  Administrador: {
    inventarios: { actions: [true, true, true, true], views: [...MODULE_VIEWS_MAP.inventarios] },
    compras: { actions: [true, true, true, true], views: [...MODULE_VIEWS_MAP.compras] },
    ventas: { actions: [true, true, true, true], views: [...MODULE_VIEWS_MAP.ventas] },
    contabilidad: { actions: [true, true, true, true], views: [...MODULE_VIEWS_MAP.contabilidad] },
    costos: { actions: [true, true, true, true], views: [...MODULE_VIEWS_MAP.costos] },
  },
  Inventarios: {
    inventarios: { actions: [true, true, true, false], views: [...MODULE_VIEWS_MAP.inventarios] },
    compras: { actions: [false, false, false, false], views: [] },
    ventas: { actions: [false, false, false, false], views: [] },
    contabilidad: { actions: [false, false, false, false], views: [] },
    costos: { actions: [false, false, false, false], views: [] },
  },
  Compras: {
    inventarios: { actions: [false, false, false, false], views: [] },
    compras: { actions: [true, true, true, false], views: [...MODULE_VIEWS_MAP.compras] },
    ventas: { actions: [false, false, false, false], views: [] },
    contabilidad: { actions: [false, false, false, false], views: [] },
    costos: { actions: [false, false, false, false], views: [] },
  },
  Ventas: {
    inventarios: { actions: [false, false, false, false], views: [] },
    compras: { actions: [false, false, false, false], views: [] },
    ventas: { actions: [true, true, true, false], views: [...MODULE_VIEWS_MAP.ventas] },
    contabilidad: { actions: [false, false, false, false], views: [] },
    costos: { actions: [false, false, false, false], views: [] },
  },
  Contabilidad: {
    inventarios: { actions: [false, false, false, false], views: [] },
    compras: { actions: [false, false, false, false], views: [] },
    ventas: { actions: [false, false, false, false], views: [] },
    contabilidad: { actions: [true, true, true, false], views: [...MODULE_VIEWS_MAP.contabilidad] },
    costos: { actions: [true, true, true, false], views: [...MODULE_VIEWS_MAP.costos] },
  },
  Finanzas: {
    inventarios: { actions: [false, false, false, false], views: [] },
    compras: { actions: [false, false, false, false], views: [] },
    ventas: { actions: [false, false, false, false], views: [] },
    contabilidad: { actions: [true, true, true, false], views: [...MODULE_VIEWS_MAP.contabilidad] },
    costos: { actions: [true, true, true, false], views: [...MODULE_VIEWS_MAP.costos] },
  },
  Empleado: {
    inventarios: { actions: [false, false, false, false], views: [] },
    compras: { actions: [false, false, false, false], views: [] },
    ventas: { actions: [false, false, false, false], views: [] },
    contabilidad: { actions: [false, false, false, false], views: [] },
    costos: { actions: [false, false, false, false], views: [] },
  },
});

function normalizePermissions(rawInput, fallbackRole = "Empleado") {
  let parsed = rawInput;
  if (typeof rawInput === "string" && rawInput.trim()) {
    try {
      parsed = JSON.parse(rawInput);
    } catch {
      parsed = null;
    }
  }

  const baseRole = DEFAULT_ROLE_PERMISSIONS[fallbackRole] || DEFAULT_ROLE_PERMISSIONS.Empleado;
  const result = {};

  for (const [modKey, allViews] of Object.entries(MODULE_VIEWS_MAP)) {
    const entry = parsed && typeof parsed === "object" ? parsed[modKey] : null;
    const defaultEntry = baseRole[modKey] || { actions: [false, false, false, false], views: [] };

    let rawActions = defaultEntry.actions;
    let rawViews = null;

    if (Array.isArray(entry)) {
      rawActions = entry;
    } else if (entry && typeof entry === "object") {
      if (Array.isArray(entry.actions)) rawActions = entry.actions;
      if (Array.isArray(entry.views)) rawViews = entry.views;
    }

    const actions = [
      Boolean(rawActions[0]),
      Boolean(rawActions[1]),
      Boolean(rawActions[2]),
      Boolean(rawActions[3]),
    ];
    if (actions[1] || actions[2] || actions[3]) {
      actions[0] = true;
    }

    let views = [];
    if (actions[0]) {
      if (Array.isArray(rawViews)) {
        views = rawViews.map((v) => String(v).trim().toLowerCase()).filter((v) => allViews.includes(v));
      } else {
        views = [...allViews];
      }
      if (!views.length) {
        actions[0] = false;
        actions[1] = false;
        actions[2] = false;
        actions[3] = false;
      }
    }

    result[modKey] = { actions, views };
  }

  return result;
}

function httpForbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function canAccessModule(userOrRole, moduleKey, viewKey = null) {
  const mod = String(moduleKey || "").trim().toLowerCase();
  const view = viewKey ? String(viewKey).trim().toLowerCase() : null;

  if (typeof userOrRole === "string") {
    const allowedModules = ROLE_MODULES[userOrRole] || [];
    return allowedModules.includes(mod);
  }

  if (!userOrRole || typeof userOrRole !== "object") return false;
  if (userOrRole.role === "Administrador" || userOrRole.isGlobalAdmin) return true;
  if (mod === "ayuda" || mod === "dashboard") return true;
  if (mod === "administrador") return false;

  if (userOrRole.permissions && typeof userOrRole.permissions === "object") {
    const perms = normalizePermissions(userOrRole.permissions, userOrRole.role);
    if (mod === "pos") {
      return Boolean(perms.ventas?.actions?.[0] && perms.ventas?.views?.includes("pos"));
    }
    if (mod === "reportes") {
      return Object.values(perms).some((item) => item?.actions?.[0]);
    }
    const modPerms = perms[mod];
    if (!modPerms || !modPerms.actions[0]) return false;
    if (view && MODULE_VIEWS_MAP[mod]?.includes(view)) {
      return modPerms.views.includes(view);
    }
    return true;
  }

  const allowedModules = ROLE_MODULES[userOrRole.role] || [];
  return allowedModules.includes(mod);
}

function requireModuleAccess(user, moduleKey, viewKey = null) {
  if (canAccessModule(user, moduleKey, viewKey)) return;
  throw httpForbidden("No tienes permisos para acceder a este modulo o seccion.");
}

function requireAdminRole(user) {
  if (!user || user.role !== "Administrador") {
    throw httpForbidden("Se requiere rol de Administrador para realizar esta operacion.");
  }
}

function requireGlobalAdminRole(user) {
  if (!user || !user.isGlobalAdmin || user.role !== "Administrador") {
    throw httpForbidden("Solo el administrador global puede ejecutar esta accion.");
  }
}

function resolveTenantCompanyId(user, requestedCompanyId) {
  if (!user || !Number.isInteger(Number(user.companyId)) || Number(user.companyId) <= 0) {
    const error = new Error("Sesion de usuario invalida o sin empresa asignada.");
    error.statusCode = 401;
    throw error;
  }

  const ownCompanyId = Number(user.companyId);
  if (requestedCompanyId === undefined || requestedCompanyId === null || requestedCompanyId === "") {
    return ownCompanyId;
  }

  const targetCompanyId = Number(requestedCompanyId);
  if (!Number.isInteger(targetCompanyId) || targetCompanyId <= 0) {
    const error = new Error("La empresa seleccionada no es valida.");
    error.statusCode = 400;
    throw error;
  }

  if (targetCompanyId !== ownCompanyId) {
    if (!user.isGlobalAdmin || user.role !== "Administrador") {
      throw httpForbidden("Acceso denegado (Anti-IDOR): no tienes autorizacion para acceder a registros de otra empresa.");
    }
  }

  return targetCompanyId;
}

module.exports = {
  DEFAULT_ROLE_PERMISSIONS,
  MODULE_VIEWS_MAP,
  ROLE_MODULES,
  canAccessModule,
  normalizePermissions,
  requireAdminRole,
  requireGlobalAdminRole,
  requireModuleAccess,
  resolveTenantCompanyId,
};
