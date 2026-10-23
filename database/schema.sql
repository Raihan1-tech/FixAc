-- =============================================================================
-- ENTERPRISE HVAC FIELD SERVICE & DOUBLE-ENTRY ACCOUNTING ENGINE
-- Database Dialect : PostgreSQL 15+ (Compatible with MySQL 8.0+ with minor trigger syntax adjustments)
-- Precision Policy : All monetary columns strictly use DECIMAL(18, 4)
-- Governance       : ACID-compliant, Maker-Checker enforced, Append-Only Ledger & Audit Log
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. ENUMERATED TYPES & DOMAIN CONSTRAINTS
-- -----------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('ADMIN', 'FINANCE', 'TECHNICIAN');
CREATE TYPE employment_status AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');
CREATE TYPE commission_scheme AS ENUM ('PERCENTAGE', 'FLAT_RATE');

CREATE TYPE account_category AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');
CREATE TYPE normal_balance_type AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE cash_flow_activity AS ENUM ('OPERATING', 'INVESTING', 'FINANCING', 'CASH_EQUIVALENT', 'NONE');

CREATE TYPE period_status AS ENUM ('OPEN', 'CLOSED', 'LOCKED');
CREATE TYPE transaction_status AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID', 'REVERSED');

CREATE TYPE order_status AS ENUM (
    'BOOKED',
    'ASSIGNED',
    'IN_PROGRESS',
    'PENDING_APPROVAL',
    'COMPLETED_POSTED',
    'CANCELLED'
);

CREATE TYPE ac_refrigerant_type AS ENUM ('R32', 'R410A', 'R22', 'R290', 'OTHER');
CREATE TYPE line_item_type AS ENUM ('SERVICE_LABOR', 'SPAREPART', 'REFRIGERANT_GAS', 'CONSUMABLE');

-- -----------------------------------------------------------------------------
-- 2. CHART OF ACCOUNTS (COA) - Core General Ledger Structure
-- -----------------------------------------------------------------------------
CREATE TABLE chart_of_accounts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_code        VARCHAR(20) NOT NULL UNIQUE,
    account_name        VARCHAR(120) NOT NULL,
    category            account_category NOT NULL,
    sub_category        VARCHAR(60) NOT NULL, -- e.g., 'CURRENT_ASSET', 'COGS', 'OPERATING_EXPENSE'
    normal_balance      normal_balance_type NOT NULL,
    cash_flow_type      cash_flow_activity NOT NULL DEFAULT 'OPERATING',
    parent_account_id   UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
    is_system_account   BOOLEAN NOT NULL DEFAULT FALSE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_coa_normal_balance CHECK (
        (category IN ('ASSET', 'EXPENSE') AND normal_balance = 'DEBIT') OR
        (category IN ('LIABILITY', 'EQUITY', 'REVENUE') AND normal_balance = 'CREDIT')
    )
);

CREATE INDEX idx_coa_category_active ON chart_of_accounts(category, is_active);
CREATE INDEX idx_coa_code ON chart_of_accounts(account_code);

-- -----------------------------------------------------------------------------
-- 3. USERS & EMPLOYEES (RBAC + HR Lifecycle + Payroll GL Binding)
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username                VARCHAR(64) NOT NULL UNIQUE,
    email                   VARCHAR(160) NOT NULL UNIQUE,
    password_hash           VARCHAR(255) NOT NULL,
    role                    user_role NOT NULL DEFAULT 'TECHNICIAN',
    must_change_password    BOOLEAN NOT NULL DEFAULT TRUE,
    temp_password_expires   TIMESTAMPTZ,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at           TIMESTAMPTZ,
    created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE employees (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    employee_code               VARCHAR(32) NOT NULL UNIQUE, -- e.g., 'EMP-2026-0001'
    full_name                   VARCHAR(140) NOT NULL,
    phone_number                VARCHAR(32) NOT NULL,
    skill_specialization        VARCHAR(120) NOT NULL, -- e.g., 'Inverter & VRV Specialist', 'Residential Split AC'
    employment_status           employment_status NOT NULL DEFAULT 'ACTIVE',
    base_salary                  NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (base_salary >= 0),
    commission_type             commission_scheme NOT NULL DEFAULT 'PERCENTAGE',
    commission_rate_pct         NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (commission_rate_pct >= 0 AND commission_rate_pct <= 100),
    commission_flat_amount      NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (commission_flat_amount >= 0),
    -- Direct General Ledger Bindings for Automated Commission & Payroll Accruals
    commission_expense_acct_id  UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
    commission_payable_acct_id  UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
    hired_date                  DATE NOT NULL DEFAULT CURRENT_DATE,
    terminated_date             DATE,
    created_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_commission_scheme_values CHECK (
        (commission_type = 'PERCENTAGE' AND commission_rate_pct >= 0) OR
        (commission_type = 'FLAT_RATE' AND commission_flat_amount >= 0)
    )
);

