'use strict';

const fs = require('fs');
const PDFDocument = require('pdfkit');
const config = require('../config');
const { buildReport, STATUS_NOTE } = require('./report');
const { formatAmount } = require('../domain');

/*
 * ออกไฟล์ PDF ให้หน้าตาและการจัดวางเหมือนรายงานแยกประเภททั่วไปต้นฉบับ
 * ทุกตัวเลขด้านล่างวัดมาจากไฟล์ PDF ต้นฉบับจริง (A4 แนวตั้ง บรรทัดละ 18 pt
 * หน้าละ 39 บรรทัด ตำแหน่งคอลัมน์ตามแกน x เดียวกัน)
 *
 *   บรรทัด 1  ชื่อบริษัท + "หน้า : n"      บรรทัด 5  เส้นประ
 *   บรรทัด 2  ชื่อรายงาน                   บรรทัด 6  หัวตาราง
 *   บรรทัด 3  ช่วงวันที่ + วันที่พิมพ์       บรรทัด 7  เส้นประ
 *   บรรทัด 4  ช่วงเลขที่บัญชี (หน้าแรก)     บรรทัด 8  เลขที่บัญชี + ยอดยกมา / "(ต่อ)"
 *
 * ต่างจากต้นฉบับตรงที่แสดงเฉพาะรายการที่ยังไม่มีคู่ และยอดคงเหลือคำนวณใหม่
 */

const PAGE_W = 595.28;

const LINE = 18; // ระยะห่างบรรทัดของต้นฉบับ
const TOP = 4; // ขอบบนของบรรทัดแรก
// ต้นฉบับใช้ฟอนต์ความกว้างคงที่ขนาด 12 ส่วน Sarabun เป็นฟอนต์สัดส่วนที่กว้างกว่า
// ขนาด 10 จึงเป็นค่าที่ตัวอักษรลงตำแหน่งคอลัมน์เดิมได้พอดีโดยไม่ชนกัน
const FONT_SIZE = 9.5;
const LINES_PER_PAGE = 39;

/** ตำแหน่งคอลัมน์ตามแกน x ของต้นฉบับ (R = ชิดขวาที่ตำแหน่งนั้น) */
const X = {
  date: 16,
  book: 58,
  voucher: 83,
  desc: 137,
  descEnd: 344,
  debitR: 417,
  creditR: 493,
  status: 497,
  balanceR: 581,
  headDate: 24,
  headBook: 58,
  headVoucher: 83,
  headDesc: 175,
  pageLabel: 520,
  pageNoR: PAGE_W - 8,
  contd: 348,
};

const NOTE_1 = "หมายเหตุ  ในช่อง 'สถานะ' ถ้ามีอักษร C จะหมายถึงว่า เป็นรายการที่ถูกยกเลิก";
const NOTE_2 = 'E จะหมายถึงว่า เป็นรายการที่แก้ไขเพิ่มเติม หลังจากผ่านบัญชีแล้ว (แก้ไขแบบมีร่องรอย)';

/**
 * @param {object} job
 * @returns {Promise<Buffer>}
 */
function exportPdf(job) {
  const report = buildReport(job);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'portrait',
      margin: 0,
      autoFirstPage: false,
      info: {
        Title: `${report.header.title} (${report.header.subtitle})`,
        Author: report.header.company,
        Creator: 'ระบบจับคู่เงินทดลองจ่าย',
      },
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      registerFonts(doc);
    } catch (err) {
      doc.end();
      reject(new Error(`โหลดฟอนต์ไทยไม่สำเร็จ: ${err.message}`));
      return;
    }

    const printer = createPrinter(doc, report);

    printer.newPage();
    for (const item of report.body) {
      printer.ensureLine();
      printer.dataRow(item);
    }
    printer.footer();

    doc.end();
  });
}

