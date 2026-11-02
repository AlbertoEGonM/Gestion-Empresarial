const firstNameInput = document.querySelector("#firstName");
const lastNameInput = document.querySelector("#lastName");
const secondLastNameInput = document.querySelector("#secondLastName");
const emailInput = document.querySelector("#email");
const companyInput = document.querySelector("#company");
const roleInput = document.querySelector("#role");
const usernameInput = document.querySelector("#username");
const passwordInput = document.querySelector("#password");
const togglePasswordButton = document.querySelector("#toggle-password");
const signupForm = document.querySelector("#signup-form");
const registerAlert = document.querySelector("#register-alert");
const honeypotInput = document.querySelector("#website_url");
const { emailError, normalizeEmail, passwordError, setFieldError } = window.gestionValidation;
const formRenderedAt = Date.now();

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeUsernamePart(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function updateGeneratedUsername() {
  const firstName = normalizeUsernamePart(firstNameInput.value);
  const lastNameInitial = normalizeUsernamePart(lastNameInput.value).charAt(0);
  usernameInput.value = firstName && lastNameInitial ? `${firstName}${lastNameInitial}` : "";
}

function showRegisterAlert(message, success = false) {
  registerAlert.querySelector("span").textContent = message;
  registerAlert.classList.toggle("success-alert", success);
  registerAlert.hidden = false;
}

async function loadCompanies() {
  try {
    const companies = await window.gestionUserDb.listCompanies();
    companyInput.innerHTML = '<option value="">Selecciona una empresa</option>' + companies.map((company) =>
      `<option value="${escapeHtml(company.id)}">${escapeHtml(company.name)}</option>`
    ).join("");
    companyInput.disabled = false;
  } catch (error) {
    companyInput.innerHTML = '<option value="">No se pudieron cargar las empresas</option>';
    showRegisterAlert(error.message);
  }
}

firstNameInput.addEventListener("input", updateGeneratedUsername);
lastNameInput.addEventListener("input", updateGeneratedUsername);
emailInput.addEventListener("blur", () => {
  emailInput.value = normalizeEmail(emailInput.value);
  setFieldError(emailInput, emailError(emailInput.value));
});
emailInput.addEventListener("input", () => setFieldError(emailInput, ""));
passwordInput.addEventListener("blur", () => setFieldError(passwordInput, passwordError(passwordInput.value, usernameInput.value)));
passwordInput.addEventListener("input", () => setFieldError(passwordInput, ""));
togglePasswordButton.addEventListener("click", () => {
  const isHidden = passwordInput.type === "password";
  passwordInput.type = isHidden ? "text" : "password";
  togglePasswordButton.setAttribute("aria-label", isHidden ? "Ocultar contrasena" : "Mostrar contrasena");
});

signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  registerAlert.hidden = true;
  emailInput.value = normalizeEmail(emailInput.value);
  const emailMessage = emailError(emailInput.value);
  const passwordMessage = passwordError(passwordInput.value, usernameInput.value);
  setFieldError(emailInput, emailMessage);
  setFieldError(passwordInput, passwordMessage);
  if (emailMessage || passwordMessage) {
    (emailMessage ? emailInput : passwordInput).focus();
    return;
  }
  if (!signupForm.checkValidity()) {
    signupForm.reportValidity();
    return;
  }
  const submitButton = signupForm.querySelector("button[type='submit']");
  try {
    submitButton.disabled = true;
    submitButton.textContent = "Enviando solicitud...";
    await window.gestionUserDb.createUser({
      firstName: firstNameInput.value,
      lastName: lastNameInput.value,
      secondLastName: secondLastNameInput.value,
      email: emailInput.value,
      password: passwordInput.value,
      companyId: Number(companyInput.value),
      role: roleInput.value,
      username: usernameInput.value,
      website_url: honeypotInput ? honeypotInput.value : "",
      _form_ts: formRenderedAt,
    });
    sessionStorage.setItem("gestionUser", usernameInput.value);
    showRegisterAlert("Solicitud enviada. El administrador validara tu empresa y area antes de habilitar el acceso.", true);
    signupForm.reset();
    updateGeneratedUsername();
  } catch (error) {
    showRegisterAlert(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Crear Cuenta";
  }
});

loadCompanies();
