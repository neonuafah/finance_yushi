'use strict';

const fs = require('fs');
const PDFDocument = require('pdfkit');
const config = require('../config');
const { buildReport } = require('./report');
const { formatAmount } = require('../domain');

/** สัดส่วนความกว้างคอลัมน์ (รวมกันได้ 1) อ้างอิงจากรายงานต้นฉบับ */
const WIDTH_RATIO = {
  dateDisplay: 0.062,
  book: 0.05,
  voucher: 0.085,
  description: 0.353,
  debit: 0.11,
  credit: 0.11,
  status: 0.05,
  balance: 0.12,
};

const FONT_SIZE = 8;
const HEAD_SIZE = 8.5;
const ROW_PAD = 3;

/**
 * ออกไฟล์ PDF หน้าตาตามรายงานแยกประเภททั่วไปต้นฉบับ (แนวนอน A4)
 * @param {object} job
 * @returns {Promise<Buffer>}
 */
function exportPdf(job) {
  const report = buildReport(job);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 28, bottom: 34, left: 24, right: 24 },
      info: {
        Title: report.header.title,
        Author: report.header.company,
        Creator: 'ระบบจับคู่เงินทดรองจ่าย',
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

    const left = doc.page.margins.left;
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = report.columns.map((c) => ({ ...c, w: Math.round(WIDTH_RATIO[c.key] * usable) }));
    // ปัดเศษให้ความกว้างรวมพอดีกับหน้ากระดาษ
    cols[cols.length - 1].w = usable - cols.slice(0, -1).reduce((s, c) => s + c.w, 0);

    let pageNo = 0;

    const drawHeader = () => {
      pageNo += 1;
      doc.font('bold').fontSize(11).text(thaiText(report.header.company), left, doc.page.margins.top, {
        width: usable,
        continued: false,
      });
      doc.font('regular').fontSize(8).text(`หน้า : ${pageNo}`, left, doc.page.margins.top + 1, {
        width: usable,
        align: 'right',
      });
      doc.font('bold').fontSize(10).text(thaiText(report.header.title), left, doc.y + 1, {
        width: usable,
        align: 'center',
      });
      doc.font('regular').fontSize(8);
      if (report.header.periodLine) doc.text(collapse(report.header.periodLine), left, doc.y + 2, { width: usable });
      if (report.header.accountLine) doc.text(collapse(report.header.accountLine), left, doc.y, { width: usable });
      doc.fillColor('#555').text(
        thaiText(`${report.header.printedAt}    แหล่งข้อมูล : ${report.header.sourceName}`),
        left,
        doc.y,
        { width: usable },
      );
      doc.fillColor('#000');
      drawRule(doc, left, doc.y + 3, usable);
      drawRow(doc, cols, left, doc.y + 3, headerCells(cols), { bold: true });
      drawRule(doc, left, doc.y + 1, usable);
      doc.y += 2;
    };

    const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 14;

    const ensureSpace = (height) => {
      if (doc.y + height > bottomLimit()) {
        doc.addPage();
        drawHeader();
      }
    };

    drawHeader();

    // ---- ยอดยกมา ----
    drawRow(
      doc,
      cols,
      left,
      doc.y,
      {
        dateDisplay: report.opening.accountCode,
        voucher: report.opening.accountName,
        description: 'ยอดยกมา',
        balance: formatAmount(report.opening.balance),
      },
      { bold: true },
    );

    // ---- รายการ ----
    for (const item of report.body) {
      const cells = {
        dateDisplay: item.dateDisplay,
        book: item.book,
        voucher: item.voucher,
        description: item.description,
        debit: formatAmount(item.debit),
        credit: formatAmount(item.credit),
        status: item.status,
        balance: formatAmount(item.balance),
      };
      const h = rowHeight(doc, cols, cells);
      ensureSpace(h);
      drawRow(doc, cols, left, doc.y, cells, { shade: item.partial ? '#FFF6E0' : null, height: h });
    }

    // ---- แถวรวม ----
    ensureSpace(30);
    drawRule(doc, left, doc.y + 1, usable);
    drawRow(
      doc,
      cols,
      left,
      doc.y + 2,
      {
        description: `รวม ${report.totals.rowCount} รายการที่ยังไม่มีคู่`,
        debit: formatAmount(report.totals.debit),
        credit: formatAmount(report.totals.credit),
        balance: formatAmount(report.totals.closingBalance),
      },
      { bold: true },
    );
    drawRule(doc, left, doc.y + 1, usable);
    drawRule(doc, left, doc.y + 2, usable);

    // ---- สรุป ----
    const summary = [
      ['รายการทั้งหมดในรายงาน', String(report.totals.entryCount)],
      ['จับคู่ได้', `${report.totals.matchedPairs} คู่`],
      [
        `เดบิตที่ยังไม่มีคู่ (${report.totals.unmatchedDebitCount} รายการ)`,
        formatAmount(report.totals.unmatchedDebitTotal) || '0.00',
      ],
      [
        `เครดิตที่ไม่มีคู่ (${report.totals.unmatchedCreditCount} รายการ)`,
        formatAmount(report.totals.unmatchedCreditTotal) || '0.00',
      ],
      ['ยอดยกมา', formatAmount(report.opening.balance) || '0.00'],
      ['ยอดคงเหลือที่คำนวณใหม่', formatAmount(report.totals.closingBalance) || '0.00'],
    ];
    if (report.totals.reportedClosing !== null && report.totals.reportedClosing !== undefined) {
      summary.push(['ยอดคงเหลือตามรายงานต้นฉบับ', formatAmount(report.totals.reportedClosing) || '0.00']);
    }

    ensureSpace(summary.length * 12 + 20);
    doc.y += 8;
    doc.font('bold').fontSize(9).text('สรุปผลการจับคู่', left, doc.y);
    doc.font('regular').fontSize(8);
    for (const [label, value] of summary) {
      doc.text(thaiText(label), left + 6, doc.y + 2, { width: 260, continued: false });
      doc.text(value, left + 270, doc.y - doc.currentLineHeight(), { width: 110, align: 'right' });
    }

    for (const w of report.warnings) {
      ensureSpace(26);
      doc.fillColor('#9A6700').fontSize(7.5).text(thaiText(`หมายเหตุ: ${w}`), left, doc.y + 6, { width: usable });
      doc.fillColor('#000');
    }

    doc.end();
  });
}

