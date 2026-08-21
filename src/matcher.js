'use strict';

const { round2, nearlyEqual, isPositive, EPSILON } = require('./domain');

/**
 * จับคู่รายการตั้งยอดกับรายการเคลียร์ในรายงานแยกประเภททั่วไป
 *
 * รูปแบบข้อมูลขึ้นกับประเภทบัญชี — ทิศทางกลับหัวกันได้:
 *  - บัญชีฝั่งสินทรัพย์ (เช่น 116-5100 เงินทดลองจ่าย)
 *    รายการตั้งยอดอยู่ช่อง "เดบิต" พร้อมเลขใบสำคัญ (เช่น PV6901011)
 *    รายการเคลียร์อยู่ช่อง "เครดิต" และคำอธิบายอ้างถึงเลขใบสำคัญนั้น ("เคลีย PV6901011 ...")
 *  - บัญชีฝั่งหนี้สิน (เช่น 217-3999 ค่าใช้จ่ายค้างจ่ายอื่นๆ)
 *    รายการตั้งยอดอยู่ช่อง "เครดิต" (JV ตั้งค้างจ่าย)
 *    รายการเคลียร์อยู่ช่อง "เดบิต" (PV จ่ายจริง) และคำอธิบายอ้างถึงเลข JV นั้น
 *
 * จึงไม่ยึดว่าฝั่งไหนเป็นรายการตั้งยอด แต่ดูจาก "ฝั่งที่ถูกอ้างถึง" เป็นหลัก
 * (anchor = ฝั่งตั้งยอด, clearing = ฝั่งที่คำอธิบายอ้างถึง anchor)
 *
 * อัลกอริทึมทำงานแบบ "ตัดยอด" (allocation) รายการหนึ่งจึงถูกเคลียร์บางส่วนหรือหลายครั้งได้
 */

/** ฝั่งตรงข้ามของแต่ละด้าน */
const OPPOSITE = { debit: 'credit', credit: 'debit' };
const SIDES = ['debit', 'credit'];

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
    key: 'partyExact',
    label: 'ยอดตรงกันพอดี + คำอธิบายอ้างถึงคู่ค้ารายเดียวกัน',
    confidence: 60,
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

/** ความยาวขั้นต่ำของชื่อคู่ค้าที่ต้องตรงกัน (นับเป็นอักขระไทย) */
const MIN_PARTY = 5;

/**
 * คำที่โผล่ในคำอธิบายแทบทุกบรรทัด ไม่ได้บ่งชี้ว่าเป็นคู่ค้ารายไหน
 * ต้องตัดทิ้งก่อนเทียบ ไม่งั้นจะจับคู่ผิดเพราะคำว่า "เงินทดลอง" ตรงกัน
 */
const GENERIC_WORDS =
  /(เงินทดลองจ่าย|เงินทดลอง|เงินทดรองจ่าย|เงินทดรอง|ชำระหนี้ให้|ชำระหนี้|เคลียร์|เคลีย|บริษัท|จำกัด|มหาชน|ประเทศไทย|สาขา|หจก|บจก|บจ|หสม|มัดจำ|ค่าใช้จ่าย|ค่าจ้าง|ค่าแรง|ค่าของ|ค่าขน|ค่ารถ|บัตรเครดิต|ค่าน้ำมัน)/g;

/**
 * เหลือเฉพาะตัวอักษรไทยที่บ่งชี้ชื่อคู่ค้า — ตัดเลขเอกสาร ตัวเลข และคำทั่วไปออก
 * เช่น "ชำระหนี้ให้   บริษัท ดราก้อน แอร์ ดักท์ จำกัด" -> "ดราก้อนแอร์ดักท์"
 */
function partyText(description) {
  return String(description || '')
    .replace(/[A-Za-z]{2,}\d{4,}/g, ' ') // เลขเอกสาร PV/PS/SO/PO/JV
    .replace(GENERIC_WORDS, ' ')
    .replace(/[^ก-๛]+/g, '') // เหลือเฉพาะอักษรไทย (ตัดช่องว่างและวรรคตอนทิ้ง)
    .trim();
}

