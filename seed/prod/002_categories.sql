-- =============================================================================
-- seed/prod/002_categories.sql — the category taxonomy
--
-- Source: 00_MASTER_PROMPT <financial_domain_rules> and 02_DATA_MODEL.md §3,
-- which name the community's real structure — `confirmed requirement`.
-- Awaiting the owner's written approval (CP-0 gate). Admins can add, rename,
-- deactivate and reorder afterwards; NO category id is ever hardcoded in
-- application logic.
--
-- The `kind` column is what makes R-020 impossible: 'وديعة' is kind='deposit',
-- and a deposit category cannot be mapped to an income account.
-- =============================================================================

-- ------------------------------------------------------------ INCOME (إيرادات)
INSERT INTO categories (id, parent_id, name_ar, direction, kind, ledger_account_id, default_fund_id, icon, sort_order) VALUES
 ('CAT0000000000000000000IN01', NULL,'اشتراك الصيانة السنوي','income','operating_income',
   'ACC00000000000000000004101','FND00000000000000000000001','receipt',10),

 -- ⭐ الوديعة — a LIABILITY. Residents call it a payment; it is money held in
 -- trust and is shown separately from spendable funds on every dashboard.
 -- Treatment pending accountant confirmation (Q14 / Q15).
 ('CAT0000000000000000000IN02', NULL,'وديعة','income','deposit',
   'ACC00000000000000000002101','FND00000000000000000000002','lock',20),

 ('CAT0000000000000000000IN03', NULL,'مساهمات خاصة','income','contribution',
   'ACC00000000000000000004102','FND00000000000000000000001','hand-coins',30),
 ('CAT0000000000000000000IN04', NULL,'غرامات تأخير','income','penalty',
   'ACC00000000000000000004103','FND00000000000000000000001','alarm-clock',40),
 ('CAT0000000000000000000IN99', NULL,'إيرادات أخرى','income','operating_income',
   'ACC00000000000000000004199','FND00000000000000000000001','circle-ellipsis',90);

-- --------------------------------------------------------- EXPENSES (مصروفات)
-- Parents
INSERT INTO categories (id, parent_id, name_ar, direction, kind, ledger_account_id, default_fund_id, icon, sort_order) VALUES
 ('CAT0000000000000000000EX01', NULL,'الصيانة','expense','expense',
   'ACC00000000000000000005101','FND00000000000000000000001','wrench',10),
 ('CAT0000000000000000000EX02', NULL,'المياه','expense','expense',
   'ACC00000000000000000005201','FND00000000000000000000001','droplets',20),
 ('CAT0000000000000000000EX03', NULL,'مرتبات العمالة','expense','expense',
   'ACC00000000000000000005301','FND00000000000000000000001','users',30),
 ('CAT0000000000000000000EX04', NULL,'الأمن والحراسة','expense','expense',
   'ACC00000000000000000005401','FND00000000000000000000001','shield',40),
 ('CAT0000000000000000000EX05', NULL,'النظافة ورفع المخلفات','expense','expense',
   'ACC00000000000000000005501','FND00000000000000000000001','trash-2',50),
 ('CAT0000000000000000000EX06', NULL,'المساحات الخضراء والزراعة','expense','expense',
   'ACC00000000000000000005601','FND00000000000000000000001','trees',60),
 ('CAT0000000000000000000EX07', NULL,'حمام السباحة','expense','expense',
   'ACC00000000000000000005701','FND00000000000000000000001','waves',70),
 ('CAT0000000000000000000EX08', NULL,'الكهرباء (عداد عام)','expense','expense',
   'ACC00000000000000000005801','FND00000000000000000000001','zap',80),
 ('CAT0000000000000000000EX09', NULL,'مصروفات إدارية ورسوم حكومية','expense','expense',
   'ACC00000000000000000005901','FND00000000000000000000001','file-text',90),
 ('CAT0000000000000000000EX10', NULL,'الطوارئ','expense','expense',
   'ACC00000000000000000005951','FND00000000000000000000004','siren',95),
 ('CAT0000000000000000000EX99', NULL,'أخرى','expense','expense',
   'ACC00000000000000000005999','FND00000000000000000000001','circle-ellipsis',99);

-- Children — one level of nesting only.
-- "صيانة" alone answers nothing; "صيانة ← كهرباء" answers what a resident asks.
INSERT INTO categories (id, parent_id, name_ar, direction, kind, ledger_account_id, default_fund_id, sort_order) VALUES
 ('CAT0000000000000000000E101','CAT0000000000000000000EX01','لمبات وإضاءة','expense','expense',
   'ACC00000000000000000005101','FND00000000000000000000001',11),
 ('CAT0000000000000000000E102','CAT0000000000000000000EX01','أعمال كهربائية — مفاتيح ومواتير','expense','expense',
   'ACC00000000000000000005101','FND00000000000000000000001',12),
 ('CAT0000000000000000000E103','CAT0000000000000000000EX01','سباكة','expense','expense',
   'ACC00000000000000000005101','FND00000000000000000000001',13),
 ('CAT0000000000000000000E104','CAT0000000000000000000EX01','دهانات وترميم','expense','expense',
   'ACC00000000000000000005101','FND00000000000000000000001',14),
 ('CAT0000000000000000000E105','CAT0000000000000000000EX01','مصاعد','expense','expense',
   'ACC00000000000000000005101','FND00000000000000000000001',15),
 ('CAT0000000000000000000E201','CAT0000000000000000000EX02','عربات مياه حلوة','expense','expense',
   'ACC00000000000000000005201','FND00000000000000000000001',21),
 ('CAT0000000000000000000E202','CAT0000000000000000000EX02','مياه استخدام','expense','expense',
   'ACC00000000000000000005201','FND00000000000000000000001',22);

-- =============================================================================
-- NOT SEEDED, DELIBERATELY — every one of these would be invented data (C10):
--   · fee_periods       — the subscription amount is Q2, unanswered
--   · unit_dues         — depends on Q1 (buildings/units) and Q2
--   · buildings / units — depends on Q1 and the owner's register
--   · settings bank / InstaPay details — Q13
--   · staff names and salaries — the owner's records
-- Each is tracked in docs/OPEN_QUESTIONS.md. Demo values live ONLY in
-- seed/demo/ and the loader refuses to run against a production database.
-- =============================================================================
