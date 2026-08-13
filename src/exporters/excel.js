'use strict';

const ExcelJS = require('exceljs');
const { buildReport, STATUS_NOTE } = require('./report');

/*
 * ออกไฟล์ Excel ให้หน้าตาและการจัดวางเหมือนรายงานแยกประเภททั่วไปต้นฉบับ
 * ทุกค่าด้านล่างวัดมาจากไฟล์ต้นฉบับจริง (ความกว้างคอลัมน์ ฟอนต์ รูปแบบตัวเลข
 * ตำแหน่งหัวรายงาน แถวรวม และหมายเหตุท้ายรายงาน)
 *
 *   แถว 1  ชื่อบริษัท + เลขหน้า          แถว 5  หัวตาราง
 *   แถว 2  ชื่อรายงาน                    แถว 6  เลขที่บัญชี + ยอดยกมา
 *   แถว 3  ช่วงวันที่ + วันที่พิมพ์        แถว 7+ รายการ
 *   แถว 4  ช่วงเลขที่บัญชี               ท้าย   รวม / รวมทั้งสิ้น / หมายเหตุ
 *
 * ต่างจากต้นฉบับตรงที่แสดงเฉพาะรายการที่ยังไม่มีคู่ และยอดคงเหลือคำนวณใหม่
 */

/** รูปแบบบัญชีของต้นฉบับ — จัดหลักทศนิยมตรงกัน และแสดง 0 เป็นขีด */
const ACC_FMT = '_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-';
const DATE_FMT = 'mm-dd-yy';
const FONT = { name: 'Tahoma', size: 11 };

/**
 * ความกว้างคอลัมน์ A–H ตามต้นฉบับ (null = ใช้ค่าเริ่มต้นเหมือนต้นฉบับ)
 * หมายเหตุ: ExcelJS ถือว่า 9 เป็นค่าเริ่มต้นจึงไม่เขียนลงไฟล์ คอลัมน์ G (สถานะ)
 * เลยกว้าง 8.43 ตามค่าเริ่มต้นของ Excel — ต่างจากต้นฉบับเล็กน้อยจนมองไม่ออก
 */
const WIDTHS = [10.75, null, 10.875, 51.375, 13.125, 13.125, 9, 13.125];

const HEAD_LABELS = ['วันที่', 'สมุด', 'ใบสำคัญ', 'คำอธิบาย', 'เดบิต', 'เครดิต', 'สถานะ', 'ยอดคงเหลือ'];

const NOTE_1 = "หมายเหตุ  ในช่อง 'สถานะ' ถ้ามีอักษร C จะหมายถึงว่า เป็นรายการที่ถูกยกเลิก";
const NOTE_2 =
  '                          E จะหมายถึงว่า เป็นรายการที่แก้ไขเพิ่มเติม หลังจากผ่านบัญชีแล้ว (แก้ไขแบบมีร่องรอย)';

/**
 * @param {object} job
 * @returns {Promise<Buffer>}
 */