/**
 * ชื่อคู่ค้าถือว่าตรงกันเมื่อมีสตริงย่อยที่ยาวพอปรากฏทั้งสองฝั่ง
 * ใช้สตริงย่อยแทนการตัดคำ เพราะคำอธิบายเขียนติดกันและสะกดไม่เหมือนกันเป๊ะ
 * (เช่น "หจก.มั่นคงสตีล" กับ "หจก. ค้ามั่นคงสตีล")
 */
function sharesParty(a, b) {
  if (a.length < MIN_PARTY || b.length < MIN_PARTY) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  for (let i = 0; i + MIN_PARTY <= short.length; i += 1) {
    if (long.includes(short.slice(i, i + MIN_PARTY))) return true;
  }
  return false;
}

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

  const bySide = {
    debit: entries.filter((e) => e.side === 'debit'),
    credit: entries.filter((e) => e.side === 'credit'),
  };

  // ดัชนีเลขใบสำคัญ / เลขงาน -> รายการ แยกเก็บทั้งสองฝั่ง
  // (รายการเดียวอาจแยกลงหลายบรรทัด จึงเก็บเป็นอาร์เรย์)
  const voucherIndex = { debit: new Map(), credit: new Map() };
  const jobIndex = { debit: new Map(), credit: new Map() };
  const push = (map, key, row) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };
  for (const side of SIDES) {
    for (const e of bySide[side]) {
      if (e.voucher) push(voucherIndex[side], e.voucher, e);
      for (const job of e.jobRefs) push(jobIndex[side], job, e);
    }
  }

  const matches = [];

  const allocate = (anchor, clearing, strategy) => {
    const as = state.get(anchor.lineNo);
    const cs = state.get(clearing.lineNo);
    const amount = round2(Math.min(as.remaining, cs.remaining));
    if (amount <= EPSILON) return false;

    as.remaining = round2(as.remaining - amount);
    cs.remaining = round2(cs.remaining - amount);
    as.matchedAmount = round2(as.matchedAmount + amount);
    cs.matchedAmount = round2(cs.matchedAmount + amount);
    as.partners.push(clearing.lineNo);
    cs.partners.push(anchor.lineNo);

    const [debit, credit] = anchor.side === 'debit' ? [anchor, clearing] : [clearing, anchor];
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
  /** รายการเคลียร์ต้องเกิดหลังหรือวันเดียวกับรายการตั้งยอด */
  const inOrder = (a, c) => !a.dateSort || !c.dateSort || a.dateSort <= c.dateSort;

  /** ผู้เข้าคู่ฝั่งตั้งยอดที่ยังมียอดเหลือ เรียงตามความใกล้เคียงของยอดแล้วตามวันที่ */
  const rank = (candidates, clearing) => {
    const cs = state.get(clearing.lineNo);
    return candidates
      .filter((d) => d.lineNo !== clearing.lineNo && open(d))
      .sort((a, b) => {
        const da = Math.abs(state.get(a.lineNo).remaining - cs.remaining);
        const db = Math.abs(state.get(b.lineNo).remaining - cs.remaining);
        if (Math.abs(da - db) > EPSILON) return da - db;
        const oa = inOrder(a, clearing) ? 0 : 1;
        const ob = inOrder(b, clearing) ? 0 : 1;
        if (oa !== ob) return oa - ob;
        return a.lineNo - b.lineNo;
      });
  };

  /**
   * เลขเอกสารที่คำอธิบายอ้างถึง (ไม่นับเลขใบสำคัญของตัวเอง)
   * นอกจากเลขที่รู้จักว่าเป็นใบสำคัญแล้ว ยังรับเลขอื่นที่ตรงกับช่องใบสำคัญของรายการฝั่งตั้งยอดจริง
   * เช่น "RR6903005-IV6905017-โอนปิดต้นทุน..." คู่กับใบสำคัญ RR6903005 ของสมุดซื้อ
   * — คำนำหน้าที่ไม่ได้อยู่ในรายการ VOUCHER_PREFIXES จึงยังจับคู่ได้ ตราบใดที่มีรายการ
   * ฝั่งตั้งยอดใช้เลขนั้นเป็นใบสำคัญอยู่จริง
   */
  const refsOf = (c, anchorSide) =>
    c.allRefs.filter(
      (ref) =>
        ref !== c.voucher && (c.voucherRefs.includes(ref) || voucherIndex[anchorSide].has(ref)),
    );

  /**
   * ทิศทางหลักของบัญชีนี้ — ฝั่งไหนคือ "รายการตั้งยอด"
   * ดูจากหลักฐานตรงๆ: คำอธิบายของฝั่งหนึ่งอ้างเลขใบสำคัญของอีกฝั่งกี่ครั้ง
   * (เงินทดลองจ่าย: เครดิตอ้างใบสำคัญเดบิต -> anchor = debit)
   * (ค่าใช้จ่ายค้างจ่าย: เดบิตอ้างใบสำคัญเครดิต -> anchor = credit)
   * ถ้าไม่มีหลักฐานเลย ใช้ฝั่งที่ยอดรวมมากกว่าเป็นฝั่งตั้งยอด
   */
  const primaryAnchor = (() => {
    const evidence = { debit: 0, credit: 0 };
    for (const side of SIDES) {
      const anchorSide = OPPOSITE[side];
      for (const c of bySide[side]) evidence[anchorSide] += refsOf(c, anchorSide).length;
    }
    if (evidence.debit !== evidence.credit) return evidence.debit > evidence.credit ? 'debit' : 'credit';
    const total = (side) => sum(bySide[side], (r) => (side === 'debit' ? r.debit : r.credit));
    return total('credit') > total('debit') ? 'credit' : 'debit';
  })();

  /** ทิศทางที่เกณฑ์หนึ่งๆ จะเดิน — เกณฑ์ที่มีหลักฐานเลขเอกสารเดินได้ทั้งสองทาง */
  const BOTH = [primaryAnchor, OPPOSITE[primaryAnchor]];
  const PRIMARY = [primaryAnchor];

  const runPass = (strategy, anchorSide, pick) => {
    if (!opts[strategy.key]) return;
    for (const c of bySide[OPPOSITE[anchorSide]]) {
      const cs = state.get(c.lineNo);
      while (cs.remaining > EPSILON) {
        const d = pick(c, cs, anchorSide);
        if (!d) break;
        if (!allocate(d, c, strategy)) break;
      }
    }
  };

  const byKey = Object.fromEntries(STRATEGIES.map((s) => [s.key, s]));

  /**
   * เดินสองรอบเสมอ: รอบแรกรับเฉพาะคู่ที่ลำดับวันที่ถูกต้อง รอบสองจึงยอมให้ย้อนวันได้
   * กันกรณีพิมพ์เลขใบสำคัญผิดไปคว้ารายการที่ยังไม่เกิดขึ้น ณ วันที่เคลียร์
   * ทิศทางหลักของบัญชีมาก่อนเสมอ ทิศทางกลับเป็นเพียงตัวสำรอง
   */
  const runChronological = (strategy, dirs, pick) => {
    for (const ordered of [true, false]) {
      for (const anchorSide of dirs) {
        runPass(strategy, anchorSide, (c, cs, side) => pick(c, cs, side, ordered));
      }
    }
  };

  // 1) อ้างเลขใบสำคัญตรงกันและยอดตรงกันพอดี
  runChronological(byKey.voucherExact, BOTH, (c, cs, anchorSide, ordered) => {
    for (const ref of refsOf(c, anchorSide)) {
      const hit = (voucherIndex[anchorSide].get(ref) || []).find(
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
  runChronological(byKey.voucherPartial, BOTH, (c, cs, anchorSide, ordered) => {
    for (const ref of refsOf(c, anchorSide)) {
      const cands = rank(voucherIndex[anchorSide].get(ref) || [], c).filter(
        (d) => !ordered || inOrder(d, c),
      );
      if (cands.length) return cands[0];
    }
    return null;
  });

  // 3) อ้างเลขงาน SO/PO เดียวกัน และยอดตรงกันพอดี
  runChronological(byKey.jobExact, BOTH, (c, cs, anchorSide, ordered) => {
    for (const job of c.jobRefs) {
      const hit = (jobIndex[anchorSide].get(job) || []).find(
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

  // 4) ยอดตรงกันพอดี และคำอธิบายทั้งสองฝั่งอ้างถึงคู่ค้ารายเดียวกัน
  //    ครอบคลุมกรณีจ่ายชำระหนี้ (PS) ที่เขียนแต่ชื่อผู้ขาย ไม่ได้อ้างเลขใบสำคัญหรือเลขงาน
  //    เช่น "25%ดราก้อน งานติดตั้ง..." คู่กับ "ชำระหนี้ให้ บริษัท ดราก้อน แอร์ ดักท์ จำกัด"
  //    เกณฑ์นี้เดินเฉพาะทิศทางหลักและรอบเดียว — บังคับให้รายการเคลียร์เกิดหลังรายการตั้งยอดเสมอ
  //    เพราะชื่อคู่ค้าเป็นหลักฐานที่อ่อนกว่าเลขเอกสาร ถ้ายอมให้ย้อนวันหรือย้อนทิศด้วยจะไปคว้า
  //    รายการของคู่ค้าเดียวกันที่เกิดคนละงานคนละเดือน
  runPass(byKey.partyExact, primaryAnchor, (c, cs, anchorSide) => {
    const cParty = partyText(c.description);
    if (cParty.length < MIN_PARTY) return null;
    const hits = bySide[anchorSide].filter(
      (d) =>
        d.lineNo !== c.lineNo &&
        open(d) &&
        nearlyEqual(state.get(d.lineNo).remaining, cs.remaining) &&
        inOrder(d, c) &&
        sharesParty(cParty, partyText(d.description)),
    );
    return hits.length ? rank(hits, c)[0] || null : null;
  });

  // 5) อ้างเลขงาน SO/PO เดียวกัน แต่ยอดไม่ตรงพอดี
  runChronological(byKey.jobPartial, PRIMARY, (c, cs, anchorSide, ordered) => {
    for (const job of c.jobRefs) {
      const cands = rank(jobIndex[anchorSide].get(job) || [], c).filter(
        (d) => !ordered || inOrder(d, c),
      );
      if (cands.length) return cands[0];
    }
    return null;
  });

  // 6) ยอดตรงกันพอดี และเหลือผู้เข้าคู่เพียงรายเดียวเท่านั้น
  runChronological(byKey.amountUnique, PRIMARY, (c, cs, anchorSide, ordered) => {
    const hit = bySide[anchorSide].filter(
      (d) =>
        d.lineNo !== c.lineNo &&
        open(d) &&
        nearlyEqual(state.get(d.lineNo).remaining, cs.remaining) &&
        (!ordered || inOrder(d, c)),
    );
    return hit.length === 1 ? hit[0] : null;
  });

  return summarize(entries, state, matches, opts, primaryAnchor);
}

/** สรุปผล: รายการที่ยังไม่มีคู่ พร้อมยอดคงเหลือที่คำนวณใหม่ */
function summarize(entries, state, matches, opts, primaryAnchor = 'debit') {
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
    // ฝั่งที่ถือเป็น "รายการตั้งยอด" ของบัญชีนี้ (debit = บัญชีฝั่งสินทรัพย์, credit = ฝั่งหนี้สิน)
    primaryAnchor,
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
 * @param {number} [sign] ทิศทางคอลัมน์ยอดคงเหลือ (+1 เดินตามเดบิต, -1 เดินตามเครดิต)
 *   ดู detectBalanceSign — บัญชีหนี้สินพิมพ์ยอดค้างจ่ายเป็นเลขบวก ต้องใช้ -1
 */
function withRunningBalance(openingBalance, outstanding, sign = 1) {
  const dir = sign < 0 ? -1 : 1;
  let balance = round2(openingBalance);
  const rows = outstanding.map((r) => {
    const debit = r.side === 'debit' ? r.remaining : 0;
    const credit = r.side === 'credit' ? r.remaining : 0;
    balance = round2(balance + dir * (debit - credit));
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
