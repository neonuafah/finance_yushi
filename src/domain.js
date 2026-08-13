'use strict';

/**
 * โมเดลกลางของ "แถวรายการ" ในรายงานแยกประเภททั่วไป และฟังก์ชันช่วยแปลงค่า
 * ใช้ร่วมกันทั้งฝั่งอ่าน Excel / อ่าน PDF / จับคู่ / ออกรายงาน
 */

/**
 * คำนำหน้าเลขเอกสารที่ถือเป็น "เลขใบสำคัญ" (ใช้เทียบกับช่องใบสำคัญของฝั่งเดบิต)
 * RR = ใบรับของของสมุดซื้อ — เป็นเลขใบสำคัญของรายการเดบิตในบัญชีงานระหว่างทำ
 */
const VOUCHER_PREFIXES = ['PV', 'JV', 'AE', 'PS', 'RV', 'CN', 'DN', 'CV', 'GL', 'RR'];

/** คำนำหน้าเลขเอกสารที่ถือเป็น "เลขงาน" (ใช้จับคู่สำรองเมื่อไม่ได้อ้างเลขใบสำคัญ) */
const JOB_PREFIXES = ['SO', 'PO', 'IV', 'MEMO', 'ME', 'QT', 'DO', 'WO'];

/**
 * เลขเอกสารในรายงานเขียนติดกับข้อความไทยได้ เช่น "เคลียPV6901009" หรือ "PV6903046ชำระหนี้"
 * ตัวอักษรไทยไม่นับเป็น \w ใน JS regex (non-unicode mode) จึงเกิด word boundary ให้เองอยู่แล้ว
 */
const REF_RE = /\b([A-Z]{2,4})[\s.\-/]?(\d{6,8})\b/g;

const EPSILON = 0.005;

/** ปัดเป็นทศนิยม 2 ตำแหน่งแบบเลี่ยงปัญหา floating point */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function nearlyEqual(a, b) {
  return Math.abs(round2(a) - round2(b)) < EPSILON;
}

function isPositive(n) {
  return Number(n) > EPSILON;
}

/**
 * แปลงข้อความจำนวนเงินในรายงานเป็นตัวเลข
 * รองรับ "133,567.20", "(987.20)" (วงเล็บ = ติดลบ), "-1,000", "" และตัวเลขที่เป็น number อยู่แล้ว
 */
function parseAmount(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? round2(value) : 0;

  let s = String(value).trim();
  if (!s) return 0;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[,\s ]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return 0;

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return round2(negative ? -n : n);
}

function formatAmount(n) {
  const v = round2(n);
  if (v === 0) return '';
  const abs = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return v < 0 ? `(${abs})` : abs;
}

/** ปีในรายงานเป็น พ.ศ. — เก็บทั้งรูป ISO (ค.ศ.) สำหรับ MySQL และรูปที่แสดงผลเป็น พ.ศ. */
function beYearToIso(beYear) {
  return beYear > 2400 ? beYear - 543 : beYear;
}

/**
 * แปลงค่าวันที่จากได้หลายรูปแบบ:
 *  - Date object (จาก Excel)
 *  - "2569-01-06 00:00:00"
 *  - "06/01/69" (dd/mm/yy พ.ศ. — รูปแบบในไฟล์ PDF)
 * คืน { iso, display } หรือ null ถ้าแปลงไม่ได้
 */
function parseReportDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // ExcelJS คืนค่าเป็น Date ที่ปีเป็น พ.ศ. ตามที่เก็บในไฟล์
    return buildDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  const s = String(value).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return buildDate(Number(m[1]), Number(m[2]), Number(m[3]));

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2500; // "69" -> 2569
    return buildDate(year, Number(m[2]), Number(m[1]));
  }

  return null;
}

