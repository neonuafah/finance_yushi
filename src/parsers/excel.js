'use strict';

const ExcelJS = require('exceljs');
const { buildEntry, parseAmount, isAccountRow, isFooterRow } = require('../domain');

/** ป้ายหัวคอลัมน์ที่ใช้ระบุแถวหัวตาราง (ไฟล์จริงสะกด "เดบิต/เดบิท" ไม่ตรงกันได้) */
const HEADER_TOKENS = ['วันที่', 'สมุด', 'ใบสำคัญ', 'ใบสําคัญ', 'คำอธิบาย', 'คําอธิบาย'];

const COLUMN_ALIASES = {
  date: ['วันที่'],
  book: ['สมุด'],
  voucher: ['ใบสำคัญ', 'ใบสําคัญ'],
  description: ['คำอธิบาย', 'คําอธิบาย'],
  debit: ['เดบิต', 'เดบิท'],
  credit: ['เครดิต', 'เครดิท'],
  status: ['สถานะ'],
  balance: ['ยอดคงเหลือ', 'คงเหลือ'],
};

function cellText(cell) {
  if (cell === null || cell === undefined) return '';
  const v = cell.value ?? cell;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return v.result;
    return '';
  }
  return v;
}

function asString(v) {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? '').replace(/ /g, ' ').trim();
}

/** หาแถวหัวตารางและ map ชื่อคอลัมน์ -> index (1-based ตาม ExcelJS) */
function locateHeader(sheet) {
  const limit = Math.min(sheet.rowCount, 40);
  for (let r = 1; r <= limit; r += 1) {
    const row = sheet.getRow(r);
    const texts = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      texts[col] = asString(cellText(cell));
    });
    const joined = texts.join(' ');
    const hits = HEADER_TOKENS.filter((t) => joined.includes(t)).length;
    if (hits < 3) continue;

    const map = {};
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      for (let c = 1; c < texts.length; c += 1) {
        const t = (texts[c] || '').replace(/\s+/g, '');
        if (!t) continue;
        if (aliases.some((a) => t.includes(a.replace(/\s+/g, '')))) {
          map[key] = c;
          break;
        }
      }
    }
    // คอลัมน์ที่ขาดไม่ได้ต่อการจับคู่
    if (map.voucher && map.description && map.debit && map.credit) {
      return { headerRow: r, map };
    }
  }
  return null;
}

/**
 * อ่านรายงานแยกประเภททั่วไปจากไฟล์ .xlsx
 * @param {Buffer} buffer
 * @returns {Promise<{meta: object, entries: object[], warnings: string[]}>}
 */
async function parseExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const warnings = [];
  let located = null;
  let sheet = null;
  for (const ws of wb.worksheets) {
    const found = locateHeader(ws);
    if (found) {
      sheet = ws;
      located = found;
      break;
    }
  }
  if (!located) {
    throw new Error('ไม่พบหัวตารางของรายงาน (ต้องมีคอลัมน์ ใบสำคัญ / คำอธิบาย / เดบิต / เครดิต)');
  }

  const { headerRow, map } = located;
  const meta = {
    sheetName: sheet.name,
    company: '',
    reportTitle: '',
    periodLine: '',
    accountLine: '',
    accountCode: '',
    accountName: '',
    openingBalance: 0,
    reportedClosingBalance: null,
    footerLines: [],
  };

  // บรรทัดหัวรายงานเหนือแถวหัวตาราง
  const headerLines = [];
  for (let r = 1; r < headerRow; r += 1) {
    const parts = [];
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
      const t = asString(cellText(cell));
      if (t) parts.push(t);
    });
    if (parts.length) headerLines.push(parts.join(' '));
  }
  // "บริษัท ... <ช่องว่างยาว> หน้า : 1" — ตัดเลขหน้าออกจากชื่อบริษัท
  meta.company = headerLines[0] ? headerLines[0].split(/\s{3,}/)[0].trim() : '';
  meta.reportTitle = headerLines[1] || 'รายงานแยกประเภททั่วไป';
  meta.periodLine = headerLines[2] || '';
  meta.accountLine = headerLines[3] || '';
  meta.headerLines = headerLines;

  const entries = [];
  let lineNo = 0;
  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const get = (key) => (map[key] ? cellText(row.getCell(map[key])) : '');

    const first = asString(get('date'));
    const voucher = asString(get('voucher'));
    const description = asString(get('description'));
    const debitRaw = get('debit');
    const creditRaw = get('credit');
    const balanceRaw = get('balance');

    // แถวเปิดบัญชี: คอลัมน์แรกเป็นเลขบัญชี ยอดอยู่ช่องคงเหลือ
    if (isAccountRow(first)) {
      meta.accountCode = first;
      meta.accountName = description || voucher;
      meta.openingBalance = parseAmount(balanceRaw);
      continue;
    }

    const debit = parseAmount(debitRaw);
    const credit = parseAmount(creditRaw);
    if (!voucher && !description && debit === 0 && credit === 0) continue;

    // แถวสรุปท้ายรายงาน ("รวม 486 รายการ ...") ไม่ใช่รายการบัญชี
    if (isFooterRow({ voucher, debit, credit })) {
      meta.footerLines.push([first, voucher, description, debitRaw, creditRaw].map(asString).filter(Boolean).join(' '));
      continue;
    }

    lineNo += 1;
    entries.push(
      buildEntry(
        {
          date: get('date'),
          book: get('book'),
          voucher,
          description,
          debit: debitRaw,
          credit: creditRaw,
          status: get('status'),
          balance: balanceRaw,
        },
        lineNo,
      ),
    );
  }

  if (!entries.length) throw new Error('ไม่พบรายการในไฟล์ Excel');

  // วันที่ในรายงานเว้นว่างเมื่อซ้ำกับแถวก่อนหน้า — เติมลงมาให้ครบ
  fillDownDates(entries, warnings);

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].reportedBalance !== null) {
      meta.reportedClosingBalance = entries[i].reportedBalance;
      break;
    }
  }

  return { meta, entries, warnings };
}

/** เติมวันที่จากแถวก่อนหน้าเมื่อคอลัมน์วันที่ถูกเว้นว่าง (รูปแบบรายงานแบบจัดกลุ่มตามวัน) */
function fillDownDates(entries, warnings) {
  let last = null;
  let missing = 0;
  for (const e of entries) {
    if (e.date) {
      last = { date: e.date, dateDisplay: e.dateDisplay, dateSort: e.dateSort };
    } else if (last) {
      e.date = last.date;
      e.dateDisplay = last.dateDisplay;
      e.dateSort = last.dateSort;
      e.dateInherited = true;
    } else {
      missing += 1;
    }
  }
  if (missing) warnings.push(`มี ${missing} แถวที่ไม่สามารถระบุวันที่ได้`);
}

module.exports = { parseExcel, fillDownDates };
