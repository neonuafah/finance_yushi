'use strict';

require('dotenv').config({ quiet: true });
const path = require('path');

const root = path.resolve(__dirname, '..');

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  root,
  env: process.env.NODE_ENV || 'production',
  port: int(process.env.PORT, 3000),
  // Plesk ตั้ง Node.js app ไว้ใต้ path ย่อยได้ เช่น /finance
  basePath: (process.env.BASE_PATH || '').replace(/\/+$/, ''),

  // ไฟล์ที่อัปโหลดถูกประมวลผลในหน่วยความจำ ไม่มีการเขียนลงดิสก์
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 25) * 1024 * 1024,
  // เก็บผลลัพธ์ในหน่วยความจำไว้ให้ดาวน์โหลดซ้ำได้ (นาที)
  resultTtlMinutes: int(process.env.RESULT_TTL_MINUTES, 120),

  db: {
    enabled: bool(process.env.DB_ENABLED, true),
    host: process.env.DB_HOST || 'localhost',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'leaf_finance',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'leaf_finance',
    connectionLimit: int(process.env.DB_POOL, 5),
  },

  fonts: {
    regular: process.env.FONT_REGULAR || path.join(root, 'assets', 'fonts', 'Sarabun-Regular.ttf'),
    bold: process.env.FONT_BOLD || path.join(root, 'assets', 'fonts', 'Sarabun-Bold.ttf'),
  },
};

module.exports = config;
