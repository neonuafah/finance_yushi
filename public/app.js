'use strict';

/* หน้าเว็บจับคู่เงินทดลองจ่าย — เรียก API ที่ path เดียวกับหน้านี้ (รองรับการ mount ใต้ path ย่อยของ Plesk) */

/**
 * รากของ API = โฟลเดอร์ของหน้านี้ + "api/"
 * รองรับทั้งกรณี /finance/ , /finance (ไม่มี slash ท้าย) และ /finance/index.html
 */
const API = (() => {
  const url = new URL(window.location.href);
  let dir = url.pathname;
  if (!dir.endsWith('/')) {
    const last = dir.slice(dir.lastIndexOf('/') + 1);
    dir = last.includes('.') ? dir.slice(0, dir.lastIndexOf('/') + 1) : dir + '/';
  }
  return new URL(dir + 'api/', url.origin).toString();
})();

const $ = (sel) => document.querySelector(sel);
const el = {
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  browseBtn: $('#browseBtn'),
  fileInfo: $('#fileInfo'),
  runBtn: $('#runBtn'),
  uploadStatus: $('#uploadStatus'),
  results: $('#results'),
  reportMeta: $('#reportMeta'),
  statGrid: $('#statGrid'),
  balanceCheck: $('#balanceCheck'),
  warnings: $('#warnings'),
  dlExcel: $('#dlExcel'),
  dlPdf: $('#dlPdf'),
  dataTable: $('#dataTable'),
  tableSearch: $('#tableSearch'),
  tableEmpty: $('#tableEmpty'),
  footer: $('#footer'),
};

const state = {
  file: null,
  strategies: [],
  result: null,
  tab: 'debits',
  busy: false,
};

const money = (n) => {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '';
  const s = Math.abs(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};
const moneyAlways = (n) => money(n) || '0.00';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- เกณฑ์การจับคู่ ---------------- */

/**
 * หน้าเว็บไม่ให้เลือกเกณฑ์ — ใช้ค่าเริ่มต้นของเซิร์ฟเวอร์เสมอ
 * ที่ดึงรายการเกณฑ์มาก็เพื่อเอาชื่อไปแสดงในตาราง "คู่ที่จับได้" เท่านั้น
 */
async function loadStrategies() {
  try {
    const res = await fetch(API + 'strategies');
    const data = await res.json();
    state.strategies = data.strategies;
  } catch {
    state.strategies = []; // ไม่มีชื่อเกณฑ์ก็แสดงเป็นรหัสแทน ไม่กระทบการใช้งาน
  }
}

/* ---------------- เลือกไฟล์ ---------------- */

function setFile(file) {
  if (!file) return;
  const ok = /\.(xlsx|xlsm|pdf)$/i.test(file.name);
  if (!ok) {
    el.uploadStatus.textContent = 'รองรับเฉพาะไฟล์ .xlsx และ .pdf';
    el.uploadStatus.className = 'status error';
    return;
  }
  state.file = file;
  el.fileInfo.hidden = false;
  el.fileInfo.innerHTML = `<span><strong>${esc(file.name)}</strong></span><span class="muted">${(file.size / 1024).toFixed(0)} KB</span>`;
  el.runBtn.disabled = false;
  el.uploadStatus.textContent = '';
  el.uploadStatus.className = 'status';
}

el.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });
el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
el.fileInput.addEventListener('change', () => setFile(el.fileInput.files[0]));

['dragenter', 'dragover'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add('over'); }),
);
['dragleave', 'drop'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove('over'); }),
);
el.dropzone.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));

/* ---------------- ประมวลผล ---------------- */

function setBusy(busy, message) {
  state.busy = busy;
  el.runBtn.disabled = busy || !state.file;
  el.uploadStatus.textContent = message || '';
  el.uploadStatus.className = busy ? 'status busy' : 'status';
}

el.runBtn.addEventListener('click', async () => {
  if (!state.file || state.busy) return;
  setBusy(true, 'กำลังอ่านไฟล์และจับคู่รายการ');
  try {
    const form = new FormData();
    form.append('file', state.file);
    const res = await fetch(API + 'upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ประมวลผลไม่สำเร็จ');
    state.result = data;
    render();
    setBusy(false, '');
    el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setBusy(false, '');
    el.uploadStatus.textContent = err.message;
    el.uploadStatus.className = 'status error';
  }
});

/* ---------------- แสดงผล ---------------- */

