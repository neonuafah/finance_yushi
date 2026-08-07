'use strict';

const { round2, formatAmount } = require('../domain');
const { withRunningBalance } = require('../matcher');

/**
 * ประกอบ "แบบจำลองรายงาน" ที่ตัวออกไฟล์ Excel และ PDF ใช้ร่วมกัน
 * รูปแบบยึดตามรายงานแยกประเภททั่วไปต้นฉบับ แต่แสดงเฉพาะรายการที่ยังไม่มีคู่
 * และคำนวณยอดคงเหลือใหม่ตามลำดับเดิม
 */

const COLUMNS = [
  { key: 'dateDisplay', label: 'วันที่', width: 11, align: 'left' },
  { key: 'book', label: 'สมุด', width: 8, align: 'left' },
  { key: 'voucher', label: 'ใบสำคัญ', width: 13, align: 'left' },
  { key: 'description', label: 'คำอธิบาย', width: 52, align: 'left' },
  { key: 'debit', label: 'เดบิต', width: 15, align: 'right', money: true },
  { key: 'credit', label: 'เครดิต', width: 15, align: 'right', money: true },
  { key: 'status', label: 'สถานะ', width: 8, align: 'center' },
  { key: 'balance', label: 'ยอดคงเหลือ', width: 16, align: 'right', money: true },
];

function thaiToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear() + 543).slice(-2)}`;
}

/**
 * @param {object} job ผลลัพธ์ที่เก็บไว้ (meta, totals, outstanding, options, warnings)
 * @returns {object} แบบจำลองรายงานพร้อมส่งให้ตัวออกไฟล์
 */
function buildReport(job) {
  const { meta } = job;
  const { rows, closingBalance } = withRunningBalance(meta.openingBalance, job.outstanding);

  const body = rows.map((r) => ({
    lineNo: r.lineNo,
    dateDisplay: r.dateDisplay,
    book: r.book,
    voucher: r.voucher,
    description: r.description,
    debit: r.outDebit,
    credit: r.outCredit,
    status: r.matchState === 'จับคู่บางส่วน' ? 'บางส่วน' : '',
    balance: r.runningBalance,
    side: r.side,
    originalAmount: r.originalAmount,
    matchedAmount: r.matchedAmount,
    partial: r.matchState === 'จับคู่บางส่วน',
  }));

  const totalDebit = round2(body.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(body.reduce((s, r) => s + r.credit, 0));

  return {
    columns: COLUMNS,
    header: {
      company: meta.company || '',
      title: `${meta.reportTitle || 'รายงานแยกประเภททั่วไป'} — รายการเงินทดรองจ่ายที่ยังไม่มีคู่`,
      periodLine: meta.periodLine || '',
      accountLine: meta.accountLine || '',
      printedAt: `วันที่พิมพ์ : ${thaiToday()}`,
      sourceName: job.originalName || '',
    },
    opening: {
      accountCode: meta.accountCode || '',
      accountName: meta.accountName || '',
      balance: round2(meta.openingBalance || 0),
    },
    body,
    totals: {
      debit: totalDebit,
      credit: totalCredit,
      closingBalance: round2(closingBalance),
      rowCount: body.length,
      unmatchedDebitCount: job.totals.unmatchedDebitCount,
      unmatchedDebitTotal: job.totals.unmatchedDebitTotal,
      unmatchedCreditCount: job.totals.unmatchedCreditCount,
      unmatchedCreditTotal: job.totals.unmatchedCreditTotal,
      matchedPairs: job.totals.matchedPairs,
      entryCount: job.totals.entryCount,
      reportedClosing: meta.reportedClosingBalance,
    },
    warnings: job.warnings || [],
  };
}

module.exports = { buildReport, COLUMNS, formatAmount, thaiToday };
