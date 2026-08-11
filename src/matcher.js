'use strict';

const { round2, nearlyEqual, isPositive, EPSILON } = require('./domain');

/**
 * จับคู่รายการเงินทดลองจ่าย
 *
 * รูปแบบข้อมูล: รายการหลักลงยอดที่ช่อง "เดบิต" พร้อมเลขใบสำคัญ (เช่น PV6901011)
 * เมื่อเคลียร์แล้วจะมีอีกรายการที่ช่อง "เครดิต" ด้วยยอดเท่ากัน โดยคำอธิบายอ้างถึงเลขใบสำคัญนั้น
 * (เช่น "เคลีย PV6901011 ...") บางรายการอ้างเฉพาะเลขงาน SO/PO แทน
 *
 * อัลกอริทึมทำงานแบบ "ตัดยอด" (allocation) รายการหนึ่งจึงถูกเคลียร์บางส่วนหรือหลายครั้งได้
 */

/** ลำดับกลยุทธ์การจับคู่ — เข้มงวดที่สุดก่อน */
const STRATEGIES = [
  {
    key: 'voucherExact',
    label: 'อ้างเลขใบสำคัญ + ยอดตรงกันพอดี',
    confidence: 100,
    defaultOn: true,
  },
  {
    key: 'voucherPartial',
    label: 'อ้างเลขใบสำคัญ (เคลียร์บางส่วน / ยอดไม่ตรงพอดี)',
    confidence: 80,
    defaultOn: true,
  },
  {
    key: 'jobExact',
    label: 'อ้างเลขงาน SO/PO เดียวกัน + ยอดตรงกันพอดี',
    confidence: 70,
    defaultOn: true,
  },
  {
    key: 'jobPartial',
    label: 'อ้างเลขงาน SO/PO เดียวกัน (ยอดไม่ตรงพอดี)',
    confidence: 45,
    defaultOn: false,
  },
  {
    key: 'amountUnique',
    label: 'ยอดเงินตรงกันพอดีและมีผู้เข้าคู่เพียงรายเดียว',
    confidence: 30,
    defaultOn: false,
  },
];

const DEFAULT_OPTIONS = Object.fromEntries(STRATEGIES.map((s) => [s.key, s.defaultOn]));

function defaultOptions() {
  return { ...DEFAULT_OPTIONS };
}

/**
 * @param {object[]} entries แถวจาก parser
 * @param {object} [options] เปิด/ปิดกลยุทธ์แต่ละแบบ
 */
