const form = document.querySelector("#purchase-form");
const productIdInput = document.querySelector("#productId");
const descriptionInput = document.querySelector("#description");
const quantityInput = document.querySelector("#quantity");
const unitSelect = document.querySelector("#unit");
const categorySelect = document.querySelector("#category");
const exchangeRateInput = document.querySelector("#exchangeRate");
const totalCostInput = document.querySelector("#totalCost");
const totalPriceInput = document.querySelector("#totalPrice");
const costPrefix = document.querySelector("#cost-currency-prefix");
const pricePrefix = document.querySelector("#price-currency-prefix");
const profitResult = document.querySelector("#profitResult");
const profitPercentResult = document.querySelector("#profitPercentResult");
const marginResult = document.querySelector("#marginResult");
const purchaseError = document.querySelector("#purchase-error");
const purchaseSubmit = document.querySelector("#purchase-submit");

function currentCompanyUser() {
  return window.gestionUserDb?.getCurrentUser() || {};
}

function selectedCurrency() {
  return document.querySelector('input[name="currency"]:checked')?.value || "USD";
}

function formatLocalMoney(value) {
  const user = currentCompanyUser();
  const sym = user.currencySymbol || "L";
  const locale = user.locale || "es-HN";
  return `${sym} ${Number(value || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function updateCurrencyPrefixes() {
  const user = currentCompanyUser();
  const isUsd = selectedCurrency() === "USD";
  const prefix = isUsd ? "$" : user.currencySymbol || "L";
  if (costPrefix) costPrefix.textContent = prefix;
  if (pricePrefix) pricePrefix.textContent = prefix;
  exchangeRateInput.disabled = !isUsd;
  if (!isUsd) {
    exchangeRateInput.value = "1.00";
  } else if (Number(exchangeRateInput.value) === 1) {
    exchangeRateInput.value = user.countryCode === "MX" ? "19.85" : "24.75";
  }
  updateResults();
}

function updateResults() {
  const isUsd = selectedCurrency() === "USD";
  const rate = isUsd ? Math.max(0.01, Number(exchangeRateInput.value || 1)) : 1;
  const cost = Number(totalCostInput.value || 0) * rate;
  const price = Number(totalPriceInput.value || 0) * rate;
  const profit = price - cost;
  const profitPercent = cost > 0 ? (profit / cost) * 100 : 0;
  const margin = price > 0 ? (profit / price) * 100 : 0;

  if (!cost && !price) {
    profitResult.textContent = "-";
    profitPercentResult.textContent = "-";
    marginResult.textContent = "-";
    return;
  }

  profitResult.textContent = formatLocalMoney(profit);
  profitPercentResult.textContent = `${profitPercent.toFixed(2)}%`;
  marginResult.textContent = `${margin.toFixed(2)}%`;
}

const userAtLoad = currentCompanyUser();
if (userAtLoad.countryCode === "MX") {
  exchangeRateInput.value = "19.85";
}

document.querySelectorAll('input[name="currency"]').forEach((radio) => {
  radio.addEventListener("change", updateCurrencyPrefixes);
});
[exchangeRateInput, totalCostInput, totalPriceInput].forEach((input) => {
  input.addEventListener("input", updateResults);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  purchaseError.hidden = true;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const user = currentCompanyUser();
  const code = productIdInput.value.trim().toUpperCase();
  const description = descriptionInput.value.trim();
  const quantity = Math.max(0.01, Number(quantityInput.value || 1));
  const unit = unitSelect.value || "Metro";
  const category = categorySelect.value || "Algodon";
  const isUsd = selectedCurrency() === "USD";
  const rate = isUsd ? Math.max(0.01, Number(exchangeRateInput.value || 1)) : 1;
  const localCostTotal = Number(totalCostInput.value || 0) * rate;
  const localPriceTotal = Number(totalPriceInput.value || 0) * rate;
  const unitCost = localCostTotal / quantity;
  const unitPrice = localPriceTotal / quantity;

  purchaseSubmit.disabled = true;
  purchaseSubmit.textContent = "Guardando ingreso...";

  try {
    const prodDataset = await window.gestionUserDb.getDataset("inventarios", "productos");
    const currentRows = prodDataset.initialized && Array.isArray(prodDataset.rows) ? prodDataset.rows : [];
    const newProductRow = [
      code,
      description,
      category,
      unit,
      String(quantity),
      formatLocalMoney(unitPrice),
      "Activo",
      "Asignando...",
    ];
    currentRows.unshift(newProductRow);
    const savedProd = await window.gestionUserDb.saveDataset("inventarios", "productos", currentRows);
    const companyId = Number(user.companyId || 1);
    localStorage.setItem(`textiles-clean-v2-c${companyId}-inventarios-productos-rows`, JSON.stringify(savedProd.rows));

    const kardexDataset = await window.gestionUserDb.getDataset("inventarios", "kardex");
    const kardexRows = kardexDataset.initialized && Array.isArray(kardexDataset.rows) ? kardexDataset.rows : [];
    const today = new Intl.DateTimeFormat(user.locale || "es-HN", { day: "numeric", month: "short", year: "numeric" })
      .format(new Date())
      .replace(".", "");
    kardexRows.unshift([
      today,
      code,
      `ING-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`,
      "Ingreso de lote",
      `${quantity} ${unit.toLowerCase()}`,
      "-",
      `${quantity} ${unit.toLowerCase()}`,
      formatLocalMoney(unitCost),
      "Asignando...",
    ]);
    const savedKardex = await window.gestionUserDb.saveDataset("inventarios", "kardex", kardexRows);
    localStorage.setItem(`textiles-clean-v2-c${companyId}-inventarios-kardex-rows`, JSON.stringify(savedKardex.rows));

    sessionStorage.setItem("textiles-gh-flash", `Lote ${code} costeado e ingresado al inventario correctamente.`);
    window.location.href = "./modulo.html?modulo=inventarios&vista=productos";
  } catch (error) {
    purchaseError.textContent = error.message || "No se pudo guardar el ingreso de tela.";
    purchaseError.hidden = false;
    purchaseSubmit.disabled = false;
    purchaseSubmit.textContent = "Guardar Ingreso";
  }
});

updateResults();
