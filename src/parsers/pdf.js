'use strict';

const { buildEntry, parseAmount, isAccountRow, isFooterRow } = require('../domain');
const { fillDownDates } = require('./excel');

/**
 * รายงานจากโปรแกรมบัญชีถูกพิมพ์เป็น "ตารางตัวอักษรความกว้างคงที่" (monospace — ทุก glyph กว้าง 600 หน่วยเท่ากัน)
 * จึงประกอบบรรทัดกลับมาเป็นกริดตามตำแหน่ง x ได้ตรงเป๊ะ แล้วตัดคอลัมน์จากตำแหน่งช่อง (cell)
 *
 * ข้อควรระวัง: สระบน/ล่างและวรรณยุกต์ไทย (เช่น ่ ี ั) ไม่กินเนื้อที่ในกริด
 * ทำให้ string.length ไม่เท่ากับจำนวนช่อง — โค้ดนี้จึงเก็บบรรทัดเป็น "อาร์เรย์ของช่อง"
 * โดยแต่ละช่องเก็บอักขระฐานพร้อมเครื่องหมายประกอบที่ตามมา
 */

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * โปรแกรมออกรายงานฝังฟอนต์ไทยที่วางสระ/วรรณยุกต์ไว้ใน Private Use Area (U+F700–U+F71A)
 * แทนที่จะใช้รหัส Unicode มาตรฐาน จึงต้องแปลงกลับก่อนใช้งาน
 *
 * ตารางนี้สอบเทียบจากไฟล์ตัวอย่างจริง โดยเทียบข้อความ PDF กับ Excel แถวต่อแถว
 * (ค่าที่ยืนยันจากข้อมูล: F701 F704 F705 F706 F707 F70A F70B F70C F70E F712
 *  ส่วนที่เหลือเติมตามรูปแบบของกลุ่มที่ยืนยันแล้ว)
 */
const THAI_PUA = {
  0xf700: 'ั', 0xf701: 'ิ', 0xf702: 'ี', 0xf703: 'ึ', 0xf704: 'ื',
  0xf705: '่', 0xf706: '้', 0xf707: '๊', 0xf708: '๋', 0xf709: '์',
  0xf70a: '่', 0xf70b: '้', 0xf70c: '๊', 0xf70d: '๋', 0xf70e: '์',
  0xf70f: 'ญ',
  0xf712: '็',
};
const PUA_RANGE = /[-]/g;

/** แปลงอักขระ PUA กลับเป็นภาษาไทยมาตรฐาน; ตัวที่ไม่รู้จักถูกตัดทิ้ง (เป็นอักขระไม่กินความกว้าง) */
function normalizePua(str, unknown) {
  if (!PUA_RANGE.test(str)) {
    PUA_RANGE.lastIndex = 0;
    return str;
  }
  PUA_RANGE.lastIndex = 0;
  return composeSaraAm(
    str.replace(PUA_RANGE, (ch) => {
      const mapped = THAI_PUA[ch.codePointAt(0)];
      if (mapped !== undefined) return mapped;
      if (unknown) unknown.add(ch.codePointAt(0));
      return '';
    }),
  );
}

/**
 * ฟอนต์ในไฟล์ PDF เขียนสระอำเป็นนิคหิต + สระอา (ํา) ประกอบกลับเป็น "ำ" ตัวเดียว
 * เพื่อให้ข้อความตรงกับที่อ่านได้จากไฟล์ Excel และแสดงผลถูกต้อง
 */
function composeSaraAm(str) {
  return str.includes('ํา') ? str.replace(/ํา/g, 'ำ') : str;
}

/** อักขระไทยที่ไม่กินความกว้าง: สระอิ-อือ, ไม้ไต่คู้, วรรณยุกต์, การันต์, พินทุ */
const COMBINING_RE = /[ัิ-ฺ็-๎]/;
const COMBINING_G = /[ัิ-ฺ็-๎]/g;

/** ตัดสระ/วรรณยุกต์ที่ไม่กินเนื้อที่ออก เพื่อให้ index ของสตริงตรงกับ index ของช่องในกริด */
function stripMarks(s) {
  return String(s).replace(COMBINING_G, '');
}

const NUMBER_RE = /\(?-?[\d,]*\d\.\d{2}\)?/g;
const VOUCHER_RE = /[A-Z]{2,4}\d{6,8}/;

/** ตัดสตริงหนึ่ง run ออกเป็นช่อง: อักขระประกอบถูกผนวกกับช่องก่อนหน้า */
function splitCells(str) {
  const cells = [];
  for (const ch of str) {
    if (COMBINING_RE.test(ch) && cells.length) cells[cells.length - 1] += ch;
    else cells.push(ch);
  }
  return cells;
}