function matchEntries(entries, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const state = new Map();
  for (const e of entries) {
    state.set(e.lineNo, {
      entry: e,
      remaining: e.side === 'debit' ? e.debit : e.side === 'credit' ? e.credit : 0,
      matchedAmount: 0,
      partners: [],
    });
  }

  const debits = entries.filter((e) => e.side === 'debit');
  const credits = entries.filter((e) => e.side === 'credit');

  // ดัชนีเลขใบสำคัญ -> รายการเดบิต (รายการเดียวอาจแยกลงหลายบรรทัด)
  const byVoucher = new Map();
  for (const d of debits) {
    if (!d.voucher) continue;
    if (!byVoucher.has(d.voucher)) byVoucher.set(d.voucher, []);
    byVoucher.get(d.voucher).push(d);
  }
  const byJob = new Map();
  for (const d of debits) {
    for (const job of d.jobRefs) {
      if (!byJob.has(job)) byJob.set(job, []);
      byJob.get(job).push(d);
    }
  }

  const matches = [];

  const allocate = (debit, credit, strategy) => {
    const ds = state.get(debit.lineNo);
    const cs = state.get(credit.lineNo);
    const amount = round2(Math.min(ds.remaining, cs.remaining));
    if (amount <= EPSILON) return false;

    ds.remaining = round2(ds.remaining - amount);
    cs.remaining = round2(cs.remaining - amount);
    ds.matchedAmount = round2(ds.matchedAmount + amount);
    cs.matchedAmount = round2(cs.matchedAmount + amount);
    ds.partners.push(credit.lineNo);
    cs.partners.push(debit.lineNo);

    matches.push({
      debitLine: debit.lineNo,
      creditLine: credit.lineNo,
      amount,
      strategy: strategy.key,
      confidence: strategy.confidence,
    });
    return true;
  };

  const open = (d) => state.get(d.lineNo).remaining > EPSILON;
  /** รายการเคลียร์ต้องเกิดหลังหรือวันเดียวกับรายการจ่ายเงิน */
  const inOrder = (d, c) => !d.dateSort || !c.dateSort || d.dateSort <= c.dateSort;

  /** ผู้เข้าคู่ฝั่งเดบิตที่ยังมียอดเหลือ เรียงตามความใกล้เคียงของยอดแล้วตามวันที่ */
  const rank = (candidates, credit) => {
    const cs = state.get(credit.lineNo);
    return candidates
      .filter((d) => d.lineNo !== credit.lineNo && open(d))
      .sort((a, b) => {
        const da = Math.abs(state.get(a.lineNo).remaining - cs.remaining);
        const db = Math.abs(state.get(b.lineNo).remaining - cs.remaining);
        if (Math.abs(da - db) > EPSILON) return da - db;
        const oa = inOrder(a, credit) ? 0 : 1;
        const ob = inOrder(b, credit) ? 0 : 1;
        if (oa !== ob) return oa - ob;
        return a.lineNo - b.lineNo;
      });
  };

  const runPass = (strategy, pick) => {
    if (!opts[strategy.key]) return;
    for (const c of credits) {
      const cs = state.get(c.lineNo);
      while (cs.remaining > EPSILON) {
        const d = pick(c, cs);
        if (!d) break;
        if (!allocate(d, c, strategy)) break;
      }
    }
  };

  const byKey = Object.fromEntries(STRATEGIES.map((s) => [s.key, s]));

  /**
   * เดินสองรอบเสมอ: รอบแรกรับเฉพาะคู่ที่ลำดับวันที่ถูกต้อง รอบสองจึงยอมให้ย้อนวันได้
   * กันกรณีพิมพ์เลขใบสำคัญผิดไปคว้ารายการที่ยังไม่เกิดขึ้น ณ วันที่เคลียร์
   */
  const runChronological = (strategy, pick) => {
    runPass(strategy, (c, cs) => pick(c, cs, true));
    runPass(strategy, (c, cs) => pick(c, cs, false));
  };

  const refsOf = (c) => c.voucherRefs.filter((ref) => ref !== c.voucher);

  // 1) อ้างเลขใบสำคัญตรงกันและยอดตรงกันพอดี
  runChronological(byKey.voucherExact, (c, cs, ordered) => {
    for (const ref of refsOf(c)) {
      const hit = (byVoucher.get(ref) || []).find(
        (d) =>
          d.lineNo !== c.lineNo &&
          open(d) &&
          nearlyEqual(state.get(d.lineNo).remaining, cs.remaining) &&
          (!ordered || inOrder(d, c)),
      );
      if (hit) return hit;
    }
    return null;
  });

  // 2) อ้างเลขใบสำคัญตรงกัน แต่ยอดไม่ตรงพอดี (เคลียร์บางส่วน / รวมหลายรายการ)
  runChronological(byKey.voucherPartial, (c, cs, ordered) => {
    for (const ref of refsOf(c)) {
      const cands = rank(byVoucher.get(ref) || [], c).filter((d) => !ordered || inOrder(d, c));
      if (cands.length) return cands[0];
    }
    return null;
  });

  // 3) อ้างเลขงาน SO/PO เดียวกัน และยอดตรงกันพอดี
  runChronological(byKey.jobExact, (c, cs, ordered) => {
    for (const job of c.jobRefs) {
      const hit = (byJob.get(job) || []).find(
        (d) =>
          d.lineNo !== c.lineNo &&
          open(d) &&
          nearlyEqual(state.get(d.lineNo).remaining, cs.remaining) &&
          (!ordered || inOrder(d, c)),
      );
      if (hit) return hit;
    }
    return null;
  });

  // 4) อ้างเลขงาน SO/PO เดียวกัน แต่ยอดไม่ตรงพอดี
  runChronological(byKey.jobPartial, (c, cs, ordered) => {
    for (const job of c.jobRefs) {
      const cands = rank(byJob.get(job) || [], c).filter((d) => !ordered || inOrder(d, c));
      if (cands.length) return cands[0];
    }
    return null;
  });

  // 5) ยอดตรงกันพอดี และเหลือผู้เข้าคู่เพียงรายเดียวเท่านั้น
  runChronological(byKey.amountUnique, (c, cs, ordered) => {
    const hit = debits.filter(
      (d) =>
        d.lineNo !== c.lineNo &&
        open(d) &&
        nearlyEqual(state.get(d.lineNo).remaining, cs.remaining) &&
        (!ordered || inOrder(d, c)),
    );
    return hit.length === 1 ? hit[0] : null;
  });

  return summarize(entries, state, matches, opts);
}

