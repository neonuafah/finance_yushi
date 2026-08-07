'use strict';

/**
 * ทดสอบ API ผ่าน HTTP จริง (ต้องรันเซิร์ฟเวอร์ไว้ก่อน)
 *   node scripts/api-test.js http://127.0.0.1:3000 <ไฟล์รายงาน>
 */

const fs = require('fs');
const path = require('path');

const base = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const file = process.argv[3];

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

(async () => {
  if (!file) {
    console.error('ใช้งาน: node scripts/api-test.js <baseUrl> <ไฟล์รายงาน>');
    process.exit(2);
  }

  const health = await (await fetch(`${base}/api/health`)).json();
  check('GET /api/health', health.ok === true, `db=${health.db.available}`);

  const strategies = await (await fetch(`${base}/api/strategies`)).json();
  check('GET /api/strategies', Array.isArray(strategies.strategies) && strategies.strategies.length > 0);

  const index = await fetch(`${base}/`);
  check('GET / (หน้าเว็บ)', index.ok && (await index.text()).includes('จับคู่เงินทดรองจ่าย'));

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  const uploadRes = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
  const job = await uploadRes.json();
  check('POST /api/upload', uploadRes.ok, job.error || `${job.totals?.entryCount} รายการ`);
  if (!uploadRes.ok) process.exit(1);

  console.log(
    `        จับคู่ ${job.totals.matchedPairs} คู่ | เดบิตค้าง ${job.totals.unmatchedDebitCount} | ` +
      `เครดิตค้าง ${job.totals.unmatchedCreditCount} | ยอดใหม่ ${job.closingBalance}`,
  );
  check('ยอดคงเหลือใหม่ตรงกับรายงานต้นฉบับ', job.balanceCheckOk === true);
  check('มีรายการที่ยังไม่มีคู่ส่งกลับมา', job.unmatchedDebits.length > 0 && job.outstanding.length > 0);
  check('มียอดคงเหลือไล่บรรทัด', job.outstanding.every((r) => typeof r.runningBalance === 'number'));

  const reRes = await fetch(`${base}/api/jobs/${job.jobId}/rematch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ options: { amountUnique: true } }),
  });
  const re = await reRes.json();
  check('POST /api/jobs/:id/rematch', reRes.ok, `จับคู่ ${re.totals?.matchedPairs} คู่`);
  check('เปิดเกณฑ์เพิ่มแล้วจับคู่ได้มากขึ้น', re.totals.matchedPairs >= job.totals.matchedPairs);
  check('ยอดคงเหลือใหม่ไม่เปลี่ยน', Math.abs(re.closingBalance - job.closingBalance) < 0.005);

  fs.mkdirSync(path.join(__dirname, '..', 'out'), { recursive: true });
  for (const [format, magic] of [['xlsx', 'PK'], ['pdf', '%PDF-']]) {
    const res = await fetch(`${base}/api/jobs/${job.jobId}/export?format=${format}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const disposition = res.headers.get('content-disposition') || '';
    check(
      `GET /api/jobs/:id/export?format=${format}`,
      res.ok && buf.subarray(0, magic.length).toString() === magic,
      `${(buf.length / 1024).toFixed(0)} KB`,
    );
    check(`ชื่อไฟล์ ${format} รองรับภาษาไทย`, disposition.includes("filename*=UTF-8''"));
    fs.writeFileSync(path.join(__dirname, '..', 'out', `api-download.${format}`), buf);
  }

  const missing = await fetch(`${base}/api/jobs/ไม่มีจริง/export?format=xlsx`);
  check('งานที่ไม่มีอยู่ตอบ 404', missing.status === 404);

  const badFormat = await fetch(`${base}/api/jobs/${job.jobId}/export?format=docx`);
  check('รูปแบบไฟล์ที่ไม่รองรับตอบ 400', badFormat.status === 400);

  console.log(failures === 0 ? '\nผ่านทั้งหมด' : `\nไม่ผ่าน ${failures} ข้อ`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
