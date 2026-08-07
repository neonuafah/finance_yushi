'use strict';

const ExcelJS = require('exceljs');
const { buildReport } = require('./report');

const MONEY = '#,##0.00;(#,##0.00)';
const FONT = { name: 'Tahoma', size: 10 };
const FONT_BOLD = { name: 'Tahoma', size: 10, bold: true };

/**
 * ออกไฟล์ Excel หน้าตาตามรายงานแยกประเภททั่วไปต้นฉบับ
 * โดยแสดงเฉพาะรายการที่ยังไม่มีคู่ พร้อมยอดคงเหลือที่คำนวณใหม่
 * @param {object} job
 * @returns {Promise<Buffer>}
 */
async function exportExcel(job) {
  const report = buildReport(job);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ระบบจับคู่เงินทดรองจ่าย';
  wb.created = new Date();

  const ws = wb.addWorksheet('รายการที่ยังไม่มีคู่', {
    views: [{ state: 'frozen', ySplit: 8 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const cols = report.columns;
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));
  const lastCol = cols.length;
  const colLetter = (n) => ws.getColumn(n).letter;
  const span = (row) => `A${row}:${colLetter(lastCol)}${row}`;

  let r = 0;
  const put = (text, font = FONT, align = 'left') => {
    r += 1;
    ws.mergeCells(span(r));
    const cell = ws.getCell(`A${r}`);
    cell.value = text;
    cell.font = font;
    cell.alignment = { horizontal: align, vertical: 'middle' };
    return r;
  };

  // ---- หัวรายงาน ----
  put(report.header.company, { name: 'Tahoma', size: 12, bold: true });
  put(report.header.title, FONT_BOLD, 'center');
  put(report.header.periodLine, FONT);
  put(report.header.accountLine, FONT);
  put(`${report.header.printedAt}    แหล่งข้อมูล : ${report.header.sourceName}`, {
    name: 'Tahoma',
    size: 9,
    italic: true,
  });

  // ---- หัวตาราง ----
  r += 1;
  const headerRow = ws.getRow(r);
  cols.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.label;
    cell.font = FONT_BOLD;
    cell.alignment = { horizontal: c.align === 'right' ? 'right' : 'center', vertical: 'middle' };
    cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  });
  headerRow.commit();
  const headerRowNo = r;

  // ---- ยอดยกมา ----
  r += 1;
  const opening = ws.getRow(r);
  opening.getCell(1).value = report.opening.accountCode;
  opening.getCell(3).value = report.opening.accountName;
  opening.getCell(4).value = 'ยอดยกมา';
  opening.getCell(lastCol).value = report.opening.balance;
  opening.getCell(lastCol).numFmt = MONEY;
  opening.eachCell({ includeEmpty: false }, (cell) => {
    cell.font = FONT_BOLD;
  });
  opening.commit();

  // ---- รายการ ----
  const firstDataRow = r + 1;
  for (const item of report.body) {
    r += 1;
    const row = ws.getRow(r);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      const value = item[c.key];
      cell.value = c.money ? (value === 0 ? null : value) : value || '';
      cell.font = FONT;
      if (c.money) cell.numFmt = MONEY;
      cell.alignment = {
        horizontal: c.align === 'center' ? 'center' : c.align,
        vertical: 'top',
        wrapText: c.key === 'description',
      };
    });
    if (item.partial) {
      // เคลียร์ไปแล้วบางส่วน — เน้นให้เห็นว่ายอดที่เหลือไม่ใช่ยอดเต็มของใบสำคัญ
      row.getCell(7).note = `ยอดเต็ม ${item.originalAmount.toFixed(2)} เคลียร์แล้ว ${item.matchedAmount.toFixed(2)}`;
      cols.forEach((_, i) => {
        row.getCell(i + 1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFF6E0' },
        };
      });
    }
    row.commit();
  }
  const lastDataRow = r;

  // ---- แถวรวม ----
  r += 1;
  const totalRow = ws.getRow(r);
  totalRow.getCell(4).value = `รวม ${report.totals.rowCount} รายการที่ยังไม่มีคู่`;
  totalRow.getCell(5).value = report.totals.debit;
  totalRow.getCell(6).value = report.totals.credit;
  totalRow.getCell(lastCol).value = report.totals.closingBalance;
  [5, 6, lastCol].forEach((i) => {
    totalRow.getCell(i).numFmt = MONEY;
  });
  totalRow.eachCell({ includeEmpty: false }, (cell) => {
    cell.font = FONT_BOLD;
    cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  });
  totalRow.commit();

  // ---- สรุปการประมวลผล ----
  r += 1;
  const note = (label, value) => {
    r += 1;
    ws.getCell(`D${r}`).value = label;
    ws.getCell(`D${r}`).font = FONT;
    ws.getCell(`E${r}`).value = value;
    ws.getCell(`E${r}`).font = FONT;
    if (typeof value === 'number') ws.getCell(`E${r}`).numFmt = MONEY;
  };
  note('รายการทั้งหมดในรายงาน', report.totals.entryCount);
  note('จับคู่ได้ (คู่)', report.totals.matchedPairs);
  note(`เดบิตที่ยังไม่มีคู่ (${report.totals.unmatchedDebitCount} รายการ)`, report.totals.unmatchedDebitTotal);
  note(`เครดิตที่ไม่มีคู่ (${report.totals.unmatchedCreditCount} รายการ)`, report.totals.unmatchedCreditTotal);
  note('ยอดยกมา', report.opening.balance);
  note('ยอดคงเหลือที่คำนวณใหม่', report.totals.closingBalance);
  if (report.totals.reportedClosing !== null && report.totals.reportedClosing !== undefined) {
    note('ยอดคงเหลือตามรายงานต้นฉบับ', report.totals.reportedClosing);
  }

  for (const w of report.warnings) {
    r += 2;
    ws.mergeCells(span(r));
    const cell = ws.getCell(`A${r}`);
    cell.value = `หมายเหตุ: ${w}`;
    cell.font = { name: 'Tahoma', size: 9, italic: true, color: { argb: 'FF9A6700' } };
    cell.alignment = { wrapText: true };
  }

  if (lastDataRow >= firstDataRow) {
    ws.autoFilter = {
      from: { row: headerRowNo, column: 1 },
      to: { row: lastDataRow, column: lastCol },
    };
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = { exportExcel };