/**
 * บรรทัดหนึ่งของรายงาน เก็บทั้งรูปกริด (1 อักขระ/ช่อง) และข้อความจริง
 */
class GridLine {
  constructor(y, page) {
    this.y = y;
    this.page = page;
    this.cells = [];
  }

  place(col, str) {
    const parts = splitCells(str);
    for (let i = 0; i < parts.length; i += 1) {
      const at = col + i;
      while (this.cells.length <= at) this.cells.push(' ');
      if (parts[i] === ' ') continue;
      // ช่องว่าง = ยังไม่มีใครจอง; ช่องที่มีค่าแล้วแปลว่าถูกวาดทับ
      // (โปรแกรมออกรายงานบางตัววาดวรรณยุกต์เป็น item แยกที่ตำแหน่ง x เดียวกับตัวฐาน)
      if (this.cells[at] === ' ') this.cells[at] = parts[i];
      else this.cells[at] += parts[i];
    }
  }

  /** สตริงที่มี 1 อักขระต่อ 1 ช่อง — index ของสตริงนี้เท่ากับ index ของช่อง */
  get grid() {
    if (this._grid === undefined) this._grid = this.cells.map((c) => c[0] || ' ').join('');
    return this._grid;
  }

  /** ข้อความเต็มพร้อมสระ/วรรณยุกต์ */
  get text() {
    if (this._text === undefined) this._text = this.cells.join('').replace(/\s+$/, '');
    return this._text;
  }

  /** ตัดข้อความตามช่วงช่อง (cell index) */
  slice(from, to) {
    if (from === undefined || from < 0) return '';
    return this.cells.slice(from, to === undefined || to < 0 ? undefined : to).join('').trim();
  }
}

/** จัด text items ของหนึ่งหน้าให้กลายเป็นบรรทัดในกริด */
function itemsToLines(items, page = 1, unknownPua = null) {
  const glyphs = items
    .filter((it) => it.str && it.str.trim() !== '')
    .map((it) => ({
      x: it.transform[4],
      y: it.transform[5],
      str: normalizePua(it.str, unknownPua),
      width: it.width,
    }))
    .filter((g) => g.str !== '');
  if (!glyphs.length) return { lines: [], charWidth: 0 };

  // ความกว้างต่อหนึ่งช่อง = ค่ามัธยฐานของ (ความกว้าง run / จำนวนช่องใน run)
  const widths = glyphs
    .map((g) => g.width / splitCells(g.str).length)
    .filter((w) => Number.isFinite(w) && w > 0)
    .sort((a, b) => a - b);
  const charWidth = widths[Math.floor(widths.length / 2)];
  if (!charWidth) return { lines: [], charWidth: 0 };

  const originX = Math.min(...glyphs.map((g) => g.x));

  const byRow = new Map();
  for (const g of glyphs) {
    const key = Math.round(g.y * 4) / 4; // รวม y ที่ต่างกันเพียงเศษทศนิยม
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(g);
  }

  // item ที่เป็นวรรณยุกต์ล้วนต้องวางหลังตัวฐานที่ตำแหน่ง x เดียวกันเสมอ
  const markOnly = (s) => stripMarks(s).trim() === '';

  const lines = [];
  for (const y of [...byRow.keys()].sort((a, b) => b - a)) {
    const line = new GridLine(y, page);
    const row = byRow.get(y).sort((a, b) => a.x - b.x || (markOnly(a.str) ? 1 : 0) - (markOnly(b.str) ? 1 : 0));
    for (const g of row) {
      line.place(Math.max(0, Math.round((g.x - originX) / charWidth)), g.str);
    }
    lines.push(line);
  }
  return { lines, charWidth };
}