function render() {
  const r = state.result;
  el.results.hidden = false;

  el.reportMeta.innerHTML = [
    r.meta.company ? `<strong>${esc(r.meta.company)}</strong>` : '',
    esc(r.meta.periodLine),
    r.meta.accountCode ? `บัญชี ${esc(r.meta.accountCode)} ${esc(r.meta.accountName || '')}` : '',
    `แหล่งข้อมูล: ${esc(r.originalName)} (${r.sourceType === 'pdf' ? 'PDF' : 'Excel'})`,
  ].filter(Boolean).join('<br>');

  const t = r.totals;
  el.statGrid.innerHTML = [
    stat('รายการทั้งหมด', String(t.entryCount), `เดบิต ${t.debitCount} · เครดิต ${t.creditCount}`),
    stat('จับคู่ได้', `${t.matchedPairs} คู่`, `รวม ${moneyAlways(t.matchedAmount)} บาท`),
    stat('เดบิตที่ยังไม่มีคู่', moneyAlways(t.unmatchedDebitTotal), `${t.unmatchedDebitCount} รายการ`, true),
    stat('เครดิตที่ไม่มีคู่', moneyAlways(t.unmatchedCreditTotal), `${t.unmatchedCreditCount} รายการ`),
    stat('ยอดยกมา', moneyAlways(r.meta.openingBalance), ''),
    stat('ยอดคงเหลือใหม่', moneyAlways(r.closingBalance), 'หลังตัดรายการที่จับคู่แล้ว', true),
  ].join('');

  const reported = r.meta.reportedClosingBalance;
  if (reported === null || reported === undefined) {
    el.balanceCheck.className = 'balance-check ok';
    el.balanceCheck.textContent = `ยอดคงเหลือที่คำนวณใหม่ ${moneyAlways(r.closingBalance)} บาท`;
  } else if (r.balanceCheckOk) {
    el.balanceCheck.className = 'balance-check ok';
    el.balanceCheck.textContent =
      `ตรวจสอบผ่าน — ยอดคงเหลือที่คำนวณใหม่ (${moneyAlways(r.closingBalance)}) ` +
      `ตรงกับยอดคงเหลือท้ายรายงานต้นฉบับ รายการที่จับคู่แล้วหักล้างกันพอดี`;
  } else {
    el.balanceCheck.className = 'balance-check bad';
    el.balanceCheck.textContent =
      `ยอดคงเหลือที่คำนวณใหม่ (${moneyAlways(r.closingBalance)}) ` +
      `ไม่ตรงกับยอดท้ายรายงานต้นฉบับ (${moneyAlways(reported)}) กรุณาตรวจสอบไฟล์ต้นฉบับ`;
  }

  el.warnings.innerHTML = (r.warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join('') +
    (r.dbSaved === false && r.dbError ? `<div class="warn">บันทึกประวัติลงฐานข้อมูลไม่สำเร็จ: ${esc(r.dbError)} (ผลลัพธ์และการดาวน์โหลดยังใช้งานได้ตามปกติ)</div>` : '');

  el.dlExcel.href = `${API}jobs/${r.jobId}/export?format=xlsx`;
  el.dlPdf.href = `${API}jobs/${r.jobId}/export?format=pdf`;

  $('#cntDebits').textContent = r.unmatchedDebits.length;
  $('#cntCredits').textContent = r.unmatchedCredits.length;
  $('#cntPairs').textContent = r.pairs.length;

  el.footer.textContent = `ผลลัพธ์ถูกเก็บไว้ชั่วคราวเพื่อดาวน์โหลด · รหัสงาน ${r.jobId.slice(0, 8)}`;

  renderTable();
}

function stat(label, value, sub, hi) {
  return `<div class="stat${hi ? ' hi' : ''}">
    <div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>
    ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
  </div>`;
}

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.tab = tab.dataset.tab;
    renderTable();
  }),
);

el.tableSearch.addEventListener('input', renderTable);