/** ตัวช่วยพิมพ์ทีละบรรทัดตามกริดของต้นฉบับ */
function createPrinter(doc, report) {
  let pageNo = 0;
  let line = 0; // บรรทัดที่ใช้ไปแล้วในหน้านี้

  const y = () => TOP + line * LINE;

  /** ตัดข้อความให้พอดีความกว้างคอลัมน์ เหมือนที่รายงานต้นฉบับตัดตามจำนวนตัวอักษร */
  const fit = (text, max) => {
    let s = thaiText(text);
    if (!s || !max) return s;
    while (s.length > 1 && doc.widthOfString(s) > max) s = s.slice(0, -1);
    return s;
  };

  /** วางข้อความชิดซ้ายที่ x โดยไม่ตัดขึ้นบรรทัดใหม่ */
  const at = (x, text, max) => {
    const s = fit(text, max);
    if (s) doc.text(s, x, y(), { lineBreak: false });
  };

  /** วางข้อความชิดขวาโดยให้ปลายอยู่ที่ x */
  const atRight = (x, text) => {
    const s = thaiText(text);
    if (s) doc.text(s, x - doc.widthOfString(s), y(), { lineBreak: false });
  };

  /** เส้นประยาวเท่าความกว้างที่ต้องการ */
  const rule = (x, width, ch = '-') => {
    const unit = doc.widthOfString(ch);
    at(x, ch.repeat(Math.max(1, Math.round(width / unit))));
  };

  const newPage = () => {
    doc.addPage();
    doc.font('regular').fontSize(FONT_SIZE).fillColor('#000');
    pageNo += 1;
    line = 0;

    at(X.date, report.header.company);
    at(X.pageLabel, 'หน้า :');
    atRight(X.pageNoR, String(pageNo));
    line += 1;

    at(X.date, `${report.header.title}   (${report.header.subtitle})`);
    line += 1;

    const period = splitPrintedDate(report.header.periodLine);
    at(X.date, period.text, X.pageLabel - X.date - 4);
    at(X.pageLabel, `วันที่ : ${period.printedAt || report.header.printedAt}`);
    line += 1;

    if (pageNo === 1) {
      at(X.date, report.header.accountLine);
      line += 1;
    }

    rule(X.date, X.balanceR - X.date);
    line += 1;
    headRow();
    line += 1;
    rule(X.date, X.balanceR - X.date);
    line += 1;

    at(X.date, report.opening.accountCode);
    at(104, report.opening.accountName);
    if (pageNo === 1) atRight(X.balanceR, formatAmount(report.opening.balance) || '0.00');
    else at(X.contd, '(ต่อ)');
    line += 1;
  };

  const headRow = () => {
    at(X.headDate, 'วันที่');
    at(X.headBook, 'สมุด');
    at(X.headVoucher, 'ใบสำคัญ');
    at(X.headDesc, 'คำอธิบาย');
    atRight(X.debitR, 'เดบิต');
    atRight(X.creditR, 'เครดิต');
    at(X.status, 'สถานะ');
    atRight(X.balanceR, 'ยอดคงเหลือ');
  };

  /** ขึ้นหน้าใหม่ถ้าบรรทัดในหน้านี้เต็มแล้ว */
  const ensureLine = (need = 1) => {
    if (line + need > LINES_PER_PAGE) newPage();
  };

  const dataRow = (item) => {
    at(X.date, item.dateDisplay, X.book - X.date);
    at(X.book, item.book, X.voucher - X.book - 2);
    at(X.voucher, item.voucher, X.desc - X.voucher - 2);
    at(X.desc, item.description, X.descEnd - X.desc);
    atRight(X.debitR, formatAmount(item.debit));
    atRight(X.creditR, formatAmount(item.credit));
    at(X.status, item.status, 20);
    atRight(X.balanceR, formatAmount(item.balance));
    line += 1;
  };

  /** ท้ายรายงาน: รวม / รวมทั้งสิ้น / หมายเหตุ / จบรายงาน / สรุปการจับคู่ */
  const footer = () => {
    const t = report.totals;
    ensureLine(12);

    numberRules('-');
    at(297, 'รวม');
    atRight(X.debitR, formatAmount(t.debit) || '0.00');
    atRight(X.creditR, formatAmount(t.credit) || '0.00');
    line += 3; // ต้นฉบับเว้นสองบรรทัด

    numberRules('-');
    at(163, 'รวมทั้งสิ้น');
    at(226, String(t.rowCount));
    at(243, 'รายการ');
    at(285, '1');
    at(297, 'บัญชี');
    atRight(X.debitR, formatAmount(t.debit) || '0.00');
    atRight(X.creditR, formatAmount(t.credit) || '0.00');
    line += 1;
    numberRules('=');

    at(20, NOTE_1);
    line += 1;
    at(150, NOTE_2);
    line += 1;
    at(150, STATUS_NOTE.trim());
    line += 2;

    at(X.date, '>>>>  จบรายงาน  <<<<');
    line += 2;

    // ---- สรุปการจับคู่ (ส่วนเพิ่มจากต้นฉบับ) ----
    const summary = [
      ['รายการทั้งหมดในรายงานต้นฉบับ', String(t.entryCount)],
      ['จับคู่ได้', `${t.matchedPairs} คู่`],
      [`เดบิตที่ยังไม่มีคู่ (${t.unmatchedDebitCount} รายการ)`, formatAmount(t.unmatchedDebitTotal) || '0.00'],
      [`เครดิตที่ไม่มีคู่ (${t.unmatchedCreditCount} รายการ)`, formatAmount(t.unmatchedCreditTotal) || '0.00'],
      ['ยอดยกมา', formatAmount(report.opening.balance) || '0.00'],
      ['ยอดคงเหลือที่คำนวณใหม่', formatAmount(t.closingBalance) || '0.00'],
    ];
    if (t.reportedClosing !== null && t.reportedClosing !== undefined) {
      summary.push(['ยอดคงเหลือตามรายงานต้นฉบับ', formatAmount(t.reportedClosing) || '0.00']);
    }
    summary.push(['แหล่งข้อมูล', report.header.sourceName]);

    ensureLine(summary.length + report.warnings.length + 1);
    at(X.date, 'สรุปการจับคู่');
    line += 1;
    for (const [label, value] of summary) {
      ensureLine();
      at(X.desc, label, 200);
      atRight(X.creditR, value);
      line += 1;
    }
    for (const w of report.warnings) {
      ensureLine();
      at(X.date, `หมายเหตุ: ${w}`, PAGE_W - X.date - 8);
      line += 1;
    }
  };

  /** เส้นคั่นสั้นๆ เหนือ/ใต้คอลัมน์ตัวเลข เหมือนต้นฉบับ */
  const numberRules = (ch) => {
    rule(348, X.debitR - 348, ch);
    rule(423, X.creditR - 423, ch);
    line += 1;
  };

  return { newPage, ensureLine, dataRow, footer };
}

