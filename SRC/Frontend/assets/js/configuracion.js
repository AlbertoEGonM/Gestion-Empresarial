const configForm = document.querySelector("#general-config-form");
const saveButton = document.querySelector("#config-save");
const statusMessage = document.querySelector("#config-status");
const configToast = document.querySelector("#config-toast");
const logoInput = document.querySelector("#company-logo-input");
const logoTrigger = document.querySelector("#logo-trigger");
const logoPreview = document.querySelector("#company-logo-preview");
const logoLetter = document.querySelector("#company-logo-letter");
const logoError = document.querySelector("#logo-error");
const dateInput = document.querySelector("#billing-deadline");
const dateTrigger = document.querySelector("#date-trigger");

let logoData = "";

function activeUser() {
  return window.gestionUserDb?.getCurrentUser() || {};
}

function configStorageKey() {
  const companyId = Number(activeUser().companyId || 1);
  return `textiles-gh-c${companyId}-general-config`;
}

function showConfigToast(message, isError = false) {
  if (!configToast) return;
  configToast.textContent = message;
  configToast.classList.toggle("error", Boolean(isError));
  configToast.hidden = false;
  window.clearTimeout(showConfigToast.timer);
  showConfigToast.timer = window.setTimeout(() => {
    configToast.hidden = true;
  }, 3000);
}

function setLogoPreview(source) {
  logoData = source || "";
  logoPreview.src = logoData;
  logoPreview.hidden = !logoData;
  logoLetter.hidden = Boolean(logoData);
  const companyName = activeUser().company || "Textil";
  logoLetter.textContent = companyName.charAt(0).toUpperCase();
}

function applyCompanyDefaults() {
  const user = activeUser();
  const isMexico = user.countryCode === "MX";
  const defaults = {
    businessName: user.company || "Vicmar Textil S.A.",
    rtn: user.taxId || (isMexico ? "TOL0805129A1" : "0801-1998-004210"),
    address: `${user.city || (isMexico ? "Ciudad de Mexico" : "Tegucigalpa")}, ${user.countryName || (isMexico ? "Mexico" : "Honduras")}`,
    exchangeRate: isMexico ? "19.85" : "24.75",
    salesTax: String(user.taxRate ?? (isMexico ? 16 : 15)),
    minimumStock: "100",
    cai: isMexico ? "CFDI-4.0-SERIE-A-FOLIO-2026" : "3D5A9E-19B2C4-4F8A61-2E7D30-F1C5B9-0A",
    rangeFrom: isMexico ? "A-00000001" : "000-001-01-00000001",
    rangeTo: isMexico ? "A-00005000" : "000-001-01-00000500",
    billingDeadline: "2026-12-31",
  };
  Object.entries(defaults).forEach(([name, value]) => {
    const field = configForm.elements.namedItem(name);
    if (field) field.value = value;
  });
  setLogoPreview("");
}

function applySavedFields(fields = {}, logo = "") {
  Object.entries(fields).forEach(([name, value]) => {
    const field = configForm.elements.namedItem(name);
    if (field && value !== undefined && value !== "") {
      field.value = value;
      field.dataset.userEdited = "true";
    }
  });
  setLogoPreview(logo);
}

async function readSavedConfiguration() {
  applyCompanyDefaults();
  try {
    const savedLocal = JSON.parse(localStorage.getItem(configStorageKey()));
    if (savedLocal?.fields) {
      applySavedFields(savedLocal.fields, savedLocal.logo);
    }
  } catch (error) {
    localStorage.removeItem(configStorageKey());
  }

  try {
    const remote = await window.gestionUserDb.getDataset("administrador", "configuracion");
    if (remote.initialized && Array.isArray(remote.rows) && remote.rows[0]) {
      const [businessName, rtn, address, exchangeRate, salesTax, minimumStock, cai, rangeFrom, rangeTo, billingDeadline] = remote.rows[0];
      applySavedFields(
        { businessName, rtn, address, exchangeRate, salesTax, minimumStock, cai, rangeFrom, rangeTo, billingDeadline },
        logoData
      );
    }
  } catch (error) {
    // Mantiene la configuracion local si la sincronizacion remota no esta disponible.
  }
}

function collectFields() {
  return Object.fromEntries(new FormData(configForm).entries());
}

logoTrigger.addEventListener("click", () => logoInput.click());

logoInput.addEventListener("change", () => {
  const [file] = logoInput.files;
  logoError.hidden = true;
  if (!file) return;

  if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 1024 * 1024) {
    logoError.textContent = "Selecciona una imagen PNG o JPG de hasta 1 MB.";
    logoError.hidden = false;
    logoInput.value = "";
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", () => setLogoPreview(reader.result));
  reader.readAsDataURL(file);
});

dateTrigger.addEventListener("click", () => {
  if (typeof dateInput.showPicker === "function") {
    dateInput.showPicker();
  } else {
    dateInput.focus();
  }
});

configForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configForm.reportValidity()) return;

  const fields = collectFields();
  saveButton.disabled = true;
  saveButton.textContent = "Guardando...";

  try {
    localStorage.setItem(
      configStorageKey(),
      JSON.stringify({
        fields,
        logo: logoData,
      })
    );
    await window.gestionUserDb.saveDataset("administrador", "configuracion", [
      [
        fields.businessName || "",
        fields.rtn || "",
        fields.address || "",
        fields.exchangeRate || "",
        fields.salesTax || "",
        fields.minimumStock || "",
        fields.cai || "",
        fields.rangeFrom || "",
        fields.rangeTo || "",
        fields.billingDeadline || "",
        "Asignando...",
      ],
    ]);
    saveButton.textContent = "Cambios Guardados";
    saveButton.classList.add("saved");
    statusMessage.textContent = "La configuracion fiscal y operativa se guardo correctamente.";
    showConfigToast(`Configuracion de ${activeUser().company || "la empresa"} actualizada.`);

    window.setTimeout(() => {
      saveButton.textContent = "Guardar Cambios";
      saveButton.classList.remove("saved");
    }, 1800);
  } catch (error) {
    statusMessage.textContent = error.message || "No fue posible guardar los cambios.";
    showConfigToast(error.message || "Error al guardar la configuracion.", true);
    saveButton.textContent = "Guardar Cambios";
  } finally {
    saveButton.disabled = false;
  }
});

readSavedConfiguration();