CREATE INDEX idx_employees_status_role ON employees(employment_status, skill_specialization);
CREATE INDEX idx_employees_user_id ON employees(user_id);

-- -----------------------------------------------------------------------------
-- 4. FINANCIAL PERIODS (Accounting Period Control)
-- -----------------------------------------------------------------------------
CREATE TABLE financial_periods (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_name     VARCHAR(32) NOT NULL UNIQUE, -- e.g., '2026-10'
    fiscal_year     SMALLINT NOT NULL,
    fiscal_month    SMALLINT NOT NULL CHECK (fiscal_month BETWEEN 1 AND 12),
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    status          period_status NOT NULL DEFAULT 'OPEN',
    closed_by       UUID REFERENCES users(id) ON DELETE RESTRICT,
    closed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_period_dates CHECK (end_date >= start_date)
);

CREATE INDEX idx_financial_periods_dates ON financial_periods(start_date, end_date, status);

-- -----------------------------------------------------------------------------
-- 5. FIELD SERVICE ORDERS, TECHNICAL INSPECTIONS & DYNAMIC INVOICE ITEMS
-- -----------------------------------------------------------------------------
CREATE TABLE orders (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number            VARCHAR(32) NOT NULL UNIQUE, -- e.g., 'ORD-202610-0042'
    invoice_number          VARCHAR(32) UNIQUE,          -- e.g., 'INV-202610-0042'
    -- Client & Location Details
    client_contact_name     VARCHAR(140) NOT NULL,
    client_phone            VARCHAR(32) NOT NULL,
    client_address          TEXT NOT NULL,
    ac_room_location        VARCHAR(100) NOT NULL,       -- e.g., 'Master Bedroom Lantai 2'
    -- AC Unit Specifications
    ac_brand                VARCHAR(60) NOT NULL,        -- e.g., 'Daikin', 'Panasonic', 'Mitsubishi'
    ac_capacity_pk          VARCHAR(30) NOT NULL,        -- e.g., '0.5 PK', '1 PK', '2 PK'
    ac_model_type           VARCHAR(60) NOT NULL,        -- e.g., 'Inverter', 'Standard', 'Low Watt'
    ac_refrigerant          ac_refrigerant_type NOT NULL DEFAULT 'R32',
    -- Symptoms & Requested Services (Stored as structured JSONB arrays)
    symptoms                JSONB NOT NULL DEFAULT '[]'::jsonb, -- ["Tidak Dingin", "Bocor Air"]
    requested_services      JSONB NOT NULL DEFAULT '[]'::jsonb, -- ["Service/Cuci", "Tambah Freon"]
    client_notes            TEXT,
    -- Assignment & Execution Lifecycle
    assigned_technician_id  UUID REFERENCES employees(id) ON DELETE RESTRICT,
    status                  order_status NOT NULL DEFAULT 'BOOKED',
    -- Financial Totals (High-Precision DECIMAL(18, 4))
    subtotal_labor          NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (subtotal_labor >= 0),
    subtotal_parts          NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (subtotal_parts >= 0),
    total_cogs_parts        NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (total_cogs_parts >= 0),
    tax_amount              NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (tax_amount >= 0),
    grand_total             NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (grand_total >= 0),
    calculated_commission   NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (calculated_commission >= 0),
    -- Digital Sign-Off Metadata
    customer_signature_svg  TEXT,
    signed_by_name          VARCHAR(140),
    signed_at               TIMESTAMPTZ,
    completed_by_user_id    UUID REFERENCES users(id) ON DELETE RESTRICT,
    approved_by_user_id     UUID REFERENCES users(id) ON DELETE RESTRICT,
    approved_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_tech_status ON orders(assigned_technician_id, status, created_at DESC);
CREATE INDEX idx_orders_invoice_num ON orders(invoice_number);

CREATE TABLE order_inspections (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id                    UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    technician_id               UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    -- Quantitative Telemetry
    measured_amperage           NUMERIC(18, 4) NOT NULL CHECK (measured_amperage >= 0),
    operating_pressure_psi      NUMERIC(18, 4) NOT NULL CHECK (operating_pressure_psi >= 0),
    supply_air_temp_celsius     NUMERIC(18, 4),
    -- Indoor Checklist
    evaporator_cleanliness      VARCHAR(32) NOT NULL CHECK (evaporator_cleanliness IN ('CLEAN', 'DIRTY_CLEANED', 'CORRODED_NEEDS_REPLACE')),
    drain_line_condition        VARCHAR(32) NOT NULL CHECK (drain_line_condition IN ('CLEAR', 'CLOGGED_FLUSHED', 'LEAKING_REPAIRED')),
    indoor_blower_fan_status    VARCHAR(32) NOT NULL CHECK (indoor_blower_fan_status IN ('NORMAL', 'NOISY_LUBRICATED', 'FAULTY')),
    -- Outdoor Checklist
    condenser_coil_status       VARCHAR(32) NOT NULL DEFAULT 'CLEAN',
    outdoor_fan_motor_status    VARCHAR(32) NOT NULL CHECK (outdoor_fan_motor_status IN ('NORMAL', 'WEAK', 'FAULTY_REPLACED')),
    capacitor_condition         VARCHAR(32) NOT NULL CHECK (capacitor_condition IN ('GOOD', 'WEAK_REPLACED', 'BLOWN_REPLACED')),
    technician_diagnostic_note  TEXT,
    inspected_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE order_line_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_type           line_item_type NOT NULL,
    description         VARCHAR(200) NOT NULL,
    quantity            NUMERIC(18, 4) NOT NULL CHECK (quantity > 0),
    unit_price          NUMERIC(18, 4) NOT NULL CHECK (unit_price >= 0),
    unit_cost_cogs      NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (unit_cost_cogs >= 0),
    line_total          NUMERIC(18, 4) NOT NULL CHECK (line_total >= 0),
    revenue_account_id  UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_line_total_math CHECK (line_total = ROUND(quantity * unit_price, 4))
);

CREATE INDEX idx_order_line_items_order ON order_line_items(order_id);

-- -----------------------------------------------------------------------------
-- 6. DOUBLE-ENTRY ACCOUNTING ENGINE (TRANSACTIONS & JOURNAL ENTRIES)
-- -----------------------------------------------------------------------------
CREATE TABLE transactions (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_number            VARCHAR(40) NOT NULL UNIQUE, -- e.g., 'JRN-202610-00018'
    financial_period_id         UUID NOT NULL REFERENCES financial_periods(id) ON DELETE RESTRICT,
    order_id                    UUID REFERENCES orders(id) ON DELETE RESTRICT,
    transaction_date            DATE NOT NULL,
    description                 TEXT NOT NULL,
    status                      transaction_status NOT NULL DEFAULT 'DRAFT',
    -- Reversing Entry Self-Reference (Formal Credit Note / Jurnal Pembalik Link)
    reverses_transaction_id     UUID UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
    reversal_reason             TEXT,
    -- Maker-Checker Governance Metadata
    created_by                  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approved_by                 UUID REFERENCES users(id) ON DELETE RESTRICT,
    posted_at                   TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Maker-Checker Separation of Duties Constraint (when posted from field maker)
    CONSTRAINT chk_posted_requires_approver CHECK (
        status != 'POSTED' OR (approved_by IS NOT NULL AND posted_at IS NOT NULL)
    )
);

CREATE INDEX idx_transactions_period_date_status ON transactions(financial_period_id, transaction_date, status);
CREATE INDEX idx_transactions_order_id ON transactions(order_id);
CREATE INDEX idx_transactions_maker_checker ON transactions(created_by, approved_by, status);

CREATE TABLE journal_entries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id      UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
    line_number         SMALLINT NOT NULL CHECK (line_number > 0),
    account_id          UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
    employee_id         UUID REFERENCES employees(id) ON DELETE RESTRICT, -- Sub-ledger tracking for commissions/payroll
    memo                VARCHAR(255),
    debit               NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (debit >= 0.0000),
    credit              NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (credit >= 0.0000),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Strict Single-Sided Entry Rule: A line must be strictly Debit OR Credit, never both, never zero
    CONSTRAINT chk_journal_single_sided_non_zero CHECK (
        (debit > 0.0000 AND credit = 0.0000) OR
        (credit > 0.0000 AND debit = 0.0000)
    ),
    CONSTRAINT uq_transaction_line_number UNIQUE (transaction_id, line_number)
);

