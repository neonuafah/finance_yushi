'use strict';

/**
 * ทดสอบครบวงจรโดยไม่ต้องใช้เซิร์ฟเวอร์หรือฐานข้อมูล:
 * อ่านไฟล์ -> จับคู่ -> ตรวจค่าคงที่ทางบัญชี -> ออกไฟล์ Excel/PDF
 *
 *   node scripts/smoke.js <ไฟล์.xlsx|ไฟล์.pdf> [ไฟล์ที่สอง ...]
 *
 * ถ้าให้ทั้งไฟล์ Excel และ PDF ของรายงานเดียวกัน จะเทียบผลลัพธ์ทั้งสองทางให้ด้วย
 */

const fs = require('fs');
const path = require('path');
const { parseExcel } = require('../src/parsers/excel');
const { parsePdf } = require('../src/parsers/pdf');
const { matchEntries, withRunningBalance } = require('../src/matcher');
const { exportExcel } = require('../src/exporters/excel');
const { exportPdf } = require('../src/exporters/pdf');
const { round2 } = require('../src/domain');

const OUT_DIR = path.join(__dirname, '..', 'out');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function parseFile(file) {
  const buf = fs.readFileSync(file);
  return path.extname(file).toLowerCase() === '.pdf' ? parsePdf(buf) : parseExcel(buf);
}