/** สรุปผล: รายการที่ยังไม่มีคู่ พร้อมยอดคงเหลือที่คำนวณใหม่ */
function summarize(entries, state, matches, opts) {
  const rows = entries.map((e) => {
    const s = state.get(e.lineNo);
    const original = e.side === 'debit' ? e.debit : e.side === 'credit' ? e.credit : 0;
    return {
      ...e,
      remaining: round2(s.remaining),
      matchedAmount: round2(s.matchedAmount),
      partners: s.partners,
      matchState:
        e.side === 'other'
          ? 'ไม่มียอด'
          : s.remaining <= EPSILON
            ? 'จับคู่แล้ว'
            : s.matchedAmount > EPSILON
              ? 'จับคู่บางส่วน'
              : 'ไม่มีคู่',
      originalAmount: original,
    };
  });

  const byLine = new Map(rows.map((r) => [r.lineNo, r]));

  const unmatchedDebits = rows.filter((r) => r.side === 'debit' && r.remaining > EPSILON);
  const unmatchedCredits = rows.filter((r) => r.side === 'credit' && r.remaining > EPSILON);
  const zeroRows = rows.filter((r) => r.side === 'other');

  // ยอดคงเหลือใหม่: ไล่จากยอดยกมา บวกเดบิตที่ยังไม่ถูกเคลียร์ ลบเครดิตที่ยังไม่มีคู่
  const outstanding = [...unmatchedDebits, ...unmatchedCredits].sort((a, b) => a.lineNo - b.lineNo);

  const pairs = matches.map((m) => ({
    ...m,
    debit: pickSummary(byLine.get(m.debitLine)),
    credit: pickSummary(byLine.get(m.creditLine)),
  }));

  const totals = {
    entryCount: rows.length,
    debitCount: rows.filter((r) => r.side === 'debit').length,
    creditCount: rows.filter((r) => r.side === 'credit').length,
    totalDebit: sum(rows, (r) => r.debit),
    totalCredit: sum(rows, (r) => r.credit),
    matchedPairs: matches.length,
    matchedAmount: sum(matches, (m) => m.amount),
    unmatchedDebitCount: unmatchedDebits.length,
    unmatchedDebitTotal: sum(unmatchedDebits, (r) => r.remaining),
    unmatchedCreditCount: unmatchedCredits.length,
    unmatchedCreditTotal: sum(unmatchedCredits, (r) => r.remaining),
    zeroRowCount: zeroRows.length,
    byStrategy: Object.fromEntries(
      STRATEGIES.map((s) => [s.key, matches.filter((m) => m.strategy === s.key).length]),
    ),
  };

  return { rows, outstanding, unmatchedDebits, unmatchedCredits, zeroRows, pairs, totals, options: opts };
}

function pickSummary(r) {
  if (!r) return null;
  return {
    lineNo: r.lineNo,
    dateDisplay: r.dateDisplay,
    book: r.book,
    voucher: r.voucher,
    description: r.description,
    debit: r.debit,
    credit: r.credit,
  };
}

function sum(list, fn) {
  return round2(list.reduce((s, x) => s + (fn(x) || 0), 0));
}

/**
 * คำนวณยอดคงเหลือใหม่แบบไล่บรรทัด สำหรับรายการที่ยังไม่มีคู่
 * @param {number} openingBalance ยอดยกมา
 * @param {object[]} outstanding รายการที่ยังไม่มีคู่ เรียงตามลำดับในรายงาน
 */
function withRunningBalance(openingBalance, outstanding) {
  let balance = round2(openingBalance);
  const rows = outstanding.map((r) => {
    const debit = r.side === 'debit' ? r.remaining : 0;
    const credit = r.side === 'credit' ? r.remaining : 0;
    balance = round2(balance + debit - credit);
    return { ...r, outDebit: debit, outCredit: credit, runningBalance: balance };
  });
  return { rows, closingBalance: balance };
}

module.exports = {
  STRATEGIES,
  defaultOptions,
  matchEntries,
  withRunningBalance,
  isPositive,
};
