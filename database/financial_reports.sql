-- =============================================================================
-- FINANCIAL AGGREGATION & REAL-TIME STATEMENT QUERIES
-- Precision: NUMERIC(18, 4) | Strict Filter: transactions.status = 'POSTED'
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. REAL-TIME INCOME STATEMENT (LAPORAN LABA RUGI)
-- Dynamically computes Gross Profit, Operating Margin %, and Net Profit
-- from Service Revenues, Spareparts COGS, and Accrued Technician Commissions.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_income_statement_realtime AS
WITH account_activity AS (
    SELECT
        coa.id AS account_id,
        coa.account_code,
        coa.account_name,
        coa.category,
        coa.sub_category,
        fp.period_name,
        fp.start_date,
        fp.end_date,
        -- Normal balance sign normalization:
        -- Revenue is CREDIT-normal (credit - debit)
        -- Expense is DEBIT-normal (debit - credit)
        CASE
            WHEN coa.category = 'REVENUE' THEN COALESCE(SUM(je.credit - je.debit), 0.0000)
            WHEN coa.category = 'EXPENSE' THEN COALESCE(SUM(je.debit - je.credit), 0.0000)
            ELSE 0.0000
        END AS net_amount
    FROM chart_of_accounts coa
    CROSS JOIN financial_periods fp
    LEFT JOIN transactions t
        ON t.financial_period_id = fp.id
        AND t.status = 'POSTED'
    LEFT JOIN journal_entries je
        ON je.transaction_id = t.id
        AND je.account_id = coa.id
    WHERE coa.category IN ('REVENUE', 'EXPENSE')
      AND coa.is_active = TRUE
    GROUP BY
        coa.id, coa.account_code, coa.account_name, coa.category, coa.sub_category,
        fp.period_name, fp.start_date, fp.end_date
),
summary_metrics AS (
    SELECT
        period_name,
        SUM(CASE WHEN category = 'REVENUE' THEN net_amount ELSE 0.0000 END) AS total_revenue,
        SUM(CASE WHEN account_code = '4110' THEN net_amount ELSE 0.0000 END) AS service_labor_revenue,
        SUM(CASE WHEN account_code = '4120' THEN net_amount ELSE 0.0000 END) AS spareparts_revenue,
        SUM(CASE WHEN category = 'EXPENSE' AND sub_category = 'COGS' THEN net_amount ELSE 0.0000 END) AS total_cogs_and_direct_commissions,
        SUM(CASE WHEN account_code = '5110' THEN net_amount ELSE 0.0000 END) AS parts_cogs_expense,
        SUM(CASE WHEN account_code = '5120' THEN net_amount ELSE 0.0000 END) AS tech_commission_expense,
        SUM(CASE WHEN category = 'EXPENSE' AND sub_category = 'OPERATING_EXPENSE' THEN net_amount ELSE 0.0000 END) AS total_operating_expenses
    FROM account_activity
    GROUP BY period_name
)
SELECT
    period_name,
    service_labor_revenue,
    spareparts_revenue,
    total_revenue,
    parts_cogs_expense,
    tech_commission_expense,
    total_cogs_and_direct_commissions,
    -- Gross Profit = Total Revenue - (Parts COGS + Direct Technician Commissions)
    (total_revenue - total_cogs_and_direct_commissions) AS gross_profit,
    CASE
        WHEN total_revenue > 0 THEN ROUND(((total_revenue - total_cogs_and_direct_commissions) / total_revenue) * 100, 4)
        ELSE 0.0000
    END AS gross_margin_pct,
    total_operating_expenses,
    -- Net Operating Profit (Laba Bersih Operasional)
    (total_revenue - total_cogs_and_direct_commissions - total_operating_expenses) AS net_profit,
    CASE
        WHEN total_revenue > 0 THEN ROUND(((total_revenue - total_cogs_and_direct_commissions - total_operating_expenses) / total_revenue) * 100, 4)
        ELSE 0.0000
    END AS operating_margin_pct