async function exportExcel(job) {
  const report = buildReport(job);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ระบบจับคู่เงินทดลองจ่าย';
  wb.created = new Date();

  const ws = wb.addWorksheet(sheetName(report));

  let r = 0;

  /** ข้อความยาวบรรทัดเดียวใน A เหมือนต้นฉบับ (ล้นไปคอลัมน์ข้างๆ ได้) */
  const textRow = (text) => {
    r += 1;
    if (text) ws.getCell(r, 1).value = text;
    return r;
  };

  const moneyCell = (row, col, value) => {
    const cell = ws.getCell(row, col);
    cell.value = value === 0 || value === null || value === undefined ? null : value;
    cell.numFmt = ACC_FMT;
    cell.font = FONT;
    return cell;
  };

  // ---- แถว 1–4: หัวรายงาน (ใช้บรรทัดดิบจากต้นฉบับถ้ามี) ----
  const src = report.header.lines || [];
  textRow(src[0] || report.header.company);
  textRow(`${report.header.title}   (${report.header.subtitle})`);
  textRow(src[2] || report.header.periodLine);
  textRow(src[3] || report.header.accountLine);

  // ---- แถว 5: หัวตาราง ----
  r += 1;
  HEAD_LABELS.forEach((label, i) => {
    const cell = ws.getCell(r, i + 1);
    cell.value = label;
    // ต้นฉบับใส่ฟอนต์/รูปแบบบัญชีไว้ที่หัวคอลัมน์ตัวเลขด้วย
    if (i >= 4) {
      cell.font = FONT;
      cell.numFmt = ACC_FMT;
    }
  });

  // ---- แถว 6: เลขที่บัญชี ชื่อบัญชี ยอดยกมา ----
  r += 1;
  ws.getCell(r, 1).value = report.opening.accountCode || '';
  ws.getCell(r, 3).value = report.opening.accountName || '';
  moneyCell(r, 8, report.opening.balance);

  // ---- แถว 7 เป็นต้นไป: รายการที่ยังไม่มีคู่ ----
  for (const item of report.body) {
    r += 1;
    const dateCell = ws.getCell(r, 1);
    const be = buddhistDate(item.date);
    if (be) {
      dateCell.value = be;
      dateCell.numFmt = DATE_FMT;
      dateCell.font = FONT;
    } else {
      dateCell.value = item.dateDisplay || '';
    }
    if (item.book) ws.getCell(r, 2).value = item.book;
    if (item.voucher) ws.getCell(r, 3).value = item.voucher;
    if (item.description) ws.getCell(r, 4).value = item.description;
    moneyCell(r, 5, item.debit);
    moneyCell(r, 6, item.credit);
    if (item.status) ws.getCell(r, 7).value = item.status;
    moneyCell(r, 8, item.balance);

    if (item.partial) {
      // เคลียร์ไปแล้วบางส่วน — เก็บรายละเอียดไว้เป็นคอมเมนต์ ไม่รบกวนหน้าตารายงาน
      ws.getCell(r, 7).note = `ยอดเต็ม ${item.originalAmount.toFixed(2)} เคลียร์แล้ว ${item.matchedAmount.toFixed(2)}`;
    }
  }

  // ---- แถวรวม ----
  r += 1;
  ws.getCell(r, 1).value = 'รวม';
  moneyCell(r, 5, report.totals.debit);
  moneyCell(r, 6, report.totals.credit);

  r += 3; // ต้นฉบับเว้นสองแถวระหว่าง "รวม" กับ "รวมทั้งสิ้น"
  ws.getCell(r, 1).value = 'รวมทั้งสิ้น';
  ws.getCell(r, 2).value = report.totals.rowCount;
  ws.getCell(r, 3).value = 'รายการ';
  ws.getCell(r, 4).value = 1;
  moneyCell(r, 5, report.totals.debit);
  moneyCell(r, 6, report.totals.credit);

  r += 1;
  textRow(NOTE_1);
  r += 1;
  ws.getCell(r, 2).value = NOTE_2;
  r += 1;
  ws.getCell(r, 2).value = STATUS_NOTE.trim();

  // ตั้งความกว้างคอลัมน์ท้ายสุด เพื่อให้ค่าติดไปกับคอลัมน์ที่มีเซลล์อยู่จริงแล้ว
  WIDTHS.forEach((w, i) => {
    if (w) ws.getColumn(i + 1).width = w;
  });

  addSummarySheet(wb, report);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * สรุปการจับคู่ (ส่วนเพิ่มจากต้นฉบับ) — แยกเป็นชีตต่างหาก
 * เพื่อให้ชีตรายงานเหมือนต้นฉบับล้วนๆ และลบ/ไม่พิมพ์ชีตสรุปทิ้งได้ถ้าไม่ต้องการ
 */
function addSummarySheet(wb, report) {
  const ws = wb.addWorksheet('สรุปการจับคู่');
  ws.getColumn(1).width = 42;
  ws.getColumn(2).width = 18;

  let r = 0;
  ws.getCell((r += 1), 1).value = report.header.company;
  ws.getCell((r += 1), 1).value = `${report.header.title}   (${report.header.subtitle})`;
  ws.getCell((r += 1), 1).value = report.header.accountLine || '';
  r += 1;
  ws.getCell((r += 1), 1).value = 'สรุปการจับคู่';

  const summary = [
    ['รายการทั้งหมดในรายงานต้นฉบับ', report.totals.entryCount, '#,##0'],
    ['จับคู่ได้ (คู่)', report.totals.matchedPairs, '#,##0'],
    [`เดบิตที่ยังไม่มีคู่ (${report.totals.unmatchedDebitCount} รายการ)`, report.totals.unmatchedDebitTotal],
    [`เครดิตที่ไม่มีคู่ (${report.totals.unmatchedCreditCount} รายการ)`, report.totals.unmatchedCreditTotal],
    ['ยอดยกมา', report.opening.balance],
    ['ยอดคงเหลือที่คำนวณใหม่', report.totals.closingBalance],
  ];
  if (report.totals.reportedClosing !== null && report.totals.reportedClosing !== undefined) {
    summary.push(['ยอดคงเหลือตามรายงานต้นฉบับ', report.totals.reportedClosing]);
  }
  summary.push(['แหล่งข้อมูล', report.header.sourceName]);
  summary.push(['วันที่พิมพ์', report.header.printedAt]);

  for (const [label, value, fmt] of summary) {
    r += 1;
    ws.getCell(r, 1).value = label;
    const cell = ws.getCell(r, 2);
    cell.value = value;
    if (typeof value === 'number') {
      cell.numFmt = fmt || ACC_FMT;
      cell.font = FONT;
    }
  }

  for (const w of report.warnings) {
    r += 2;
    ws.getCell(r, 1).value = `หมายเหตุ: ${w}`;
  }
}

/** ชื่อชีตตามต้นฉบับ ถ้าใช้ไม่ได้ค่อยถอยไปใช้เลขที่บัญชี */
function sheetName(report) {
  const raw = report.header.sheetName || report.opening.accountCode || 'รายงาน';
  return raw.replace(/[[\]:*?/\\]/g, '').slice(0, 31) || 'รายงาน';
}

/**
 * ต้นฉบับเก็บวันที่เป็นวันที่จริงโดยใช้ปี พ.ศ. ตรงๆ (เช่น 2569-01-06)
 * จึงต้องสร้างกลับแบบเดียวกัน ไม่งั้นรูปแบบ mm-dd-yy จะโชว์ปี ค.ศ.
 */
function buddhistDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]) + 543, Number(m[2]) - 1, Number(m[3])));
}

module.exports = { exportExcel };