function registerFonts(doc) {
  if (!fs.existsSync(config.fonts.regular)) {
    throw new Error(`ไม่พบไฟล์ฟอนต์ ${config.fonts.regular}`);
  }
  doc.registerFont('regular', config.fonts.regular);
  doc.registerFont('bold', fs.existsSync(config.fonts.bold) ? config.fonts.bold : config.fonts.regular);
  doc.font('regular');
}

/** แยก "วันที่ : dd/mm/yy" ออกจากบรรทัดช่วงวันที่ เพื่อวางไว้ชิดขวาเหมือนต้นฉบับ */
function splitPrintedDate(periodLine) {
  const s = String(periodLine || '');
  const m = s.match(/วันที่\s*:\s*([\d/]+)\s*$/);
  if (!m) return { text: s.replace(/\s{2,}/g, '  ').trim(), printedAt: '' };
  return {
    text: s.slice(0, m.index).replace(/\s{2,}/g, '  ').trim(),
    printedAt: m[1],
  };
}

/**
 * แยกสระอำ (U+0E33) เป็นนิคหิต + สระอา ล่วงหน้า
 * ฟอนต์วาดสองรูปนี้อยู่แล้ว การแยกก่อนทำให้ตาราง ToUnicode ใน PDF ตรงกับตัวอักษรจริง
 * (ผลลัพธ์บนหน้ากระดาษเหมือนเดิม แต่คัดลอกข้อความออกจาก PDF ได้ถูกต้อง)
 */
function thaiText(value) {
  const s = String(value ?? '');
  return s.includes('ำ') ? s.replace(/ำ/g, 'ํา') : s;
}

module.exports = { exportPdf };
