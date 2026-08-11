'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * เก็บผลการประมวลผลไว้ชั่วคราว เพื่อให้ผู้ใช้เลือกรูปแบบไฟล์และปรับเกณฑ์การจับคู่ได้
 * โดยไม่ต้องอัปโหลดใหม่ (ประวัติถาวรอยู่ในฐานข้อมูล MySQL)
 *
 * เก็บสองชั้น: หน่วยความจำเป็นชั้นแรก และไฟล์ JSON ใน tmp/jobs เป็นชั้นสำรอง
 * เพราะ Passenger/Plesk รันแอปได้หลาย process พร้อมกัน — ถ้าเก็บแต่ในหน่วยความจำ
 * คำขอดาวน์โหลดอาจไปตกที่ process ที่ไม่ได้เป็นคนประมวลผลไฟล์ แล้วได้ 404
 *
 * ตัวไฟล์ที่ผู้ใช้อัปโหลดยังไม่ถูกเขียนลงดิสก์เหมือนเดิม — ที่เก็บคือผลลัพธ์ที่แปลงแล้ว
 */
const jobs = new Map();
const dir = path.join(config.root, 'tmp', 'jobs');

let diskReady = null;

/** เตรียมโฟลเดอร์ ครั้งแรกครั้งเดียว — ถ้าเขียนดิสก์ไม่ได้ก็ยังทำงานต่อด้วยหน่วยความจำ */
function ensureDir() {
  if (diskReady !== null) return diskReady;
  try {
    fs.mkdirSync(dir, { recursive: true });
    diskReady = true;
  } catch (err) {
    console.warn('[store] เขียนโฟลเดอร์ tmp/jobs ไม่ได้:', err.message, '— เก็บผลลัพธ์ในหน่วยความจำอย่างเดียว');
    diskReady = false;
  }
  return diskReady;
}

function fileOf(id) {
  return path.join(dir, `${id}.json`);
}

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

/** เขียนแบบ atomic กันอ่านเจอไฟล์ที่เขียนค้างอยู่ */
function persist(job) {
  if (!ensureDir()) return;
  const tmp = `${fileOf(job.id)}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(job));
    fs.renameSync(tmp, fileOf(job.id));
  } catch (err) {
    console.warn('[store] บันทึกผลลัพธ์ลงดิสก์ไม่สำเร็จ:', err.message);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ไม่มีไฟล์ค้างก็ไม่เป็นไร */
    }
  }
}

function put(job) {
  job.expiresAt = Date.now() + config.resultTtlMinutes * 60 * 1000;
  jobs.set(job.id, job);
  persist(job);
  sweep();
  return job;
}

/** บันทึกซ้ำหลังแก้ไข job (เช่น จับคู่ใหม่) โดยไม่ต่ออายุ */
function save(job) {
  jobs.set(job.id, job);
  persist(job);
  return job;
}

function get(id) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) return null;

  let job = jobs.get(id);
  if (!job) job = readFromDisk(id);
  if (!job) return null;

  if (job.expiresAt <= Date.now()) {
    remove(id);
    return null;
  }
  jobs.set(id, job);
  return job;
}

function readFromDisk(id) {
  if (!ensureDir()) return null;
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null; // ไม่มีไฟล์ หรือไฟล์เสีย — ถือว่าไม่มีผลลัพธ์
  }
}

function remove(id) {
  jobs.delete(id);
  try {
    fs.unlinkSync(fileOf(id));
  } catch {
    /* ไม่มีไฟล์อยู่แล้ว */
  }
}

/** ลบผลลัพธ์ที่หมดอายุทั้งในหน่วยความจำและบนดิสก์ */
function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt <= now) jobs.delete(id);
  }
  if (!ensureDir()) return;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const job = (() => {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          return null;
        }
      })();
      if (!job || !job.expiresAt || job.expiresAt <= now) fs.unlinkSync(file);
    }
  } catch (err) {
    console.warn('[store] ล้างผลลัพธ์เก่าไม่สำเร็จ:', err.message);
  }
}

function size() {
  sweep();
  if (!ensureDir()) return jobs.size;
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length;
  } catch {
    return jobs.size;
  }
}

module.exports = { newId, put, save, get, size };
