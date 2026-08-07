'use strict';

/**
 * สร้าง/อัปเดตตารางในฐานข้อมูล MySQL ตาม src/schema.sql
 *   node scripts/init-db.js
 * อ่านค่าเชื่อมต่อจากไฟล์ .env
 */

const config = require('../src/config');
const db = require('../src/db');

(async () => {
  console.log(`เชื่อมต่อ ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
  const status = await db.checkConnection();
  if (!status.available) {
    console.error('เชื่อมต่อฐานข้อมูลไม่สำเร็จ:', status.error);
    process.exit(1);
  }
  await db.migrate();
  console.log('สร้างตารางเรียบร้อย: jobs, entries, matches');
  await db.close();
})().catch(async (err) => {
  console.error('ล้มเหลว:', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