function registerFonts(doc) {
  if (!fs.existsSync(config.fonts.regular)) {
    throw new Error(`ไม่พบไฟล์ฟอนต์ ${config.fonts.regular}`);
  }
  doc.registerFont('regular', config.fonts.regular);
  doc.registerFont('bold', fs.existsSync(config.fonts.bold) ? config.fonts.bold : config.fonts.regular);
  doc.font('regular');
}

function collapse(text) {
  return thaiText(String(text).replace(/\s{2,}/g, '   ').trim());
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

function headerCells(cols) {
  return Object.fromEntries(cols.map((c) => [c.key, c.label]));
}

function rowHeight(doc, cols, cells) {
  doc.font('regular').fontSize(FONT_SIZE);
  let max = doc.currentLineHeight();
  for (const c of cols) {
    const text = thaiText(cells[c.key]);
    if (!text) continue;
    const h = doc.heightOfString(text, { width: c.w - 6 });
    if (h > max) max = h;
  }
  return max + ROW_PAD;
}

function drawRow(doc, cols, left, y, cells, opts = {}) {
  const font = opts.bold ? 'bold' : 'regular';
  const size = opts.bold ? HEAD_SIZE : FONT_SIZE;
  doc.font(font).fontSize(size);
  const h = opts.height || rowHeight(doc, cols, cells);

  if (opts.shade) {
    const total = cols.reduce((s, c) => s + c.w, 0);
    doc.save().rect(left, y - 1, total, h).fill(opts.shade).restore();
    doc.font(font).fontSize(size).fillColor('#000');
  }

  let x = left;
  for (const c of cols) {
    const text = thaiText(cells[c.key]);
    if (text) {
      doc.text(text, x + 3, y, {
        width: c.w - 6,
        align: c.align === 'center' ? 'center' : c.align,
        lineBreak: c.key === 'description',
        ellipsis: c.key !== 'description',
        height: c.key === 'description' ? undefined : h,
      });
    }
    x += c.w;
  }
  doc.y = y + h;
  doc.x = left;
}

function drawRule(doc, left, y, width) {
  doc.save().lineWidth(0.5).strokeColor('#444').moveTo(left, y).lineTo(left + width, y).stroke().restore();
  doc.y = y + 1;
}

module.exports = { exportPdf };
