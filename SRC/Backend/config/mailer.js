const net = require("net");
const tls = require("tls");

function getMailConfig() {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    timeout: Number(process.env.SMTP_TIMEOUT_MS || 8000),
  };
}

function isConfigured(config) {
  return Boolean(config.host && config.from);
}

function readLine(socket, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tiempo de espera agotado con el servidor SMTP.")), timeout);
    const onData = (data) => {
      const text = data.toString();
      if (/^\d{3}[ -]/m.test(text)) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(text);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function command(socket, line, timeout) {
  socket.write(`${line}\r\n`);
  const response = await readLine(socket, timeout);
  if (!/^[23]/.test(response)) throw new Error(`SMTP rechazo el comando ${line.split(" ")[0]}: ${response.trim()}`);
  return response;
}

function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

async function sendRecoveryEmail({ to, username, recoveryUrl }) {
  const config = getMailConfig();
  if (!isConfigured(config)) {
    console.log(`SMTP no configurado. Enlace de recuperacion para ${to}: ${recoveryUrl}`);
    return { delivered: false, reason: "SMTP_NOT_CONFIGURED" };
  }

  let socket = config.secure
    ? tls.connect(config.port, config.host, { servername: config.host })
    : net.connect(config.port, config.host);

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
    socket.setTimeout(config.timeout, () => reject(new Error("Tiempo de espera agotado al conectar con SMTP.")));
  });

  await readLine(socket, config.timeout);
  await command(socket, `EHLO ${process.env.SMTP_HELO || "localhost"}`, config.timeout);

  if (!config.secure && process.env.SMTP_STARTTLS !== "false") {
    await command(socket, "STARTTLS", config.timeout);
    socket = await new Promise((resolve, reject) => {
      const secureSocket = tls.connect({ socket, servername: config.host }, () => resolve(secureSocket));
      secureSocket.once("error", reject);
    });
    await command(socket, `EHLO ${process.env.SMTP_HELO || "localhost"}`, config.timeout);
  }

  if (config.user && config.pass) {
    await command(socket, "AUTH LOGIN", config.timeout);
    await command(socket, Buffer.from(config.user).toString("base64"), config.timeout);
    await command(socket, Buffer.from(config.pass).toString("base64"), config.timeout);
  }

  const body = `Hola ${username},\n\nRecibimos una solicitud para restablecer tu contrasena. Usa este enlace durante la proxima hora:\n${recoveryUrl}\n\nSi no solicitaste este cambio, ignora este mensaje.`;
  const message = [
    `From: ${config.from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject("Recuperacion de contrasena - Gestion Empresarial")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");

  await command(socket, `MAIL FROM:<${config.from}>`, config.timeout);
  await command(socket, `RCPT TO:<${to}>`, config.timeout);
  await command(socket, "DATA", config.timeout);
  socket.write(`${message}\r\n.\r\n`);
  await readLine(socket, config.timeout);
  socket.write("QUIT\r\n");
  socket.end();
  return { delivered: true };
}

async function sendPayrollReceiptEmail({ to, employeeName, companyName, periodLabel, netPay, currencySymbol = "L", pdfBuffer, filename = "recibo-nomina.pdf" }) {
  const config = getMailConfig();
  if (!isConfigured(config)) {
    console.log(`SMTP no configurado. Recibo de nomina (${periodLabel}) preparado para ${to} (${employeeName}): ${currencySymbol} ${netPay}`);
    return { delivered: false, reason: "SMTP_NOT_CONFIGURED" };
  }

  let socket = config.secure
    ? tls.connect(config.port, config.host, { servername: config.host })
    : net.connect(config.port, config.host);

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
    socket.setTimeout(config.timeout, () => reject(new Error("Tiempo de espera agotado al conectar con SMTP.")));
  });

  await readLine(socket, config.timeout);
  await command(socket, `EHLO ${process.env.SMTP_HELO || "localhost"}`, config.timeout);

  if (!config.secure && process.env.SMTP_STARTTLS !== "false") {
    await command(socket, "STARTTLS", config.timeout);
    socket = await new Promise((resolve, reject) => {
      const secureSocket = tls.connect({ socket, servername: config.host }, () => resolve(secureSocket));
      secureSocket.once("error", reject);
    });
    await command(socket, `EHLO ${process.env.SMTP_HELO || "localhost"}`, config.timeout);
  }

  if (config.user && config.pass) {
    await command(socket, "AUTH LOGIN", config.timeout);
    await command(socket, Buffer.from(config.user).toString("base64"), config.timeout);
    await command(socket, Buffer.from(config.pass).toString("base64"), config.timeout);
  }

  const boundary = `----=_GestionNomina_${Date.now()}`;
  const textBody = `Hola ${employeeName},\r\n\r\nAdjuntamos tu recibo de nomina correspondiente al periodo ${periodLabel} en ${companyName}.\r\nImporte neto pagado: ${currencySymbol} ${Number(netPay || 0).toFixed(2)}.\r\n\r\nSaludos cordiales,\r\nDepartamento de Nomina - ${companyName}`;
  const pdfBase64 = Buffer.from(pdfBuffer || "").toString("base64").replace(/(.{76})/g, "$1\r\n");

  const message = [
    `From: ${config.from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(`Recibo de Nomina ${periodLabel} - ${companyName}`)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    textBody,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    pdfBase64,
    `--${boundary}--`,
  ].join("\r\n");

  await command(socket, `MAIL FROM:<${config.from}>`, config.timeout);
  await command(socket, `RCPT TO:<${to}>`, config.timeout);
  await command(socket, "DATA", config.timeout);
  socket.write(`${message}\r\n.\r\n`);
  await readLine(socket, config.timeout);
  socket.write("QUIT\r\n");
  socket.end();
  return { delivered: true };
}

module.exports = { sendRecoveryEmail, sendPayrollReceiptEmail };
