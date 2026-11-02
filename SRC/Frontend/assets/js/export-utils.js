/*
 * Exportacion universal a Excel (.xlsx) y PDF para todas las pantallas del sistema.
 *
 * window.gestionExport.toExcel({ filename, sheetName, title, subtitle, columns, rows })
 *   Genera un archivo .xlsx real (Office Open XML) sin dependencias externas.
 * window.gestionExport.toPdf({ filename, title, subtitle, columns, rows, orientation, totals })
 *   Abre el documento formateado en el dialogo de impresion para "Guardar como PDF".
 * window.gestionExport.elementToPdf(element, { title, orientation })
 *   Imprime/guarda como PDF un bloque HTML ya renderizado (p. ej. un reporte contable).
 * window.gestionExport.tableData(tableElement, { skipLast })
 *   Extrae { columns, rows } de una tabla HTML (omite la columna "Acciones").
 */
(function () {
  const encoder = new TextEncoder();

  function xmlEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  }

  function htmlEscape(value) {
    return xmlEscape(value).replace(/'/g, "&#039;");
  }

  // ---------- ZIP (metodo "store", sin compresion) ----------
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function buildZip(files) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const chunks = [];
    const central = [];
    let offset = 0;
    files.forEach(({ name, content }) => {
      const nameBytes = encoder.encode(name);
      const data = typeof content === "string" ? encoder.encode(content) : content;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, data);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(10, 0, true);
      entry.setUint16(12, dosTime, true);
      entry.setUint16(14, dosDate, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true);
      entry.setUint16(28, nameBytes.length, true);
      entry.setUint32(42, offset, true);
      central.push(new Uint8Array(entry.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    });
    const centralSize = central.reduce((total, part) => total + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  // ---------- XLSX ----------
  function columnLetter(index) {
    let letter = "";
    let n = index + 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      letter = String.fromCharCode(65 + rem) + letter;
      n = Math.floor((n - 1) / 26);
    }
    return letter;
  }

  function numericValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const text = String(value ?? "").trim();
    // Montos con separador de miles o simbolo de moneda: "L 1,250.50", "$1,200", "-35.5"
    const cleaned = text.replace(/^(L|\$|USD|HNL|MXN)\s?/i, "").replace(/,/g, "");
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(cleaned) && cleaned.length < 16) return Number(cleaned);
    return null;
  }

  function cellXml(ref, value, style = 0) {
    const number = style === 1 || style === 3 ? null : numericValue(value);
    if (number !== null) return `<c r="${ref}" s="${style === 0 ? 2 : style}"><v>${number}</v></c>`;
    return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }

  function toExcel({ filename = "reporte", sheetName = "Hoja1", title = "", subtitle = "", columns = [], rows = [] } = {}) {
    const sheetRows = [];
    let rowIndex = 1;
    if (title) sheetRows.push(`<row r="${rowIndex}">${cellXml(`A${rowIndex++}`, title, 3)}</row>`);
    if (subtitle) sheetRows.push(`<row r="${rowIndex}">${cellXml(`A${rowIndex++}`, subtitle, 0)}</row>`);
    if (title || subtitle) rowIndex += 1;
    const headerRow = rowIndex;
    sheetRows.push(`<row r="${rowIndex}">${columns.map((column, index) => cellXml(`${columnLetter(index)}${rowIndex}`, column, 1)).join("")}</row>`);
    rowIndex += 1;
    rows.forEach((row) => {
      sheetRows.push(`<row r="${rowIndex}">${row.map((value, index) => cellXml(`${columnLetter(index)}${rowIndex}`, value, 0)).join("")}</row>`);
      rowIndex += 1;
    });
    const widths = columns.map((column, index) => {
      const longest = Math.max(String(column).length, ...rows.map((row) => String(row[index] ?? "").length));
      return Math.min(Math.max(longest + 2, 8), 60);
    });
    const lastColumn = columnLetter(Math.max(columns.length - 1, 0));
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>
<sheetData>${sheetRows.join("")}</sheetData>
${columns.length ? `<autoFilter ref="A${headerRow}:${lastColumn}${Math.max(rowIndex - 1, headerRow)}"/>` : ""}
</worksheet>`;
    const safeSheet = xmlEscape(String(sheetName).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Hoja1");
    const files = [
      {
        name: "[Content_Types].xml",
        content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      },
      {
        name: "_rels/.rels",
        content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      },
      {
        name: "xl/workbook.xml",
        content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets>${columns.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${safeSheet}'!$A$${headerRow}:$${lastColumn}$${Math.max(rowIndex - 1, headerRow)}</definedName></definedNames>` : ""}</workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      },
      {
        name: "xl/styles.xml",
        content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF1F2937"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E3A8A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
      },
      { name: "xl/worksheets/sheet1.xml", content: sheet },
    ];
    download(buildZip(files), `${safeFilename(filename)}.xlsx`);
  }

  // ---------- PDF (via dialogo de impresion "Guardar como PDF") ----------
  function companyHeader() {
    const user = window.gestionUserDb?.getCurrentUser?.() || {};
    return { company: user.company || "Gestion Empresarial", username: user.username || "", locale: user.locale || "es-HN" };
  }

  const PRINT_CSS = `
    *{box-sizing:border-box} body{font-family:Inter,Segoe UI,Arial,sans-serif;color:#111827;margin:0;padding:18px;font-size:11px}
    header.doc{border-bottom:2px solid #1e3a8a;margin-bottom:12px;padding-bottom:8px}
    header.doc h1{font-size:17px;margin:0 0 2px;color:#1e3a8a} header.doc h2{font-size:12px;margin:0;color:#374151;font-weight:600}
    header.doc p{margin:2px 0 0;color:#6b7280}
    table{width:100%;border-collapse:collapse} th{background:#1e3a8a;color:#fff;text-align:left;padding:6px 7px;font-size:10.5px}
    td{padding:5px 7px;border-bottom:1px solid #e5e7eb;vertical-align:top} tr:nth-child(even) td{background:#f9fafb}
    td.num{text-align:right;font-variant-numeric:tabular-nums} tfoot td{font-weight:700;border-top:2px solid #1e3a8a;background:#eef2ff!important}
    footer.doc{margin-top:14px;color:#6b7280;font-size:10px;display:flex;justify-content:space-between}
    @media print{body{padding:0} thead{display:table-header-group} tr{page-break-inside:avoid}}`;

  function printHtml(bodyHtml, { title = "Documento", orientation = "portrait", extraCss = "", stylesheets = [] } = {}) {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    const links = stylesheets.map((href) => `<link rel="stylesheet" href="${htmlEscape(href)}">`).join("");
    doc.open();
    doc.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${htmlEscape(title)}</title>${links}<style>@page{size:A4 ${orientation};margin:10mm}${PRINT_CSS}${extraCss}</style></head><body>${bodyHtml}</body></html>`);
    doc.close();
    const run = () => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 1500);
    };
    if (stylesheets.length) setTimeout(run, 450);
    else setTimeout(run, 80);
  }

  function toPdf({ filename = "reporte", title = "Reporte", subtitle = "", columns = [], rows = [], totals = null, orientation } = {}) {
    const meta = companyHeader();
    const numericColumns = columns.map((_, index) => rows.length > 0 && rows.every((row) => row[index] === "" || row[index] == null || numericValue(row[index]) !== null));
    const cell = (value, index) => `<td class="${numericColumns[index] ? "num" : ""}">${htmlEscape(value)}</td>`;
    const body = rows.length
      ? rows.map((row) => `<tr>${row.map(cell).join("")}</tr>`).join("")
      : `<tr><td colspan="${Math.max(columns.length, 1)}" style="text-align:center;color:#6b7280;padding:16px">Sin registros para mostrar.</td></tr>`;
    const foot = Array.isArray(totals) ? `<tfoot><tr>${totals.map(cell).join("")}</tr></tfoot>` : "";
    const stamp = new Intl.DateTimeFormat(meta.locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date());
    const html = `<header class="doc"><h1>${htmlEscape(meta.company)}</h1><h2>${htmlEscape(title)}</h2>${subtitle ? `<p>${htmlEscape(subtitle)}</p>` : ""}</header>
      <table><thead><tr>${columns.map((column) => `<th>${htmlEscape(column)}</th>`).join("")}</tr></thead><tbody>${body}</tbody>${foot}</table>
      <footer class="doc"><span>Usuario: ${htmlEscape(meta.username)}</span><span>${htmlEscape(rows.length)} registro(s)</span><span>Generado: ${htmlEscape(stamp)}</span></footer>`;
    printHtml(html, { title: safeFilename(filename), orientation: orientation || (columns.length > 7 ? "landscape" : "portrait") });
  }

  function elementToPdf(element, { title = "Documento", orientation = "portrait" } = {}) {
    if (!element) return;
    const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.href);
    printHtml(element.outerHTML, { title, orientation, stylesheets, extraCss: "body{padding:0}" });
  }

  function tableData(table, { skipColumns = ["Acciones"] } = {}) {
    if (!table) return { columns: [], rows: [] };
    const headerCells = [...table.querySelectorAll("thead th")];
    const keep = headerCells.map((th) => !skipColumns.includes(th.textContent.trim()));
    const columns = headerCells.filter((_, index) => keep[index]).map((th) => th.textContent.trim());
    const rows = [...table.querySelectorAll("tbody tr")]
      .filter((tr) => !tr.hidden && tr.children.length === headerCells.length)
      .map((tr) => [...tr.children].filter((_, index) => keep[index]).map((td) => td.textContent.trim()));
    return { columns, rows };
  }

  function safeFilename(name) {
    return String(name || "reporte").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "_").slice(0, 80);
  }

  function download(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 500);
  }

  window.gestionExport = { toExcel, toPdf, elementToPdf, tableData, printHtml, safeFilename };
})();
