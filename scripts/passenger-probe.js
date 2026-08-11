'use strict';

/*
 * ตัวทดสอบ Passenger — ใช้เฉพาะตอนไล่ปัญหา "spawn timeout" บน Plesk
 *
 * ไฟล์นี้ไม่ require อะไรนอกจากโมดูลมาตรฐานของ node และเปิด listen ทันที
 * วิธีใช้: ตั้ง Application Startup File เป็น scripts/passenger-probe.js แล้ว Restart App
 *
 *   - ถ้าเปิดเว็บแล้วเห็น "passenger probe ok"  -> Passenger กับ Node คุยกันได้
 *     ปัญหาอยู่ที่โค้ดแอปหรือ node_modules
 *   - ถ้ายัง spawn timeout เหมือนเดิม           -> Passenger สตาร์ท Node เวอร์ชันนี้ไม่ได้
 *     ให้เปลี่ยน Node.js version เป็น LTS (20 หรือ 22) แล้วลองใหม่
 *
 * เสร็จแล้วอย่าลืมตั้ง Application Startup File กลับเป็น server.js
 */

const http = require('http');

console.log(`[probe] เริ่มทำงาน node ${process.version} pid ${process.pid}`);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`passenger probe ok\nnode ${process.version}\npath ${req.url}\ncwd ${process.cwd()}\n`);
});

server.listen(process.env.PORT || 3000, () => {
  console.log('[probe] listen แล้ว', server.address());
});