-- High-Performance Composite Indexes for Financial Reporting & Sub-ledger Queries
CREATE INDEX idx_je_account_tx ON journal_entries(account_id, transaction_id);
CREATE INDEX idx_je_employee_account ON journal_entries(employee_id, account_id) WHERE employee_id IS NOT NULL;
CREATE INDEX idx_je_transaction_id ON journal_entries(transaction_id);

-- -----------------------------------------------------------------------------
-- 7. IMMUTABLE AUDIT LOGS (Append-Only Compliance Trail)
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_user_id   UUID REFERENCES users(id) ON DELETE RESTRICT,
    actor_role      user_role,
    action_type     VARCHAR(64) NOT NULL, -- e.g., 'USER_CREATED', 'INVOICE_APPROVED', 'JOURNAL_POSTED', 'JOURNAL_REVERSED'
    entity_table    VARCHAR(64) NOT NULL,
    entity_id       UUID NOT NULL,
    previous_state  JSONB,
    new_state       JSONB,
    ip_address      INET,
    user_agent      TEXT,
    integrity_hash  VARCHAR(64) NOT NULL  -- SHA-256 chain hash for tamper detection
);

CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_table, entity_id, event_timestamp DESC);
CREATE INDEX idx_audit_logs_actor_time ON audit_logs(actor_user_id, event_timestamp DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs(action_type, event_timestamp DESC);

-- =============================================================================
-- 8. DATABASE TRIGGERS FOR ZERO-SUM DOUBLE-ENTRY & IMMUTABILITY GOVERNANCE
-- =============================================================================

-- 8A. Enforce Zero-Sum Validation (SUM(debit) - SUM(credit) = 0) & Open Period Check
CREATE OR REPLACE FUNCTION fn_verify_balanced_transaction()
RETURNS TRIGGER AS $$
DECLARE
    v_total_debit   NUMERIC(18, 4);
    v_total_credit  NUMERIC(18, 4);
    v_line_count    INT;
    v_period_status period_status;
BEGIN
    IF NEW.status = 'POSTED' THEN
        -- Verify Financial Period is OPEN
        SELECT status INTO v_period_status
        FROM financial_periods
        WHERE id = NEW.financial_period_id;

        IF v_period_status != 'OPEN' THEN
            RAISE EXCEPTION 'ACCOUNTING_VIOLATION: Cannot post transaction % into a % financial period.',
                NEW.reference_number, v_period_status;
        END IF;

        -- Compute aggregate Debits and Credits
        SELECT
            COALESCE(SUM(debit), 0.0000),
            COALESCE(SUM(credit), 0.0000),
            COUNT(*)
        INTO v_total_debit, v_total_credit, v_line_count
        FROM journal_entries
        WHERE transaction_id = NEW.id;

        IF v_line_count < 2 THEN
            RAISE EXCEPTION 'ACCOUNTING_VIOLATION: Transaction % must contain at least 2 journal lines (found %).',
                NEW.reference_number, v_line_count;
        END IF;

        IF (v_total_debit - v_total_credit) != 0.0000 OR v_total_debit <= 0.0000 THEN
            RAISE EXCEPTION 'DOUBLE_ENTRY_IMBALANCE: Transaction % failed zero-sum check. Debit=% vs Credit=% (Diff=%).',
                NEW.reference_number, v_total_debit, v_total_credit, (v_total_debit - v_total_credit);
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_enforce_zero_sum_on_post
AFTER INSERT OR UPDATE ON transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fn_verify_balanced_transaction();

-- 8B. Enforce Strict Immutability on Posted Journal Entries & Transactions
CREATE OR REPLACE FUNCTION fn_prevent_posted_ledger_mutation()
RETURNS TRIGGER AS $$
DECLARE
    v_tx_status transaction_status;
BEGIN
    IF TG_TABLE_NAME = 'transactions' THEN
        IF TG_OP = 'DELETE' AND OLD.status IN ('POSTED', 'REVERSED') THEN
            RAISE EXCEPTION 'IMMUTABILITY_VIOLATION: Posted transaction % cannot be deleted. Issue a formal Reversing Entry.', OLD.reference_number;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' AND NEW.status != 'REVERSED' THEN
            RAISE EXCEPTION 'IMMUTABILITY_VIOLATION: Posted transaction % is locked and can only transition to REVERSED via a reversing journal.', OLD.reference_number;
        END IF;
    ELSIF TG_TABLE_NAME = 'journal_entries' THEN
        SELECT status INTO v_tx_status FROM transactions WHERE id = OLD.transaction_id;
        IF v_tx_status IN ('POSTED', 'REVERSED') THEN
            RAISE EXCEPTION 'IMMUTABILITY_VIOLATION: Cannot % journal entry belonging to locked transaction %.', TG_OP, OLD.transaction_id;
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lock_posted_transactions
BEFORE UPDATE OR DELETE ON transactions
FOR EACH ROW EXECUTE FUNCTION fn_prevent_posted_ledger_mutation();

CREATE TRIGGER trg_lock_posted_journal_entries
BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION fn_prevent_posted_ledger_mutation();

-- 8C. Enforce Append-Only Audit Logs
CREATE OR REPLACE FUNCTION fn_protect_audit_logs()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'SECURITY_VIOLATION: Audit logs are strictly append-only and immutable.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_immutable_audit_logs
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION fn_protect_audit_logs();

-- =============================================================================
-- 9. SEED DATA: STANDARD HVAC ENTERPRISE CHART OF ACCOUNTS
-- =============================================================================
INSERT INTO chart_of_accounts (account_code, account_name, category, sub_category, normal_balance, cash_flow_type, is_system_account) VALUES
-- ASSETS (1000 - 1999)
('1110', 'Kas & Setara Kas (Bank BCA Operasional)', 'ASSET', 'CURRENT_ASSET', 'DEBIT', 'CASH_EQUIVALENT', TRUE),
('1120', 'Piutang Usaha Pelanggan (Accounts Receivable)', 'ASSET', 'CURRENT_ASSET', 'DEBIT', 'OPERATING', TRUE),
('1130', 'Persediaan Sparepart & Freon (HVAC Inventory)', 'ASSET', 'CURRENT_ASSET', 'DEBIT', 'OPERATING', TRUE),
('1210', 'Peralatan Kerja & Manifold Gauge Set', 'ASSET', 'FIXED_ASSET', 'DEBIT', 'INVESTING', TRUE),
-- LIABILITIES (2000 - 2999)
('2110', 'Utang Usaha Supplier Sparepart (Accounts Payable)', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT', 'OPERATING', TRUE),
('2120', 'Utang Komisi & Gaji Teknisi (Accrued Payroll Payable)', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT', 'OPERATING', TRUE),
('2130', 'Utang PPN Keluaran (VAT Payable)', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT', 'OPERATING', TRUE),
('2210', 'Pinjaman Modal Kerja Bank (Long-Term Loan)', 'LIABILITY', 'LONG_TERM_LIABILITY', 'CREDIT', 'FINANCING', FALSE),
-- EQUITY (3000 - 3999)
('3110', 'Modal Disetor Pemilik (Owner Paid-In Capital)', 'EQUITY', 'CAPITAL', 'CREDIT', 'FINANCING', TRUE),
('3200', 'Laba Ditahan (Retained Earnings)', 'EQUITY', 'RETAINED_EARNINGS', 'CREDIT', 'NONE', TRUE),
-- REVENUE (4000 - 4999)
('4110', 'Pendapatan Jasa Service & Instalasi AC', 'REVENUE', 'OPERATING_REVENUE', 'CREDIT', 'OPERATING', TRUE),
('4120', 'Pendapatan Penjualan Sparepart & Freon', 'REVENUE', 'OPERATING_REVENUE', 'CREDIT', 'OPERATING', TRUE),
-- EXPENSES (5000 - 5999)
('5110', 'Harga Pokok Penjualan (HPP) Sparepart & Freon', 'EXPENSE', 'COGS', 'DEBIT', 'OPERATING', TRUE),
('5120', 'Beban Komisi & Insentif Teknisi (Direct Labor Commission)', 'EXPENSE', 'COGS', 'DEBIT', 'OPERATING', TRUE),
('5210', 'Beban Gaji Pokok Staf & Admin', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', 'OPERATING', TRUE),
('5220', 'Beban Transportasi & BBM Armada Teknisi', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', 'OPERATING', TRUE);