/** ตำแหน่งป้ายหัวคอลัมน์ (ใช้เป็นข้อมูลตั้งต้น — ป้ายไม่ได้ชิดซ้ายตรงกับคอลัมน์เสมอไป) */
function headerLabelPositions(gridText) {
  const find = (...labels) => {
    for (const l of labels) {
      const i = gridText.indexOf(stripMarks(l));
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    date: find('วันที่'),
    book: find('สมุด'),
    voucher: find('ใบสำคัญ', 'ใบสําคัญ'),
    description: find('คำอธิบาย', 'คําอธิบาย'),
    debit: find('เดบิต', 'เดบิท'),
    credit: find('เครดิต', 'เครดิท'),
    status: find('สถานะ'),
    balance: find('ยอดคงเหลือ'),
  };
}

/**
 * สอบเทียบตำแหน่งคอลัมน์จากข้อมูลจริง (แม่นกว่าการอ่านจากป้ายหัวตาราง)
 * ตัวเลขจัดชิดขวา ตำแหน่งสิ้นสุดของแต่ละคอลัมน์จึงคงที่ทุกบรรทัด
 */
function calibrate(lines, labels) {
  const voucherStarts = new Map();
  const tokenEnds = new Map();

  for (const line of lines) {
    const g = line.grid;
    const v = g.match(VOUCHER_RE);
    if (!v || v.index > 60) continue;
    voucherStarts.set(v.index, (voucherStarts.get(v.index) || 0) + 1);
    NUMBER_RE.lastIndex = 0;
    let m;
    while ((m = NUMBER_RE.exec(g)) !== null) {
      const end = m.index + m[0].length;
      if (end < labels.debit) continue; // ตัวเลขที่อยู่ในคอลัมน์คำอธิบาย
      tokenEnds.set(end, (tokenEnds.get(end) || 0) + 1);
    }
  }
  if (!voucherStarts.size) return null;

  const voucherStart = [...voucherStarts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // รวมตำแหน่งสิ้นสุดที่ห่างกันไม่เกิน 2 ช่องเข้าเป็นคอลัมน์เดียวกัน
  const sorted = [...tokenEnds.entries()].sort((a, b) => a[0] - b[0]);
  const clusters = [];
  for (const [end, count] of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && end - last.end <= 2) {
      last.end = Math.max(last.end, end);
      last.count += count;
    } else {
      clusters.push({ end, count });
    }
  }
  const strong = clusters.filter((c) => c.count >= 2);
  const useClusters = strong.length ? strong : clusters;

  // จับแต่ละคลัสเตอร์เข้ากับป้ายหัวคอลัมน์ที่อยู่ก่อนหน้าและใกล้ที่สุด
  const anchors = [
    ['debit', labels.debit],
    ['credit', labels.credit],
    ['balance', labels.balance >= 0 ? labels.balance : labels.status],
  ].filter(([, i]) => i >= 0);

  const columns = { debit: null, credit: null, balance: null };
  for (const c of useClusters) {
    let best = null;
    for (const [name, at] of anchors) {
      if (at > c.end) continue;
      const d = c.end - at;
      if (!best || d < best.d) best = { name, d };
    }
    if (!best) best = { name: 'debit' };
    // คอลัมน์เดียวกันชนกัน — ให้คลัสเตอร์ที่อยู่ขวากว่าเลื่อนไปคอลัมน์ถัดไป
    if (columns[best.name] !== null) {
      const order = ['debit', 'credit', 'balance'];
      let i = order.indexOf(best.name);
      while (i < order.length && columns[order[i]] !== null) i += 1;
      if (i >= order.length) continue;
      best = { name: order[i] };
    }
    columns[best.name] = c.end;
  }

  if (columns.balance === null && columns.credit !== null) {
    columns.balance = columns.credit;
    columns.credit = columns.debit;
    columns.debit = null;
  }
  if (columns.balance === null) return null;

  return { voucherStart, ...columns, labels };
}

/** จับตัวเลขในบรรทัดเข้ากับคอลัมน์ที่สอบเทียบไว้ (ยอมคลาดเคลื่อนได้ 2 ช่อง) */
function readAmounts(gridText, cal) {
  const out = { debit: 0, credit: 0, balance: null, firstTokenAt: -1 };
  NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = NUMBER_RE.exec(gridText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    let field = null;
    for (const name of ['debit', 'credit', 'balance']) {
      if (cal[name] !== null && Math.abs(end - cal[name]) <= 2) {
        field = name;
        break;
      }
    }
    if (!field) continue;
    if (out.firstTokenAt < 0) out.firstTokenAt = start;
    const value = parseAmount(m[0]);
    if (field === 'balance') out.balance = value;
    else out[field] = value;
  }
  return out;
}

/**
 * อ่านรายงานแยกประเภททั่วไปจากไฟล์ .pdf
 * @param {Buffer} buffer
 * @returns {Promise<{meta: object, entries: object[], warnings: string[]}>}
 */
async function parsePdf(buffer) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    isEvalSupported: false,
  });
  const doc = await task.promise;

  const warnings = [];
  const allLines = [];
  const unknownPua = new Set();
  const pageCount = doc.numPages;
  try {
    for (let p = 1; p <= pageCount; p += 1) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      allLines.push(...itemsToLines(tc.items, p, unknownPua).lines);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  if (unknownPua.size) {
    warnings.push(
      `พบอักขระไทยในฟอนต์ของ PDF ที่ยังไม่รู้จัก ${unknownPua.size} ตัว (${[...unknownPua]
        .map((c) => 'U+' + c.toString(16).toUpperCase())
        .join(', ')}) — สระหรือวรรณยุกต์บางตัวในคำอธิบายอาจหายไป`,
    );
  }

  const isHeaderLine = (l) =>
    l.grid.includes(stripMarks('เดบิ')) &&
    l.grid.includes(stripMarks('เครดิ')) &&
    l.grid.includes(stripMarks('ยอดคงเหลือ'));
  const headerIdx = allLines.findIndex(isHeaderLine);
  if (headerIdx < 0) throw new Error('ไม่พบหัวตารางของรายงานในไฟล์ PDF');

  const labels = headerLabelPositions(allLines[headerIdx].grid);
  const cal = calibrate(allLines, labels);
  if (!cal) throw new Error('ไม่สามารถระบุตำแหน่งคอลัมน์ตัวเลขในไฟล์ PDF ได้');

  const meta = {
    company: '',
    reportTitle: 'รายงานแยกประเภททั่วไป',
    periodLine: '',
    accountLine: '',
    accountCode: '',
    accountName: '',
    openingBalance: 0,
    reportedClosingBalance: null,
    headerLines: allLines
      .slice(0, headerIdx)
      .map((l) => l.text)
      .filter((t) => t.trim() && !/^\s*-{5,}/.test(t)),
    footerLines: [],
    pages: pageCount,
    columns: cal,
  };
  // "บริษัท ... <ช่องว่างยาว> หน้า : 1" — ตัดเลขหน้าออกจากชื่อบริษัท
  meta.company = (meta.headerLines[0] || '').split(/\s{3,}/)[0].trim();
  meta.reportTitle = (meta.headerLines[1] || meta.reportTitle).trim();
  meta.periodLine = (meta.headerLines[2] || '').trim();
  meta.accountLine = (meta.headerLines[3] || '').trim();

  const entries = [];
  let lineNo = 0;
  for (const line of allLines) {
    const g = line.grid;
    if (!g.trim()) continue;
    if (/^\s*-{5,}/.test(g)) continue;
    if (isHeaderLine(line)) continue;
    const gt = g.trim();
    if (
      gt.startsWith(stripMarks('บริษัท')) ||
      gt.startsWith(stripMarks('รายงาน')) ||
      gt.startsWith(stripMarks('วันที่จาก')) ||
      gt.startsWith(stripMarks('เลขที่บัญชี'))
    ) {
      continue;
    }

    const amounts = readAmounts(g, cal);

    // แถวเปิดบัญชี: ขึ้นต้นด้วยเลขบัญชี ยอดอยู่ช่องคงเหลือ
    const head = line.slice(0, cal.voucherStart);
    const firstToken = head.split(/\s+/)[0] || '';
    if (isAccountRow(firstToken)) {
      // แถวนี้พิมพ์ซ้ำหัวทุกหน้าเป็น "(ต่อ)" — เอายอดยกมาจากหน้าแรกเท่านั้น
      if (!meta.accountCode) {
        meta.accountCode = firstToken;
        meta.accountName = line
          .slice(cal.voucherStart, amounts.firstTokenAt < 0 ? undefined : amounts.firstTokenAt)
          .replace(/\s*\(\s*ต\s*่?\s*อ\s*\)\s*$/, '')
          .trim();
      }
      if (amounts.balance !== null && !entries.length) meta.openingBalance = amounts.balance;
      continue;
    }

    const vm = g.match(VOUCHER_RE);
    const voucher = vm && Math.abs(vm.index - cal.voucherStart) <= 2 ? vm[0] : '';
    const dateText = (head.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/) || [''])[0];
    const book = head.replace(dateText, '').trim();

    const descFrom = cal.voucherStart + (voucher ? voucher.length : 0);
    const descTo = amounts.firstTokenAt >= 0 ? amounts.firstTokenAt : Math.max(0, cal.debit - 1);
    const description = line.slice(descFrom, descTo);

    if (!voucher && !description && !amounts.debit && !amounts.credit) continue;
    if (isFooterRow({ voucher, debit: amounts.debit, credit: amounts.credit })) {
      if (/\d/.test(g)) meta.footerLines.push(line.text.trim());
      continue;
    }

    lineNo += 1;
    entries.push(
      buildEntry(
        {
          date: dateText,
          book,
          voucher,
          description,
          debit: amounts.debit,
          credit: amounts.credit,
          status: cal.credit !== null ? line.slice(cal.credit, cal.balance - 11) : '',
          balance: amounts.balance === null ? '' : amounts.balance,
        },
        lineNo,
      ),
    );
  }

  if (!entries.length) throw new Error('ไม่พบรายการในไฟล์ PDF');

  fillDownDates(entries, warnings);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].reportedBalance !== null) {
      meta.reportedClosingBalance = entries[i].reportedBalance;
      break;
    }
  }

  warnings.push(
    'อ่านจากไฟล์ PDF: คำอธิบายถูกตัดตามความกว้างคอลัมน์ของรายงานต้นฉบับ หากต้องการคำอธิบายเต็มแนะนำให้อัปโหลดไฟล์ Excel',
  );

  return { meta, entries, warnings };
}

module.exports = { parsePdf, itemsToLines, calibrate, headerLabelPositions, GridLine };
