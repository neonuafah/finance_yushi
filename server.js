'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./src/config');
const db = require('./src/db');
const api = require('./src/routes/api');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

const router = express.Router();

router.use(
  express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    maxAge: config.env === 'production' ? '1h' : 0,
  }),
);
router.use('/api', api);

// Plesk อาจ mount แอปไว้ใต้ path ย่อย เช่น /finance
app.use(config.basePath || '/', router);

app.use((req, res) => {
  res.status(404).json({ error: 'ไม่พบเส้นทางที่ร้องขอ' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `ไฟล์ใหญ่เกิน ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`
        : `อัปโหลดไม่สำเร็จ: ${err.message}`;
    return res.status(413).json({ error: message });
  }
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'เกิดข้อผิดพลาดภายในระบบ' });
});

async function start() {
  const status = await db.checkConnection();
  if (status.available) {
    try {
      await db.migrate();
      console.log('[db] เชื่อมต่อและตรวจสอบตารางเรียบร้อย');
    } catch (err) {
      console.warn('[db] สร้างตารางไม่สำเร็จ:', err.message);
    }
  } else {
    console.warn('[db] ใช้งานฐานข้อมูลไม่ได้:', status.error, '— ระบบจะทำงานต่อโดยไม่บันทึกประวัติ');
  }

  const server = app.listen(config.port, () => {
    console.log(`[server] พร้อมใช้งานที่ port ${config.port}${config.basePath || ''}`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] ปิดระบบ (${signal})`);
    server.close();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) start();

module.exports = { app, start };