const TABLES = {
  debits: {
    head: ['บรรทัด', 'วันที่', 'สมุด', 'ใบสำคัญ', 'คำอธิบาย', 'ยอดเต็ม', 'เคลียร์แล้ว', 'คงเหลือ', 'สถานะ'],
    numCols: [0, 5, 6, 7],
    rows: (r) => r.unmatchedDebits,
    cells: (x) => [
      cell(x.lineNo, 'num'), cell(x.dateDisplay, 'mono'), cell(x.book), cell(x.voucher, 'mono'),
      cell(x.description, 'desc'), cell(moneyAlways(x.originalAmount), 'num'),
      cell(money(x.matchedAmount), 'num'), cell(moneyAlways(x.remaining), 'num'),
      `<td>${pill(x.matchState)}</td>`,
    ],
    partial: (x) => x.matchState === 'จับคู่บางส่วน',
  },
  credits: {
    head: ['บรรทัด', 'วันที่', 'สมุด', 'ใบสำคัญ', 'คำอธิบาย', 'ยอดเต็ม', 'เคลียร์แล้ว', 'คงเหลือ', 'อ้างถึง'],
    numCols: [0, 5, 6, 7],
    rows: (r) => r.unmatchedCredits,
    cells: (x) => [
      cell(x.lineNo, 'num'), cell(x.dateDisplay, 'mono'), cell(x.book), cell(x.voucher, 'mono'),
      cell(x.description, 'desc'), cell(moneyAlways(x.originalAmount), 'num'),
      cell(money(x.matchedAmount), 'num'), cell(moneyAlways(x.remaining), 'num'),
      cell([...(x.voucherRefs || []).filter((v) => v !== x.voucher), ...(x.jobRefs || [])].join(' ') || '—', 'mono'),
    ],
    partial: (x) => x.matchState === 'จับคู่บางส่วน',
  },
  pairs: {
    head: ['จำนวนเงิน', 'เดบิต (จ่ายเงิน)', 'เครดิต (เคลียร์)', 'เกณฑ์'],
    numCols: [0],
    rows: (r) => r.pairs,
    cells: (x) => [
      cell(moneyAlways(x.amount), 'num'),
      `<td class="desc">${esc(x.debit.dateDisplay)} <b>${esc(x.debit.voucher)}</b><br><span class="muted">${esc(x.debit.description)}</span></td>`,
      `<td class="desc">${esc(x.credit.dateDisplay)} <b>${esc(x.credit.voucher)}</b><br><span class="muted">${esc(x.credit.description)}</span></td>`,
      `<td>${pill(strategyLabel(x.strategy), x.confidence >= 80 ? 'okpill' : 'warnpill')}</td>`,
    ],
    partial: () => false,
  },
  preview: {
    head: ['วันที่', 'สมุด', 'ใบสำคัญ', 'คำอธิบาย', 'เดบิต', 'เครดิต', 'สถานะ', 'ยอดคงเหลือ'],
    numCols: [4, 5, 7],
    rows: (r) => r.outstanding,
    cells: (x) => [
      cell(x.dateDisplay, 'mono'), cell(x.book), cell(x.voucher, 'mono'), cell(x.description, 'desc'),
      cell(x.side === 'debit' ? moneyAlways(x.remaining) : '', 'num'),
      cell(x.side === 'credit' ? moneyAlways(x.remaining) : '', 'num'),
      cell(x.matchState === 'จับคู่บางส่วน' ? 'บางส่วน' : ''),
      cell(moneyAlways(x.runningBalance), 'num'),
    ],
    partial: (x) => x.matchState === 'จับคู่บางส่วน',
  },
};

function cell(value, cls) {
  return `<td${cls ? ` class="${cls}"` : ''}>${esc(value)}</td>`;
}
function pill(text, cls) {
  return `<span class="pill${cls ? ' ' + cls : ''}">${esc(text)}</span>`;
}
function strategyLabel(key) {
  const s = state.strategies.find((x) => x.key === key);
  return s ? s.label : key;
}

function renderTable() {
  if (!state.result) return;
  const conf = TABLES[state.tab];
  const q = el.tableSearch.value.trim().toLowerCase();
  let rows = conf.rows(state.result);

  if (q) {
    rows = rows.filter((x) => JSON.stringify(x).toLowerCase().includes(q));
  }

  el.dataTable.querySelector('thead').innerHTML =
    `<tr>${conf.head.map((h, i) => `<th${conf.numCols.includes(i) ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr>`;
  el.dataTable.querySelector('tbody').innerHTML = rows
    .map((x) => `<tr${conf.partial(x) ? ' class="partial"' : ''}>${conf.cells(x).join('')}</tr>`)
    .join('');

  el.tableEmpty.hidden = rows.length > 0;
  el.dataTable.hidden = rows.length === 0;
}

loadStrategies();
