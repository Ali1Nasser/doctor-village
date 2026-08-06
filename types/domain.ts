/**
 * types/domain.ts — every domain entity as a TypeScript type.  [CP-0]
 *
 * Rules this file exists to enforce at COMPILE TIME rather than by review:
 *   C4  money is a branded integer; a plain `number` cannot be passed as money
 *   C6  no data-access function can be called without an identity (AuthContext)
 *   C1b a phone number is never an identity — there is no `phoneE164` on Person
 *
 * Naming: database columns are snake_case, TypeScript is camelCase. The mapping
 * happens once, in lib/db/, and nowhere else.
 */

/* ===========================================================================
   Money — C4, ADR-002
   =========================================================================== */

/** Integer minor units: EGP × 100. Never a float. Never constructed directly. */
export type Piastres = number & { readonly __brand: 'Piastres' };

/** Basis points, 10000 = 100%. Ownership shares are never floats either. */
export type BasisPoints = number & { readonly __brand: 'BasisPoints' };

/** ISO-8601 UTC instant, 'YYYY-MM-DDTHH:MM:SSZ'. */
export type Timestamp = string & { readonly __brand: 'Timestamp' };

/** Calendar date, 'YYYY-MM-DD'. Distinct from Timestamp on purpose. */
export type IsoDate = string & { readonly __brand: 'IsoDate' };

/** E.164, always '+20…'. Only ever produced by the normalizer in lib/phone.ts. */
export type PhoneE164 = string & { readonly __brand: 'PhoneE164' };

/** 26-character ULID. */
export type Id = string & { readonly __brand: 'Id' };

/* ===========================================================================
   Enumerations — mirror the CHECK constraints in migrations/
   =========================================================================== */

export const ROLES = ['developer', 'admin', 'operator', 'resident', 'finance_reviewer'] as const;
export type Role = (typeof ROLES)[number];

