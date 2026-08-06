-- =============================================================================
-- seed/prod/001_chart_of_accounts.sql
--
-- ⛔ LAUNCH BLOCKER — DO NOT LOAD INTO PRODUCTION UNTIL BOTH ARE TRUE:
--    [ ] a qualified accountant has signed off this chart AND the الوديعة
--        treatment in writing                                        (Q15, CP-8)
--    [ ] the board has approved the category taxonomy in writing      (CP-0 gate)
--
-- grounding: the account names and the category taxonomy come from
-- 06_ACCOUNTING_AND_LEDGER.md §2 and 02_DATA_MODEL.md §3, which the owner
-- supplied — `confirmed requirement`.
-- The account CODES and the category→account mapping are `engineering
-- inference`: a standard 1/2/3/4/5 chart. An accountant may renumber them.
-- No AMOUNTS appear in this file. Not one. Any figure would be invented. (C10)
-- =============================================================================

-- ---------------------------------------------------------------- ASSETS 1xxx
INSERT INTO accounts (id, code, name_ar, type, normal_balance, sort_order) VALUES
 ('ACC00000000000000000001101','1101','الخزنة النقدية',        'asset','debit',10),
 ('ACC00000000000000000001102','1102','الحساب البنكي',          'asset','debit',20),
 ('ACC00000000000000000001103','1103','محفظة إنستا باي',        'asset','debit',30),
 ('ACC00000000000000000001104','1104','محفظة فودافون كاش',      'asset','debit',40),
 -- 13xx = receivables. v_community_totals EXCLUDES 13% from spendable cash,
 -- because money owed to us is not money we can spend.
 ('ACC00000000000000000001301','1301','مستحقات على الملاك',     'asset','debit',50);

-- ----------------------------------------------------------- LIABILITIES 2xxx
-- ⭐ الوديعة lives HERE, never in 4xxx. R-020. The categories table cannot map
--    a deposit category anywhere else — trg_category_account_kind_ins.
INSERT INTO accounts (id, code, name_ar, type, normal_balance, sort_order) VALUES
 ('ACC00000000000000000002101','2101','ودائع مستردة',           'liability','credit',10),
 ('ACC00000000000000000002102','2102','أرصدة دائنة للملاك',     'liability','credit',20),
 ('ACC00000000000000000002103','2103','مستحقات موردين',         'liability','credit',30);

-- ------------------------------------------------------- FUNDS / EQUITY 3xxx
INSERT INTO accounts (id, code, name_ar, type, normal_balance, sort_order) VALUES
 ('ACC00000000000000000003101','3101','رصيد أول المدة',         'fund','credit',10),
 ('ACC00000000000000000003102','3102','احتياطي الصيانة',        'fund','credit',20),
 ('ACC00000000000000000003103','3103','احتياطي الطوارئ',        'fund','credit',30);

-- ---------------------------------------------------------------- INCOME 4xxx
INSERT INTO accounts (id, code, name_ar, type, normal_balance, sort_order) VALUES
 ('ACC00000000000000000004101','4101','اشتراك الصيانة السنوي',  'income','credit',10),
 ('ACC00000000000000000004102','4102','مساهمات خاصة',           'income','credit',20),
 ('ACC00000000000000000004103','4103','غرامات تأخير',           'income','credit',30),
 ('ACC00000000000000000004199','4199','إيرادات أخرى',           'income','credit',90);

-- -------------------------------------------------------------- EXPENSES 5xxx
INSERT INTO accounts (id, code, name_ar, type, normal_balance, sort_order) VALUES
 ('ACC00000000000000000005101','5101','مصروفات — الصيانة',              'expense','debit',10),
 ('ACC00000000000000000005201','5201','مصروفات — المياه',               'expense','debit',20),
 ('ACC00000000000000000005301','5301','مصروفات — مرتبات العمالة',       'expense','debit',30),
 ('ACC00000000000000000005401','5401','مصروفات — الأمن والحراسة',       'expense','debit',40),
 ('ACC00000000000000000005501','5501','مصروفات — النظافة ورفع المخلفات','expense','debit',50),
 ('ACC00000000000000000005601','5601','مصروفات — المساحات الخضراء',     'expense','debit',60),
 ('ACC00000000000000000005701','5701','مصروفات — حمام السباحة',         'expense','debit',70),
 ('ACC00000000000000000005801','5801','مصروفات — الكهرباء (عداد عام)',  'expense','debit',80),
 ('ACC00000000000000000005901','5901','مصروفات — إدارية ورسوم حكومية',  'expense','debit',90),
 ('ACC00000000000000000005951','5951','مصروفات — الطوارئ',              'expense','debit',95),
 ('ACC00000000000000000005999','5999','مصروفات — أخرى',                 'expense','debit',99);

-- --------------------------------------------------------------------- FUNDS
-- The dimension that keeps "الفلوس المتاحة للصرف" honest on every dashboard.
INSERT INTO funds (id, name_ar, kind, is_spendable) VALUES
 ('FND00000000000000000000001','الصندوق التشغيلي','operating',1),
 ('FND00000000000000000000002','صندوق الودائع',   'deposit',  0),
 ('FND00000000000000000000003','احتياطي الصيانة', 'reserve',  0),
 ('FND00000000000000000000004','احتياطي الطوارئ', 'reserve',  0);