async function run(file) {
  console.log(`\n=== ${path.basename(file)} ===`);
  const { meta, entries, warnings } = await parseFile(file);
  console.log(`  อ่านได้ ${entries.length} รายการ | ยอดยกมา ${meta.openingBalance} | ยอดปิดตามรายงาน ${meta.reportedClosingBalance}`);
  for (const w of warnings) console.log(`  หมายเหตุ: ${w}`);

  check('อ่านรายการได้', entries.length > 0);
  check('พบเลขที่บัญชี', Boolean(meta.accountCode), meta.accountCode);

  // เดบิตรวม - เครดิตรวม + ยอดยกมา ต้องเท่ากับยอดปิดของรายงาน
  const totalDebit = round2(entries.reduce((s, e) => s + e.debit, 0));
  const totalCredit = round2(entries.reduce((s, e) => s + e.credit, 0));
  const derived = round2(meta.openingBalance + totalDebit - totalCredit);
  check(
    'ยอดยกมา + เดบิต - เครดิต = ยอดปิดตามรายงาน',
    meta.reportedClosingBalance === null || Math.abs(derived - meta.reportedClosingBalance) < 0.005,
    `${derived} vs ${meta.reportedClosingBalance}`,
  );

  const job = {
    id: 'smoke',
    originalName: path.basename(file),
    sourceType: path.extname(file).toLowerCase() === '.pdf' ? 'pdf' : 'excel',
    meta,
    entries,
    warnings,
  };

  // ค่าคงที่สำคัญ: ไม่ว่าจะเปิดเกณฑ์ใด ยอดคงเหลือใหม่ต้องไม่เปลี่ยน (คู่ที่จับได้หักล้างกันพอดี)
  const balances = [];
  for (const opts of [{}, { jobPartial: true }, { amountUnique: true }, { jobPartial: true, amountUnique: true }]) {
    const res = matchEntries(entries, opts);
    const { closingBalance } = withRunningBalance(meta.openingBalance, res.outstanding);
    balances.push(closingBalance);
    console.log(
      `  เกณฑ์ ${JSON.stringify(opts).padEnd(40)} จับคู่ ${String(res.totals.matchedPairs).padStart(4)} คู่ | ` +
        `เดบิตค้าง ${String(res.totals.unmatchedDebitCount).padStart(3)} (${res.totals.unmatchedDebitTotal}) | ` +
        `เครดิตค้าง ${String(res.totals.unmatchedCreditCount).padStart(3)} (${res.totals.unmatchedCreditTotal}) | ` +
        `ยอดใหม่ ${closingBalance}`,
    );

    // ยอดที่ตัดไปแล้วต้องไม่เกินยอดตั้งต้นของทุกแถว
    const overAllocated = res.rows.filter((r) => r.remaining < -0.005 || r.matchedAmount - r.originalAmount > 0.005);
    check(`ไม่มีการตัดยอดเกิน (${JSON.stringify(opts)})`, overAllocated.length === 0, `${overAllocated.length} แถว`);

    // เดบิตกับเครดิตของคู่เดียวกันต้องไม่ใช่แถวเดียวกัน
    const selfPairs = res.pairs.filter((p) => p.debitLine === p.creditLine);
    check(`ไม่มีการจับคู่กับตัวเอง (${JSON.stringify(opts)})`, selfPairs.length === 0);
  }
  check(
    'ยอดคงเหลือใหม่คงที่ทุกเกณฑ์',
    balances.every((b) => Math.abs(b - balances[0]) < 0.005),
    balances.join(' / '),
  );
  check(
    'ยอดคงเหลือใหม่ = ยอดปิดตามรายงานต้นฉบับ',
    meta.reportedClosingBalance === null || Math.abs(balances[0] - meta.reportedClosingBalance) < 0.005,
    `${balances[0]} vs ${meta.reportedClosingBalance}`,
  );

  // ออกไฟล์จริง
  const res = matchEntries(entries);
  const { closingBalance } = withRunningBalance(meta.openingBalance, res.outstanding);
  Object.assign(job, res, { closingBalance });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stem = path.basename(file, path.extname(file)).replace(/\s+/g, '_');

  const xlsx = await exportExcel(job);
  fs.writeFileSync(path.join(OUT_DIR, `${stem}.out.xlsx`), xlsx);
  check('ออกไฟล์ Excel ได้', xlsx.length > 5000, `${(xlsx.length / 1024).toFixed(0)} KB`);

  const pdf = await exportPdf(job);
  fs.writeFileSync(path.join(OUT_DIR, `${stem}.out.pdf`), pdf);
  check('ออกไฟล์ PDF ได้', pdf.length > 3000 && pdf.subarray(0, 5).toString() === '%PDF-', `${(pdf.length / 1024).toFixed(0)} KB`);

  return { meta, entries, res, closingBalance };
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('ใช้งาน: node scripts/smoke.js <ไฟล์.xlsx|ไฟล์.pdf> [...]');
    process.exit(2);
  }

  const results = [];
  for (const f of files) results.push({ file: f, ...(await run(f)) });

  // เทียบผลลัพธ์ระหว่างไฟล์ (กรณีให้ทั้ง Excel และ PDF ของรายงานเดียวกัน)
  if (results.length > 1) {
    console.log('\n=== เทียบผลลัพธ์ระหว่างไฟล์ ===');
    const [a, ...rest] = results;
    for (const b of rest) {
      check(`จำนวนรายการเท่ากัน (${path.basename(a.file)} vs ${path.basename(b.file)})`,
        a.entries.length === b.entries.length, `${a.entries.length} vs ${b.entries.length}`);
      check('ยอดคงเหลือใหม่เท่ากัน', Math.abs(a.closingBalance - b.closingBalance) < 0.005,
        `${a.closingBalance} vs ${b.closingBalance}`);
      check('จำนวนคู่ที่จับได้เท่ากัน', a.res.totals.matchedPairs === b.res.totals.matchedPairs,
        `${a.res.totals.matchedPairs} vs ${b.res.totals.matchedPairs}`);

      const diffs = [];
      for (let i = 0; i < Math.min(a.entries.length, b.entries.length); i += 1) {
        const x = a.entries[i], y = b.entries[i];
        if (x.voucher !== y.voucher || Math.abs(x.debit - y.debit) > 0.005 || Math.abs(x.credit - y.credit) > 0.005) {
          diffs.push(i + 1);
        }
      }
      check('เลขใบสำคัญและจำนวนเงินตรงกันทุกแถว', diffs.length === 0, `ต่างกัน ${diffs.length} แถว`);
    }
  }

  console.log(`\nไฟล์ผลลัพธ์อยู่ที่ ${OUT_DIR}`);
  console.log(failures === 0 ? '\nผ่านทั้งหมด' : `\nไม่ผ่าน ${failures} ข้อ`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
