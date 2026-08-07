'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const config = require('../config');
const store = require('../store');
const db = require('../db');
const { parseExcel } = require('../parsers/excel');
const { parsePdf } = require('../parsers/pdf');
const { matchEntries, withRunningBalance, STRATEGIES, defaultOptions } = require('../matcher');
const { exportExcel } = require('../exporters/excel');
const { exportPdf } = require('../exporters/pdf');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xlsm', '.pdf'].includes(ext)) return cb(null, true);
    cb(new Error('รองรับเฉพาะไฟล์ .xlsx, .xlsm และ .pdf'));
  },
});

const router = express.Router();

/** ตัวเลือกการจับคู่จาก body — รับเฉพาะคีย์ที่รู้จัก */
function readOptions(input) {
  const opts = defaultOptions();
  if (!input || typeof input !== 'object') return opts;
  for (const s of STRATEGIES) {
    if (s.key in input) opts[s.key] = Boolean(input[s.key]);
  }
  return opts;
}

/** ประกอบผลลัพธ์ที่ส่งกลับให้หน้าเว็บ (ตัดฟิลด์ภายในที่ไม่ได้ใช้ออก) */
function toResponse(job) {
  const { rows: outstanding, closingBalance } = withRunningBalance(job.meta.openingBalance, job.outstanding);
  return {
    jobId: job.id,
    originalName: job.originalName,
    sourceType: job.sourceType,
    meta: {
      company: job.meta.company,
      reportTitle: job.meta.reportTitle,
      periodLine: job.meta.periodLine,
      accountLine: job.meta.accountLine,
      accountCode: job.meta.accountCode,
      accountName: job.meta.accountName,
      openingBalance: job.meta.openingBalance,
      reportedClosingBalance: job.meta.reportedClosingBalance,
      pages: job.meta.pages,
    },
    options: job.options,
    totals: job.totals,
    closingBalance,
    balanceCheckOk:
      job.meta.reportedClosingBalance === null ||
      job.meta.reportedClosingBalance === undefined ||
      Math.abs(job.meta.reportedClosingBalance - closingBalance) < 0.005,
    warnings: job.warnings,
    dbSaved: job.dbSaved,
    dbError: job.dbError,
    outstanding: outstanding.map(slimOutstanding),
    unmatchedDebits: job.unmatchedDebits.map(slimOutstanding),
    unmatchedCredits: job.unmatchedCredits.map(slimOutstanding),
    zeroRows: job.zeroRows.map(slimOutstanding),
    pairs: job.pairs,
  };
}

function slimOutstanding(r) {
  return {
    lineNo: r.lineNo,
    dateDisplay: r.dateDisplay,
    book: r.book,
    voucher: r.voucher,
    description: r.description,
    side: r.side,
    originalAmount: r.originalAmount,
    matchedAmount: r.matchedAmount,
    remaining: r.remaining,
    matchState: r.matchState,
    runningBalance: r.runningBalance ?? null,
    voucherRefs: r.voucherRefs,
    jobRefs: r.jobRefs,
  };
}

/** ประมวลผลรายการที่แยกไว้แล้วด้วยตัวเลือกที่กำหนด แล้วเก็บผลลง store + MySQL */
async function runMatch(job, options) {
  const result = matchEntries(job.entries, options);
  const { closingBalance } = withRunningBalance(job.meta.openingBalance, result.outstanding);

  Object.assign(job, {
    options: result.options,
    rows: result.rows,
    outstanding: result.outstanding,
    unmatchedDebits: result.unmatchedDebits,
    unmatchedCredits: result.unmatchedCredits,
    zeroRows: result.zeroRows,
    pairs: result.pairs,
    totals: result.totals,
    closingBalance,
  });

  const saved = await db.saveJob(job);
  job.dbSaved = saved.saved;
  job.dbError = saved.error || null;
  return job;
}

router.get('/strategies', (req, res) => {
  res.json({ strategies: STRATEGIES, defaults: defaultOptions() });
});

router.get('/health', async (req, res) => {
  const dbStatus = await db.checkConnection();
  res.json({ ok: true, db: dbStatus, cachedJobs: store.size(), env: config.env });
});

router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์ก่อน' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const sourceType = ext === '.pdf' ? 'pdf' : 'excel';

    let parsed;
    try {
      parsed = sourceType === 'pdf' ? await parsePdf(req.file.buffer) : await parseExcel(req.file.buffer);
    } catch (err) {
      return res.status(422).json({ error: `อ่านไฟล์ไม่สำเร็จ: ${err.message}` });
    }

    let options;
    try {
      options = readOptions(req.body.options ? JSON.parse(req.body.options) : null);
    } catch {
      options = defaultOptions();
    }

    const job = store.put({
      id: store.newId(),
      originalName: req.file.originalname,
      sourceType,
      fileSize: req.file.size,
      meta: parsed.meta,
      entries: parsed.entries,
      warnings: parsed.warnings,
    });

    await runMatch(job, options);
    res.json(toResponse(job));
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:id/rematch', express.json(), async (req, res, next) => {
  try {
    const job = store.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'ไม่พบผลลัพธ์ (อาจหมดอายุแล้ว) กรุณาอัปโหลดไฟล์ใหม่' });
    await runMatch(job, readOptions(req.body && req.body.options));
    res.json(toResponse(job));
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:id', (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'ไม่พบผลลัพธ์ (อาจหมดอายุแล้ว)' });
  res.json(toResponse(job));
});

router.get('/jobs/:id/export', async (req, res, next) => {
  try {
    const job = store.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'ไม่พบผลลัพธ์ (อาจหมดอายุแล้ว) กรุณาอัปโหลดไฟล์ใหม่' });

    const format = String(req.query.format || 'xlsx').toLowerCase();
    const stem = sanitizeStem(job.originalName);

    if (format === 'pdf') {
      const buf = await exportPdf(job);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition(`${stem}-ยังไม่มีคู่.pdf`));
      return res.send(buf);
    }
    if (format === 'xlsx') {
      const buf = await exportExcel(job);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', contentDisposition(`${stem}-ยังไม่มีคู่.xlsx`));
      return res.send(buf);
    }
    return res.status(400).json({ error: 'รูปแบบไฟล์ต้องเป็น xlsx หรือ pdf' });
  } catch (err) {
    next(err);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    if (!config.db.enabled) return res.json({ enabled: false, jobs: [] });
    const rows = await db.listJobs(30);
    res.json({ enabled: true, jobs: rows });
  } catch (err) {
    res.json({ enabled: true, jobs: [], error: err.message });
  }
});

function sanitizeStem(name) {
  return path.basename(name, path.extname(name)).replace(/[\\/:*?"<>|]/g, '').trim() || 'report';
}

/** ชื่อไฟล์ภาษาไทยต้องส่งเป็น RFC 5987 ควบคู่กับชื่อ ASCII สำรอง */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

module.exports = router;
