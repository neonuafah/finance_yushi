'use strict';

/*
 * ไฟล์เริ่มต้นสำรอง — Plesk ตั้งค่า Application Startup File เป็น app.js มาให้เป็นค่าเริ่มต้น
 * ไฟล์นี้จึงเรียก server.js ต่อให้ เพื่อให้ตั้งเป็น app.js หรือ server.js ก็ทำงานได้เหมือนกัน
 */

const { start } = require('./server');

start();