/** Nine states. 06_ACCOUNTING_AND_LEDGER.md §3. */
export const PAYMENT_STATUSES = [
  'draft', 'submitted', 'under_review', 'needs_info',
  'approved', 'rejected', 'duplicate', 'cancelled', 'reversed',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** States that contribute to a total. Exactly one. Used by every aggregate. */
export const COUNTED_PAYMENT_STATUSES = ['approved'] as const satisfies readonly PaymentStatus[];

export const PAYMENT_METHODS = ['instapay', 'bank_transfer', 'vodafone_cash', 'cash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type AccountType = 'asset' | 'liability' | 'fund' | 'income' | 'expense';
export type NormalBalance = 'debit' | 'credit';
export type FundKind = 'operating' | 'deposit' | 'reserve';
export type TxnDirection = 'income' | 'expense';

/**
 * `deposit` is a first-class kind precisely so it can never be treated as
 * ordinary income by accident. R-020. The database refuses to map a deposit
 * category to an income account (trg_category_account_kind_ins).
 */
export type CategoryKind = 'operating_income' | 'deposit' | 'contribution' | 'penalty' | 'expense';

export type PeriodStatus = 'open' | 'closed' | 'reopened';
export type DueBasis = 'per_unit' | 'per_sqm';
export type PostType = 'news' | 'announcement' | 'decision' | 'minutes' | 'document';
export type ExpenseStatus = 'recorded' | 'countersigned' | 'posted' | 'reversed';

/* ===========================================================================
   Identity & access
   =========================================================================== */

/**
 * A person. `id` is the ONLY identity and never changes.
 * NOTE the absence of a phone number: it is a mutable attribute living in
 * PhoneIdentifier, with history. C1b / ADR-012. Adding `phoneE164` here would
 * reintroduce exactly the bug ADR-012 exists to prevent.
 */
export interface Person {
  id: Id;
  fullName: string;
  role: Role;
  isActive: boolean;
  preferredChannel: 'whatsapp' | 'sms' | 'none';
  createdBy: Id | null;
  lastLoginAt: Timestamp | null;
  createdAt: Timestamp;
}

export interface PhoneIdentifier {
  id: Id;
  profileId: Id;
  phoneE164: PhoneE164;
  isPrimary: boolean;
  status: 'active' | 'replaced' | 'revoked';
  verifiedAt: Timestamp | null;
  replacedById: Id | null;
  changedBy: Id | null;
  changeReasonAr: string | null;
  validFrom: Timestamp;
  validTo: Timestamp | null;
}

export interface Passkey {
  id: Id;
  profileId: Id;
  credentialId: string;
  /** Public key only. Never a private key, never biometric data. */
  publicKey: Uint8Array;
  signCount: number;
  transports: string[] | null;
  /** The RP-ID this credential is bound to. R-022: a domain move invalidates it. */
  rpId: string;
  deviceLabelAr: string;
  createdAt: Timestamp;
  lastUsedAt: Timestamp | null;
  revokedAt: Timestamp | null;
}

export interface ActivationChallenge {
  id: Id;
  profileId: Id;
  /** Hash only. The plaintext token exists exactly once, in the response body. */
  tokenHash: string;
  purpose: 'first_activation' | 'recovery' | 'new_device';
  channel: 'board_link' | 'whatsapp_inbound' | 'printed' | 'console';
  issuedBy: Id | null;
  attempts: number;
  expiresAt: Timestamp;
  consumedAt: Timestamp | null;
}

export interface Session {
  id: Id;
  profileId: Id;
  /** Set when a delegate is acting for an owner. Logged as "بالنيابة عن". */
  onBehalfOf: Id | null;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
  /** Last fresh passkey re-verification. Elevated actions require this recent. */
  reauthAt: Timestamp | null;
}

/* ===========================================================================
   The identity every data-access function requires — C6
   =========================================================================== */

/**
 * Every function in lib/db/ takes this as its FIRST argument. There is no
 * overload without it, so a missing identity is a compile error rather than a
 * runtime surprise. ADR-010.
 */
export interface AuthContext {
  readonly personId: Id;
  readonly role: Role;
  /** Units the caller owns right now (unit_owners.valid_to IS NULL). */
  readonly ownedUnitIds: readonly Id[];
  /** Units the caller may act on via a live delegate authorization. */
  readonly delegatedUnits: readonly DelegateScope[];
  readonly sessionId: Id;
  readonly reauthAt: Timestamp | null;
}

export interface DelegateScope {
  unitId: Id;
  ownerProfileId: Id;
  canViewFinancials: boolean;
  canSubmitPayments: boolean;
  validTo: IsoDate;
}

/** Deliberately NOT `AuthContext | null` anywhere in lib/db/. */
export type Actor = AuthContext;

/* ===========================================================================
   Community
   =========================================================================== */

export interface Building { id: Id; code: string; nameAr: string | null; sortOrder: number; isActive: boolean }

export interface Unit {
  id: Id;
  buildingId: Id;
  unitNumber: string;
  /** Square CENTIMETRES. Integer, because per-sqm dues multiply into money. */
  areaCm2: number | null;
  /** Admin-only. Never serialized to a resident response. */
  notes?: never;
  isActive: boolean;
}

export interface UnitOwner {
  id: Id;
  unitId: Id;
  profileId: Id;
  shareBp: BasisPoints;
  isPrimaryContact: boolean;
  validFrom: IsoDate;
  /** null = current owner. A sale closes the row; it is never deleted. */
  validTo: IsoDate | null;
}

export interface DelegateAuthorization {
  id: Id;
  ownerProfileId: Id;
  delegateProfileId: Id;
  unitId: Id;
  canViewFinancials: boolean;
  canSubmitPayments: boolean;
  validFrom: IsoDate;
  /** NOT nullable. An authorization with no end date is the R-025 failure. */
  validTo: IsoDate;
  grantedBy: Id;
  revokedAt: Timestamp | null;
}

/* ===========================================================================
   Ledger — 06_ACCOUNTING_AND_LEDGER.md
   =========================================================================== */

export interface Account {
  id: Id; code: string; nameAr: string;
  type: AccountType; normalBalance: NormalBalance; isActive: boolean;
}

export interface Fund {
  id: Id; nameAr: string; kind: FundKind;
  /** A deposit fund is money held in trust and is never spendable. */
  isSpendable: boolean;
}

export interface CostCenter { id: Id; nameAr: string; buildingId: Id | null; isActive: boolean }

export interface FiscalPeriod {
  id: Id; nameAr: string; startsOn: IsoDate; endsOn: IsoDate;
  status: PeriodStatus; closedBy: Id | null; closedAt: Timestamp | null;
  reopenedBy: Id | null; reopenReasonAr: string | null;
}

export interface Category {
  id: Id;
  parentId: Id | null;
  nameAr: string;
  direction: TxnDirection;
  kind: CategoryKind;
  /** The database refuses a deposit kind pointing at an income account. */
  ledgerAccountId: Id;
  defaultFundId: Id | null;
  icon: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface JournalEntry {
  id: Id;
  entryNo: string;
  entryDate: IsoDate;
  periodId: Id;
  descriptionAr: string;
  sourceType: 'payment' | 'expense' | 'adjustment' | 'opening_balance' | 'refund' | 'waiver' | 'reclassification';
  sourceId: Id | null;
  createdBy: Id;
  /** Must differ from createdBy — maker–checker, enforced by trigger. */
  approvedBy: Id | null;
  /** null = draft. Once set, the entry is immutable. */
  postedAt: Timestamp | null;
  isReversal: boolean;
  reversesEntryId: Id | null;
}

export interface JournalLine {
  id: Id;
  entryId: Id;
  lineNo: number;
  accountId: Id;
  fundId: Id | null;
  costCenterId: Id | null;
  /** Exactly one of these is non-zero. Enforced by CHECK. */
  debitPiastres: Piastres;
  creditPiastres: Piastres;
  unitId: Id | null;
  memoAr: string | null;
}

/** A balanced entry, ready to post. The only shape lib/ledger accepts. */
export interface DraftEntry {
  entryDate: IsoDate;
  periodId: Id;
  descriptionAr: string;
  sourceType: JournalEntry['sourceType'];
  sourceId: Id | null;
  lines: readonly DraftLine[];
}

export interface DraftLine {
  accountId: Id;
  fundId: Id | null;
  costCenterId?: Id | null;
  unitId?: Id | null;
  /** Discriminated so a line carrying both sides cannot be constructed. */
  side: 'debit' | 'credit';
  amount: Piastres;
  memoAr?: string;
}

export interface ResidentCredit {
  id: Id; unitId: Id; profileId: Id | null;
  amountPiastres: Piastres;
  sourcePaymentId: Id | null;
  appliedToDueId: Id | null;
  appliedAt: Timestamp | null;
}

export interface Reconciliation {
  id: Id; accountId: Id; periodId: Id; asOf: IsoDate;
  statementBalancePiastres: Piastres;
  bookBalancePiastres: Piastres;
  differencePiastres: Piastres;
  notesAr: string | null;
  doneBy: Id; doneAt: Timestamp;
}

/* ===========================================================================
   Money in / money out
   =========================================================================== */

export interface FeePeriod {
  id: Id; nameAr: string; categoryId: Id; fiscalPeriodId: Id;
  startsOn: IsoDate; endsOn: IsoDate; dueOn: IsoDate;
  basis: DueBasis; amountPiastres: Piastres; isPublished: boolean;
}

export interface UnitDue {
  id: Id; feePeriodId: Id; unitId: Id;
  /** Frozen at generation. Changing the fee later never restates this. */
  amountPiastres: Piastres;
  waivedPiastres: Piastres;
  /** A waiver appears on the statement AS A WAIVER, never as a payment. */
  waiverReasonAr: string | null;
  waivedBy: Id | null;
}

export interface Payment {
  id: Id;
  receiptNo: string;
  unitId: Id;
  submittedBy: Id;
  onBehalfOf: Id | null;
  categoryId: Id;
  feePeriodId: Id | null;
  claimedAmountPiastres: Piastres;
  approvedAmountPiastres: Piastres | null;
  method: PaymentMethod;
  transferDate: IsoDate;
  referenceNo: string | null;
  /** Private object key. NEVER a URL — there are no public object URLs. C6. */
  storageKey: string;
  imageSha256: string | null;
  noteAr: string | null;
  status: PaymentStatus;
  /** UNIQUE in the database: one payment posts at most one entry. Invariant 3. */
  journalEntryId: Id | null;
  reviewedBy: Id | null;
  reviewedAt: Timestamp | null;
  reviewReasonAr: string | null;
  createdAt: Timestamp;
}

/** What a resident may see about ANOTHER unit. No image key, no names. */
export type PaymentPublicView = Pick<Payment, 'id' | 'transferDate' | 'categoryId'> & {
  amountPiastres: Piastres;
};

export interface Expense {
  id: Id; voucherNo: string; categoryId: Id;
  amountPiastres: Piastres; spentOn: IsoDate; descriptionAr: string;
  vendorName: string | null; invoiceStorageKey: string | null;
  fundId: Id | null; costCenterId: Id | null;
  status: ExpenseStatus;
  recordedBy: Id;
  /** Must differ from recordedBy above the threshold. Maker–checker. */
  approvedBy: Id | null;
  journalEntryId: Id | null;
}

export interface StaffMember {
  id: Id;
  /** Admin/operator only — Q4. Absent from StaffPublicView. */
  fullName: string;
  jobTitleAr: string;
  monthlySalaryPiastres: Piastres;
  startedOn: IsoDate | null; endedOn: IsoDate | null; isActive: boolean;
}

/** What every member sees: role and amount, no name. Q4 default. */
export type StaffPublicView = Omit<StaffMember, 'fullName'>;

/* ===========================================================================
   Transparency read models — 06 §7 tiers
   =========================================================================== */

/**
 * The /finance headline. FOUR separate figures, never merged into one
 * "balance" — 04_UX_SPEC §3. The type makes merging them a deliberate act.
 */
export interface CommunityTotals {
  /** (1) الفلوس المتاحة للصرف — cash minus what is owed back to owners. */
  spendablePiastres: Piastres;
  /** (2) الودائع والاحتياطي — أمانات مش ملك القرية. */
  heldInTrustPiastres: Piastres;
  /** (3) إيصالات تحت المراجعة — مش محسوبة في الإيرادات. */
  pendingNotCountedPiastres: Piastres;
  /** (4) المتأخرات المطلوبة. */
  receivablesPiastres: Piastres;
  totalIncomePiastres: Piastres;
  totalExpensePiastres: Piastres;
  /** "آخر مطابقة مع البنك: 31 يوليو ✅" — null means never reconciled. */
  lastReconciledOn: IsoDate | null;
}

export interface UnitBalance {
  unitId: Id; buildingCode: string; unitNumber: string;
  duePiastres: Piastres; paidPiastres: Piastres; outstandingPiastres: Piastres;
}

export interface CategoryTotal { categoryId: Id; nameAr: string; parentId: Id | null; totalPiastres: Piastres }

/** Invariant 12, exposed so /admin/health can assert it continuously. */
export interface AccountingEquation {
  assetsPiastres: Piastres;
  liabilitiesPiastres: Piastres;
  fundsPiastres: Piastres;
  incomePiastres: Piastres;
  expensesPiastres: Piastres;
  /** Must be 0. See the honesty note in migrations/0005_views.sql. */
  residualPiastres: Piastres;
}

/* ===========================================================================
   Content
   =========================================================================== */

export interface Post {
  id: Id; type: PostType; slug: string; titleAr: string; bodyAr: string;
  /** Orthographically folded copy for FTS5 — أ إ آ→ا، ة→ه، ى→ي، tashkeel off.
   *  FTS5's unicode61 tokenizer does NOT do this; verified 2026-08-04. */
  searchBody: string;
  publishedAt: Timestamp | null; isPinned: boolean; authorId: Id;
}

export interface Album {
  id: Id; titleAr: string; descriptionAr: string; happenedOn: IsoDate | null;
  linkedExpenseId: Id | null; publishedAt: Timestamp | null;
  /** R-026: an album cannot publish until a named editor ticks the checklist. */
  safetyCheckedBy: Id | null;
}

export interface AlbumPhoto {
  id: Id; albumId: Id; storageKey: string; captionAr: string | null;
  /** A photo without this flag is never served. R-026. */
  exifStripped: boolean;
}

/* ===========================================================================
   System
   =========================================================================== */

export interface AuditEntry {
  id: Id; actorId: Id | null; actorRole: Role | null; onBehalfOf: Id | null;
  action: string; entityTable: string; entityId: Id | null;
  beforeJson: unknown; afterJson: unknown; createdAt: Timestamp;
}

export interface StorageObject {
  storageKey: string; bucket: string;
  ownerKind: 'payment_receipt' | 'expense_invoice' | 'album_photo' | 'post_attachment' | 'backup' | 'voice_note';
  ownerId: Id;
  /** The scope the file-serving route re-checks on EVERY request. C6. */
  unitId: Id | null;
  sizeBytes: number; sha256: string | null; mime: string; exifStripped: boolean;
}

export interface QuotaSnapshot {
  service: string; metric: string; used: number; limitValue: number;
  pctUsed: number; resetPeriod: 'daily' | 'monthly' | 'none'; capturedAt: Timestamp;
}

/* ===========================================================================
   Epistemic labelling — <grounding>
   =========================================================================== */

/** Applied to any generated statement shown to the owner, so an assumption is
 *  never presented in the same tone as a confirmed requirement. */
export type Grounding =
  | 'confirmed requirement'
  | 'approved decision'
  | 'verified external fact'
  | 'engineering inference'
  | 'temporary assumption'
  | 'open question';