FROM summary_metrics;


-- -----------------------------------------------------------------------------
-- 2. REAL-TIME BALANCE SHEET (LAPORAN POSISI KEUANGAN / NERACA)
-- Strictly validates: Assets = Liabilities + (Paid-In/Retained Equity + Current Period Net Income)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_balance_sheet_realtime AS
WITH ledger_balances AS (
    SELECT
        coa.id AS account_id,
        coa.account_code,
        coa.account_name,
        coa.category,
        coa.sub_category,
        CASE
            WHEN coa.normal_balance = 'DEBIT'  THEN COALESCE(SUM(je.debit - je.credit), 0.0000)
            WHEN coa.normal_balance = 'CREDIT' THEN COALESCE(SUM(je.credit - je.debit), 0.0000)
        END AS ending_balance
    FROM chart_of_accounts coa
    LEFT JOIN journal_entries je ON je.account_id = coa.id
    LEFT JOIN transactions t ON t.id = je.transaction_id AND t.status = 'POSTED'
    WHERE coa.is_active = TRUE
    GROUP BY coa.id, coa.account_code, coa.account_name, coa.category, coa.sub_category, coa.normal_balance
),
current_earnings AS (
    -- Unclosed current-period Net Profit flows into Equity to satisfy Assets = Liabilities + Equity at all times
    SELECT
        COALESCE(SUM(CASE WHEN category = 'REVENUE' THEN ending_balance ELSE 0.0000 END), 0.0000) -
        COALESCE(SUM(CASE WHEN category = 'EXPENSE' THEN ending_balance ELSE 0.0000 END), 0.0000) AS unclosed_net_income
    FROM ledger_balances
    WHERE category IN ('REVENUE', 'EXPENSE')
),
bs_lines AS (
    SELECT
        account_code,
        account_name,
        category,
        sub_category,
        ending_balance
    FROM ledger_balances
    WHERE category IN ('ASSET', 'LIABILITY', 'EQUITY')
    UNION ALL
    SELECT
        '3999' AS account_code,
        'Laba Tahun Berjalan (Current Period Net Income)' AS account_name,
        'EQUITY'::account_category AS category,
        'CURRENT_EARNINGS' AS sub_category,
        unclosed_net_income AS ending_balance
    FROM current_earnings
),
equation_check AS (
    SELECT
        SUM(CASE WHEN category = 'ASSET' THEN ending_balance ELSE 0.0000 END) AS total_assets,
        SUM(CASE WHEN category = 'LIABILITY' THEN ending_balance ELSE 0.0000 END) AS total_liabilities,
        SUM(CASE WHEN category = 'EQUITY' THEN ending_balance ELSE 0.0000 END) AS total_equity
    FROM bs_lines
)
SELECT
    b.account_code,
    b.account_name,
    b.category,
    b.sub_category,
    b.ending_balance,
    e.total_assets,
    e.total_liabilities,
    e.total_equity,
    (e.total_liabilities + e.total_equity) AS total_liabilities_and_equity,
    (e.total_assets - (e.total_liabilities + e.total_equity)) AS accounting_equation_discrepancy,
    CASE
        WHEN (e.total_assets - (e.total_liabilities + e.total_equity)) = 0.0000 THEN TRUE
        ELSE FALSE
    END AS is_balanced
FROM bs_lines b
CROSS JOIN equation_check e
ORDER BY b.account_code;


