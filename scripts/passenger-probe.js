'use strict';

/*
 * ตัวทดสอบ Passenger — ใช้เฉพาะตอนไล่ปัญหา "spawn timeout" บน Plesk
 *
 * วิธีใช้: ตั้ง Application Startup File เป็น scripts/passenger-probe.js แล้ว Restart App
 * จากนั้นเปิด URL ของเว็บ จะเห็นรายงานว่าโหลดโมดูลไหนผ่าน/ค้าง/พังพร้อมเวลาที่ใช้
 *
 * ไฟล์นี้เปิด listen ก่อนเป็นอันดับแรก (Passenger จึงไม่ timeout) แล้วค่อยทยอย require
 * ทีละตัวโดยเว้นจังหวะให้ตอบ HTTP ได้ระหว่างทาง — ถ้าค้างที่โมดูลใด รายงานจะหยุดค้าง
 * ที่บรรทัดของโมดูลนั้นให้เห็นชัด
 *
 * เสร็จแล้วอย่าลืมตั้ง Application Startup File กลับเป็น server.js
 */

const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');

const MODULES = [
  'dotenv',
  'express',
  'multer',
  'mysql2/promise',
  'exceljs',
  'pdfkit',
  path.join(root, 'src', 'config.js'),
  path.join(root, 'src', 'domain.js'),
  path.join(root, 'src', 'db.js'),
  path.join(root, 'src', 'matcher.js'),
  path.join(root, 'src', 'parsers', 'excel.js'),
  path.join(root, 'src', 'parsers', 'pdf.js'),
  path.join(root, 'src', 'exporters', 'excel.js'),
  path.join(root, 'src', 'exporters', 'pdf.js'),
  path.join(root, 'src', 'routes', 'api.js'),
];

const short = (m) => (m.startsWith(root) ? m.slice(root.length + 1).replace(/\\/g, '/') : m);
const results = [];
let loading = null;
let done = false;

function report() {
  const lines = [
    `passenger probe — node ${process.version}`,
    `cwd ${process.cwd()}`,
    `uptime ${process.uptime().toFixed(1)}s   rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`,
    '',
  ];
  for (const r of results) {
    lines.push(`${r.ok ? 'OK  ' : 'FAIL'} ${String(r.ms).padStart(6)} ms  ${r.name}${r.error ? '  -> ' + r.error : ''}`);
  }
  if (loading) lines.push(`....        กำลังโหลด  ${loading}   <-- ค้างอยู่ตรงนี้`);
  if (done) lines.push('', 'โหลดครบทุกโมดูลแล้ว — ปัญหาไม่ได้อยู่ที่การ require');
  return lines.join('\n') + '\n';
}

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(report());
  })
  .listen(process.env.PORT || 3000, () => {
    console.log(`[probe] listen แล้ว (node ${process.version}) — เริ่มไล่โหลดโมดูล`);
    next(0);
  });

/** โหลดทีละตัว เว้นจังหวะด้วย setTimeout เพื่อให้ตอบ HTTP ได้ระหว่างทาง */
function next(i) {
  if (i >= MODULES.length) {
    done = true;
    loading = null;
    console.log('[probe] โหลดครบทุกโมดูล');
    return;
  }
  const name = short(MODULES[i]);
  loading = name;
  setTimeout(() => {
    const t0 = process.hrtime.bigint();
    let ok = true;
    let error = null;
    try {
      require(MODULES[i]);
    } catch (err) {
      ok = false;
      error = `${err.code || err.name}: ${err.message.split('\n')[0]}`;
    }
    const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
    results.push({ name, ok, ms, error });
    console.log(`[probe] ${ok ? 'OK' : 'FAIL'} ${ms}ms ${name}${error ? ' -> ' + error : ''}`);
    next(i + 1);
  }, 300);
}