function buildDate(year, month, day) {
  if (!month || !day) return null;
  const isoYear = beYearToIso(year);
  const beYear = isoYear + 543;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    iso: `${isoYear}-${pad(month)}-${pad(day)}`,
    display: `${pad(day)}/${pad(month)}/${String(beYear).slice(-2)}`,
    sortKey: isoYear * 10000 + month * 100 + day,
  };
}

/**
 * ดึงเลขเอกสารทั้งหมดออกจากข้อความ แยกเป็นเลขใบสำคัญและเลขงาน
 * @returns {{ voucherRefs: string[], jobRefs: string[], allRefs: string[] }}
 */
function extractRefs(text) {
  const voucherRefs = [];
  const jobRefs = [];
  const allRefs = [];
  if (!text) return { voucherRefs, jobRefs, allRefs };

  const upper = String(text).toUpperCase();
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(upper)) !== null) {
    const code = `${m[1]}${m[2]}`;
    if (!allRefs.includes(code)) allRefs.push(code);
    if (VOUCHER_PREFIXES.includes(m[1])) {
      if (!voucherRefs.includes(code)) voucherRefs.push(code);
    } else if (JOB_PREFIXES.includes(m[1])) {
      if (!jobRefs.includes(code)) jobRefs.push(code);
    }
  }
  return { voucherRefs, jobRefs, allRefs };
}

function normalizeVoucher(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * สร้างแถวมาตรฐานจากค่าดิบของแต่ละคอลัมน์
 * @param {object} raw
 * @param {number} lineNo ลำดับแถวในรายงาน (1-based) — ใช้อ้างอิงข้ามระบบ
 */
function buildEntry(raw, lineNo) {
  const debit = parseAmount(raw.debit);
  const credit = parseAmount(raw.credit);
  const description = String(raw.description || '').trim();
  const voucher = normalizeVoucher(raw.voucher);
  const date = parseReportDate(raw.date);
  const refs = extractRefs(`${voucher} ${description}`);

  return {
    lineNo,
    date: date ? date.iso : null,
    dateDisplay: date ? date.display : '',
    dateSort: date ? date.sortKey : 0,
    book: String(raw.book || '').trim(),
    voucher,
    description,
    debit,
    credit,
    status: String(raw.status || '').trim(),
    reportedBalance: raw.balance === '' || raw.balance === undefined ? null : parseAmount(raw.balance),
    side: isPositive(debit) ? 'debit' : isPositive(credit) ? 'credit' : 'other',
    voucherRefs: refs.voucherRefs,
    jobRefs: refs.jobRefs,
    allRefs: refs.allRefs,
  };
}

/** แถวเปิดบัญชี เช่น "116-5100 | เงินทดลองจ่าย | ... | 221,520.00" */
const ACCOUNT_ROW_RE = /^\d{3}-\d{3,5}$/;

function isAccountRow(firstCell) {
  return ACCOUNT_ROW_RE.test(String(firstCell || '').trim());
}

/** เลขใบสำคัญที่ถูกต้อง เช่น PV6901009, JV6903029 */
const DOC_CODE_RE = /^[A-Z]{2,4}\d{6,8}$/;

function isDocumentCode(voucher) {
  return DOC_CODE_RE.test(normalizeVoucher(voucher));
}

/**
 * แถวสรุปท้ายรายงาน (เช่น "รวม 486 รายการ  7,540,068.06  6,738,066.74")
 * ระบุจาก: ไม่มีเลขใบสำคัญที่ถูกต้อง หรือมีทั้งเดบิตและเครดิตพร้อมกันในแถวเดียว
 */
function isFooterRow({ voucher, debit, credit }) {
  if (isPositive(debit) && isPositive(credit)) return true;
  return !isDocumentCode(voucher);
}

module.exports = {
  VOUCHER_PREFIXES,
  JOB_PREFIXES,
  EPSILON,
  round2,
  nearlyEqual,
  isPositive,
  parseAmount,
  formatAmount,
  parseReportDate,
  extractRefs,
  normalizeVoucher,
  buildEntry,
  isAccountRow,
  isDocumentCode,
  isFooterRow,
};