-- -----------------------------------------------------------------------------
-- 3. REAL-TIME DIRECT CASH FLOW STATEMENT (LAPORAN ARUS KAS)
-- Classifies every cash movement into OPERATING, INVESTING, and FINANCING
-- by inspecting the counterparty journal lines of posted cash transactions.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_cash_flow_statement_realtime AS
WITH cash_transactions AS (
    SELECT DISTINCT
        t.id AS transaction_id,
        t.financial_period_id,
        fp.period_name
    FROM transactions t
    JOIN financial_periods fp ON fp.id = t.financial_period_id
    JOIN journal_entries je ON je.transaction_id = t.id
    JOIN chart_of_accounts coa ON coa.id = je.account_id
    WHERE t.status = 'POSTED'
      AND coa.cash_flow_type = 'CASH_EQUIVALENT'
),
counterparty_cash_effects AS (
    -- For every transaction touching Cash ('1110'), the cash inflow/outflow impact
    -- of each non-cash counterparty line is (je.credit - je.debit)
    SELECT
        ct.period_name,
        coa.cash_flow_type AS activity_category,
        coa.account_code,
        coa.account_name,
        SUM(je.credit - je.debit) AS net_cash_impact
    FROM cash_transactions ct
    JOIN journal_entries je ON je.transaction_id = ct.transaction_id
    JOIN chart_of_accounts coa ON coa.id = je.account_id
    WHERE coa.cash_flow_type != 'CASH_EQUIVALENT'
    GROUP BY ct.period_name, coa.cash_flow_type, coa.account_code, coa.account_name
)
SELECT
    period_name,
    activity_category,
    account_code,
    account_name,
    SUM(CASE WHEN net_cash_impact > 0 THEN net_cash_impact ELSE 0.0000 END) AS cash_inflow,
    SUM(CASE WHEN net_cash_impact < 0 THEN ABS(net_cash_impact) ELSE 0.0000 END) AS cash_outflow,
    net_cash_impact AS net_cash_flow
FROM counterparty_cash_effects
GROUP BY period_name, activity_category, account_code, account_name
ORDER BY period_name, activity_category, account_code;


-- -----------------------------------------------------------------------------
-- 4. TECHNICIAN PRODUCTIVITY & ACCRUED COMMISSION SUB-LEDGER QUERY
-- Powers the Admin Executive Overview & Automated Payroll Calculator
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_technician_productivity_payroll AS
SELECT
    e.id AS employee_id,
    e.employee_code,
    e.full_name,
    e.skill_specialization,
    e.employment_status,
    e.base_salary,
    e.commission_type,
    e.commission_rate_pct,
    e.commission_flat_amount,
    COUNT(DISTINCT CASE WHEN o.status = 'COMPLETED_POSTED' THEN o.id END) AS completed_posted_jobs,
    COUNT(DISTINCT CASE WHEN o.status = 'PENDING_APPROVAL' THEN o.id END) AS pending_approval_jobs,
    COALESCE(SUM(CASE WHEN o.status = 'COMPLETED_POSTED' THEN o.grand_total ELSE 0.0000 END), 0.0000) AS total_revenue_generated,
    -- Verified Commission Accrued in General Ledger (Account 2120 Credits - Debits per employee_id)
    COALESCE((
        SELECT SUM(je.credit - je.debit)
        FROM journal_entries je
        JOIN transactions t ON t.id = je.transaction_id
        WHERE je.employee_id = e.id
          AND je.account_id = e.commission_payable_acct_id
          AND t.status = 'POSTED'
    ), 0.0000) AS accrued_commission_payable,
    -- Total Take-Home Pay Projection (Base Salary + Accrued Unpaid Commissions)
    e.base_salary + COALESCE((
        SELECT SUM(je.credit - je.debit)
        FROM journal_entries je
        JOIN transactions t ON t.id = je.transaction_id
        WHERE je.employee_id = e.id
          AND je.account_id = e.commission_payable_acct_id
          AND t.status = 'POSTED'
    ), 0.0000) AS projected_total_payout
FROM employees e
LEFT JOIN orders o ON o.assigned_technician_id = e.id
GROUP BY
    e.id, e.employee_code, e.full_name, e.skill_specialization,
    e.employment_status, e.base_salary, e.commission_type,
    e.commission_rate_pct, e.commission_flat_amount, e.commission_payable_acct_id;
