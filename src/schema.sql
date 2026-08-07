-- โครงสร้างฐานข้อมูลสำหรับระบบจับคู่เงินทดรองจ่าย
-- ใช้กับ MySQL 5.7+ / MariaDB 10.2+ (Plesk)

CREATE TABLE IF NOT EXISTS jobs (
  id                     CHAR(32)     NOT NULL PRIMARY KEY,
  original_name          VARCHAR(255) NOT NULL,
  source_type            ENUM('excel','pdf') NOT NULL,
  file_size              INT UNSIGNED NOT NULL DEFAULT 0,
  company                VARCHAR(255) NULL,
  report_title           VARCHAR(255) NULL,
  period_line            VARCHAR(255) NULL,
  account_code           VARCHAR(32)  NULL,
  account_name           VARCHAR(255) NULL,
  opening_balance        DECIMAL(18,2) NOT NULL DEFAULT 0,
  reported_closing       DECIMAL(18,2) NULL,
  computed_closing       DECIMAL(18,2) NULL,
  entry_count            INT UNSIGNED NOT NULL DEFAULT 0,
  matched_pairs          INT UNSIGNED NOT NULL DEFAULT 0,
  unmatched_debit_count  INT UNSIGNED NOT NULL DEFAULT 0,
  unmatched_debit_total  DECIMAL(18,2) NOT NULL DEFAULT 0,
  unmatched_credit_count INT UNSIGNED NOT NULL DEFAULT 0,
  unmatched_credit_total DECIMAL(18,2) NOT NULL DEFAULT 0,
  options_json           TEXT         NULL,
  warnings_json          TEXT         NULL,
  created_at             DATETIME     NOT NULL,
  INDEX idx_jobs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS entries (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id        CHAR(32)      NOT NULL,
  line_no       INT UNSIGNED  NOT NULL,
  entry_date    DATE          NULL,
  date_display  VARCHAR(16)   NULL,
  book          VARCHAR(64)   NULL,
  voucher       VARCHAR(32)   NULL,
  description   VARCHAR(512)  NULL,
  debit         DECIMAL(18,2) NOT NULL DEFAULT 0,
  credit        DECIMAL(18,2) NOT NULL DEFAULT 0,
  status        VARCHAR(16)   NULL,
  reported_balance DECIMAL(18,2) NULL,
  side          ENUM('debit','credit','other') NOT NULL,
  remaining     DECIMAL(18,2) NOT NULL DEFAULT 0,
  match_state   VARCHAR(24)   NOT NULL,
  CONSTRAINT fk_entries_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE KEY uq_entries_line (job_id, line_no),
  INDEX idx_entries_voucher (job_id, voucher),
  INDEX idx_entries_state (job_id, match_state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS matches (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id      CHAR(32)      NOT NULL,
  debit_line  INT UNSIGNED  NOT NULL,
  credit_line INT UNSIGNED  NOT NULL,
  amount      DECIMAL(18,2) NOT NULL,
  strategy    VARCHAR(32)   NOT NULL,
  confidence  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  CONSTRAINT fk_matches_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  INDEX idx_matches_job (job_id),
  INDEX idx_matches_debit (job_id, debit_line)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
