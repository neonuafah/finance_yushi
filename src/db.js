'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('./config');

let pool = null;
let available = null;
let lastError = null;

function getPool() {
  if (!config.db.enabled) return null;
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      waitForConnections: true,
      connectionLimit: config.db.connectionLimit,
      charset: 'utf8mb4_unicode_ci',
      dateStrings: true,
      timezone: 'Z',
    });
  }
  return pool;
}

/** ตรวจว่าเชื่อมต่อฐานข้อมูลได้หรือไม่ — ระบบยังทำงานต่อได้แม้ DB ล่ม */
async function checkConnection() {
  if (!config.db.enabled) {
    available = false;
    lastError = 'ปิดการใช้งานฐานข้อมูล (DB_ENABLED=false)';
    return { available, error: lastError };
  }
  try {
    const conn = await getPool().getConnection();
    await conn.ping();
    conn.release();
    available = true;
    lastError = null;
  } catch (err) {
    available = false;
    lastError = err.message;
  }
  return { available, error: lastError };
}

function status() {
  return { enabled: config.db.enabled, available, error: lastError };
}

/** สร้างตารางตาม schema.sql (idempotent) */
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  const conn = await getPool().getConnection();
  try {
    for (const stmt of statements) await conn.query(stmt);
  } finally {
    conn.release();
  }
}

/**
 * บันทึกผลการประมวลผลหนึ่งครั้ง
 * ล้มเหลวแล้วไม่โยน error ออกไป — การบันทึกประวัติไม่ควรทำให้ผู้ใช้ใช้งานไม่ได้
 * @returns {Promise<{saved: boolean, error?: string}>}
 */
async function saveJob(job) {
  if (!config.db.enabled) return { saved: false, error: 'ปิดการใช้งานฐานข้อมูล' };
  let conn;
  try {
    conn = await getPool().getConnection();
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO jobs (id, original_name, source_type, file_size, company, report_title, period_line,
         account_code, account_name, opening_balance, reported_closing, computed_closing, entry_count,
         matched_pairs, unmatched_debit_count, unmatched_debit_total, unmatched_credit_count,
         unmatched_credit_total, options_json, warnings_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE
         matched_pairs = VALUES(matched_pairs),
         unmatched_debit_count = VALUES(unmatched_debit_count),
         unmatched_debit_total = VALUES(unmatched_debit_total),
         unmatched_credit_count = VALUES(unmatched_credit_count),
         unmatched_credit_total = VALUES(unmatched_credit_total),
         computed_closing = VALUES(computed_closing),
         options_json = VALUES(options_json)`,
      [
        job.id,
        job.originalName,
        job.sourceType,
        job.fileSize || 0,
        job.meta.company || null,
        job.meta.reportTitle || null,
        job.meta.periodLine || null,
        job.meta.accountCode || null,
        job.meta.accountName || null,
        job.meta.openingBalance || 0,
        job.meta.reportedClosingBalance,
        job.closingBalance,
        job.totals.entryCount,
        job.totals.matchedPairs,
        job.totals.unmatchedDebitCount,
        job.totals.unmatchedDebitTotal,
        job.totals.unmatchedCreditCount,
        job.totals.unmatchedCreditTotal,
        JSON.stringify(job.options),
        JSON.stringify(job.warnings || []),
      ],
    );

    await conn.query('DELETE FROM entries WHERE job_id = ?', [job.id]);
    await conn.query('DELETE FROM matches WHERE job_id = ?', [job.id]);

    const entryRows = job.rows.map((r) => [
      job.id,
      r.lineNo,
      r.date,
      r.dateDisplay,
      r.book,
      r.voucher,
      r.description.slice(0, 512),
      r.debit,
      r.credit,
      r.status,
      r.reportedBalance,
      r.side,
      r.remaining,
      r.matchState,
    ]);
    await insertBatched(
      conn,
      `INSERT INTO entries (job_id, line_no, entry_date, date_display, book, voucher, description,
         debit, credit, status, reported_balance, side, remaining, match_state) VALUES ?`,
      entryRows,
    );

    const matchRows = job.pairs.map((m) => [
      job.id,
      m.debitLine,
      m.creditLine,
      m.amount,
      m.strategy,
      m.confidence,
    ]);
    await insertBatched(
      conn,
      'INSERT INTO matches (job_id, debit_line, credit_line, amount, strategy, confidence) VALUES ?',
      matchRows,
    );

    await conn.commit();
    available = true;
    return { saved: true };
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    available = false;
    lastError = err.message;
    return { saved: false, error: err.message };
  } finally {
    if (conn) conn.release();
  }
}

/** แทรกทีละก้อนเพื่อไม่ให้ชน max_allowed_packet */
async function insertBatched(conn, sql, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    if (chunk.length) await conn.query(sql, [chunk]);
  }
}

async function listJobs(limit = 30) {
  if (!config.db.enabled) return [];
  const [rows] = await getPool().query(
    `SELECT id, original_name, source_type, account_code, account_name, opening_balance,
            computed_closing, entry_count, matched_pairs, unmatched_debit_count,
            unmatched_debit_total, unmatched_credit_count, unmatched_credit_total, created_at
       FROM jobs ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
  return rows;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, checkConnection, status, migrate, saveJob, listJobs, close };
