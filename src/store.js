'use strict';

const crypto = require('crypto');
const config = require('./config');

/**
 * เก็บผลการประมวลผลไว้ในหน่วยความจำชั่วคราว เพื่อให้ผู้ใช้เลือกรูปแบบไฟล์
 * และปรับเกณฑ์การจับคู่ได้โดยไม่ต้องอัปโหลดใหม่
 * (ประวัติถาวรอยู่ในฐานข้อมูล MySQL)
 */
const jobs = new Map();

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function put(job) {
  job.expiresAt = Date.now() + config.resultTtlMinutes * 60 * 1000;
  jobs.set(job.id, job);
  sweep();
  return job;
}

function get(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.expiresAt <= Date.now()) {
    jobs.delete(id);
    return null;
  }
  return job;
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt <= now) jobs.delete(id);
  }
}

function size() {
  sweep();
  return jobs.size;
}

module.exports = { newId, put, get, size };
