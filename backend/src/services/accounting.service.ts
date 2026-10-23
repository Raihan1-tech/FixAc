import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';

/**
 * Fixed-point 4-decimal arithmetic helper to eliminate IEEE-754 floating-point drift.
 * All monetary amounts are represented in database as NUMERIC(18, 4) and scaled by 10,000 in memory.
 */
export class Money {
  private static readonly SCALE = 10000n;

  static toScaled(value: string | number): bigint {
    const normalized = typeof value === 'number' ? value.toFixed(4) : value.trim();
    const [whole = '0', frac = '0000'] = normalized.split('.');
    const paddedFrac = (frac + '0000').slice(0, 4);
    const sign = whole.startsWith('-') ? -1n : 1n;
    const absWhole = BigInt(whole.replace('-', '') || '0');
    const absFrac = BigInt(paddedFrac);
    return sign * (absWhole * Money.SCALE + absFrac);
  }

  static format(scaled: bigint): string {
    const sign = scaled < 0n ? '-' : '';
    const abs = scaled < 0n ? -scaled : scaled;
    const whole = abs / Money.SCALE;
    const frac = (abs % Money.SCALE).toString().padStart(4, '0');
    return `${sign}${whole.toString()}.${frac}`;
  }
}

export interface JournalLineInput {
  accountCode: string;
  employeeId?: string | null;
  memo: string;
  debit: string;  // DECIMAL(18, 4) string e.g. "350000.0000"
  credit: string; // DECIMAL(18, 4) string e.g. "0.0000"
}

export interface PostJournalRequest {
  referenceNumber: string;
  transactionDate: string; // YYYY-MM-DD
  description: string;
  orderId?: string | null;
  makerUserId: string;
  checkerUserId: string;
  checkerRole: 'ADMIN' | 'FINANCE';
  lines: JournalLineInput[];
  ipAddress: string;
  userAgent: string;
}

export interface TechnicianCompletionPayload {
  orderId: string;
  makerUserId: string;
  technicianEmployeeId: string;
  inspection: {
    measuredAmperage: string;
    operatingPressurePsi: string;
    supplyAirTempCelsius: string;
    evaporatorCleanliness: 'CLEAN' | 'DIRTY_CLEANED' | 'CORRODED_NEEDS_REPLACE';
    drainLineCondition: 'CLEAR' | 'CLOGGED_FLUSHED' | 'LEAKING_REPAIRED';
    indoorBlowerFanStatus: 'NORMAL' | 'NOISY_LUBRICATED' | 'FAULTY';
    condenserCoilStatus: string;
    outdoorFanMotorStatus: 'NORMAL' | 'WEAK' | 'FAULTY_REPLACED';
    capacitorCondition: 'GOOD' | 'WEAK_REPLACED' | 'BLOWN_REPLACED';
    diagnosticNote: string;
  };
  lineItems: Array<{
    itemType: 'SERVICE_LABOR' | 'SPAREPART' | 'REFRIGERANT_GAS' | 'CONSUMABLE';
    description: string;
    quantity: string;
    unitPrice: string;
    unitCostCogs: string;
  }>;
  customerSignatureSvg: string;
  signedByName: string;
  ipAddress: string;
  userAgent: string;
}

export class AccountingEngineService {
  constructor(private readonly dbPool: Pool) {}

  /**
   * Appends a tamper-evident SHA-256 hash-chained record to the immutable audit_logs table.
   */
  public async appendAuditLog(
    client: PoolClient,
    params: {
      actorUserId: string;
      actorRole: 'ADMIN' | 'FINANCE' | 'TECHNICIAN';
      actionType: string;
      entityTable: string;
      entityId: string;
      previousState: Record<string, unknown> | null;
      newState: Record<string, unknown> | null;
      ipAddress: string;
      userAgent: string;
    }
  ): Promise<void> {
    const prevHashRes = await client.query<{ integrity_hash: string }>(
      `SELECT integrity_hash FROM audit_logs ORDER BY event_timestamp DESC LIMIT 1`
    );
    const previousHash = prevHashRes.rows[0]?.integrity_hash ?? 'GENESIS_00000000000000000000000000000000';

    const payloadToHash = JSON.stringify({
      previousHash,
      actorUserId: params.actorUserId,
      actionType: params.actionType,
      entityTable: params.entityTable,
      entityId: params.entityId,
      newState: params.newState,
    });
    const integrityHash = crypto.createHash('sha256').update(payloadToHash).digest('hex');

    await client.query(
      `INSERT INTO audit_logs (
        actor_user_id, actor_role, action_type, entity_table, entity_id,
        previous_state, new_state, ip_address, user_agent, integrity_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        params.actorUserId,
        params.actorRole,
        params.actionType,
        params.entityTable,
        params.entityId,
        params.previousState ? JSON.stringify(params.previousState) : null,
        params.newState ? JSON.stringify(params.newState) : null,
        params.ipAddress,
        params.userAgent,
        integrityHash,
      ]
    );
  }

  /**
   * STEP 1 (MAKER): Technician completes field inspection, builds invoice & captures signature.
   * Transitions Order -> PENDING_APPROVAL and creates a pre-validated DRAFT accounting package.
   */
  public async submitFieldOrderForApproval(payload: TechnicianCompletionPayload): Promise<{
    invoiceNumber: string;
    grandTotal: string;
    calculatedCommission: string;
  }> {
    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

      // 1. Lock order and verify assignment
      const orderRes = await client.query(
        `SELECT id, order_number, status, assigned_technician_id
         FROM orders WHERE id = $1 FOR UPDATE`,
        [payload.orderId]
      );
      if (orderRes.rowCount === 0) {
        throw new Error(`Order ${payload.orderId} not found.`);
      }
      const order = orderRes.rows[0];
      if (!['ASSIGNED', 'IN_PROGRESS'].includes(order.status)) {
        throw new Error(`Invalid state transition: Order ${order.order_number} is currently ${order.status}.`);
      }

      // 2. Fetch technician commission configuration
      const empRes = await client.query(
        `SELECT id, commission_type, commission_rate_pct, commission_flat_amount
         FROM employees WHERE id = $1 AND employment_status = 'ACTIVE'`,
        [payload.technicianEmployeeId]
      );
      if (empRes.rowCount === 0) {
        throw new Error('Assigned technician is not active or does not exist.');
      }
      const tech = empRes.rows[0];

      // 3. Upsert technical inspection telemetry
      await client.query(
        `INSERT INTO order_inspections (
          order_id, technician_id, measured_amperage, operating_pressure_psi,
          supply_air_temp_celsius, evaporator_cleanliness, drain_line_condition,
          indoor_blower_fan_status, condenser_coil_status, outdoor_fan_motor_status,
          capacitor_condition, technician_diagnostic_note
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (order_id) DO UPDATE SET
          measured_amperage = EXCLUDED.measured_amperage,
          operating_pressure_psi = EXCLUDED.operating_pressure_psi,
          evaporator_cleanliness = EXCLUDED.evaporator_cleanliness,
          drain_line_condition = EXCLUDED.drain_line_condition,
          capacitor_condition = EXCLUDED.capacitor_condition,
          technician_diagnostic_note = EXCLUDED.technician_diagnostic_note,
          inspected_at = NOW()`,
        [
          payload.orderId,
          payload.technicianEmployeeId,
          payload.inspection.measuredAmperage,
          payload.inspection.operatingPressurePsi,
          payload.inspection.supplyAirTempCelsius,
          payload.inspection.evaporatorCleanliness,
          payload.inspection.drainLineCondition,
          payload.inspection.indoorBlowerFanStatus,
          payload.inspection.condenserCoilStatus,
          payload.inspection.outdoorFanMotorStatus,
          payload.inspection.capacitorCondition,
          payload.inspection.diagnosticNote,
        ]
      );

      // 4. Resolve Revenue Accounts (4110 Labor vs 4120 Spareparts)
      const coaRes = await client.query<{ id: string; account_code: string }>(
        `SELECT id, account_code FROM chart_of_accounts WHERE account_code IN ('4110', '4120')`
      );
      const acctMap = new Map(coaRes.rows.map((r) => [r.account_code, r.id]));

      await client.query(`DELETE FROM order_line_items WHERE order_id = $1`, [payload.orderId]);

      let subtotalLaborScaled = 0n;
      let subtotalPartsScaled = 0n;
      let totalCogsPartsScaled = 0n;

      for (const item of payload.lineItems) {
        const qtyScaled = Money.toScaled(item.quantity);
        const priceScaled = Money.toScaled(item.unitPrice);
        const cogsScaled = Money.toScaled(item.unitCostCogs);

        const lineTotalScaled = (qtyScaled * priceScaled) / 10000n;
        const lineCogsScaled = (qtyScaled * cogsScaled) / 10000n;

        const isLabor = item.itemType === 'SERVICE_LABOR';
        if (isLabor) {
          subtotalLaborScaled += lineTotalScaled;
        } else {
          subtotalPartsScaled += lineTotalScaled;
          totalCogsPartsScaled += lineCogsScaled;
        }

        const revenueAccountId = acctMap.get(isLabor ? '4110' : '4120')!;
        await client.query(
          `INSERT INTO order_line_items (
            order_id, item_type, description, quantity, unit_price, unit_cost_cogs, line_total, revenue_account_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            payload.orderId,
            item.itemType,
            item.description,
            item.quantity,
            item.unitPrice,
            item.unitCostCogs,
            Money.format(lineTotalScaled),
            revenueAccountId,
          ]
        );
      }

      const grandTotalScaled = subtotalLaborScaled + subtotalPartsScaled;

      // 5. Calculate Technician Commission based on HR Scheme (% of Service Labor or Flat Rate per Job)
      let commissionScaled = 0n;
      if (tech.commission_type === 'PERCENTAGE') {
        const rateScaled = Money.toScaled(tech.commission_rate_pct);
        commissionScaled = (subtotalLaborScaled * rateScaled) / (100n * 10000n);
      } else {
        commissionScaled = Money.toScaled(tech.commission_flat_amount);
      }

      const invoiceNumber = order.order_number.replace(/^ORD-/, 'INV-');

      await client.query(
        `UPDATE orders SET
          invoice_number = $1,
          status = 'PENDING_APPROVAL',
          subtotal_labor = $2,
          subtotal_parts = $3,
          total_cogs_parts = $4,
          grand_total = $5,
          calculated_commission = $6,
          customer_signature_svg = $7,
          signed_by_name = $8,
          signed_at = NOW(),
          completed_by_user_id = $9,
          updated_at = NOW()
         WHERE id = $10`,
        [
          invoiceNumber,
          Money.format(subtotalLaborScaled),
          Money.format(subtotalPartsScaled),
          Money.format(totalCogsPartsScaled),
          Money.format(grandTotalScaled),
          Money.format(commissionScaled),
          payload.customerSignatureSvg,
          payload.signedByName,
          payload.makerUserId,
          payload.orderId,
        ]
      );

      await this.appendAuditLog(client, {
        actorUserId: payload.makerUserId,
        actorRole: 'TECHNICIAN',
        actionType: 'INVOICE_SUBMITTED_FOR_APPROVAL',
        entityTable: 'orders',
        entityId: payload.orderId,
        previousState: { status: order.status },
        newState: {
          status: 'PENDING_APPROVAL',
          invoiceNumber,
          grandTotal: Money.format(grandTotalScaled),
          calculatedCommission: Money.format(commissionScaled),
        },
        ipAddress: payload.ipAddress,
        userAgent: payload.userAgent,
      });

      await client.query('COMMIT');
      return {
        invoiceNumber,
        grandTotal: Money.format(grandTotalScaled),
        calculatedCommission: Money.format(commissionScaled),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * STEP 2 (CHECKER): Admin/Finance approves a completed order and atomically posts
   * the compound Double-Entry Journal to the General Ledger under SERIALIZABLE isolation.
   */
  public async approveAndPostOrderJournal(params: {
    orderId: string;
    checkerUserId: string;
    checkerRole: 'ADMIN' | 'FINANCE';
    settlementAccountCode: '1110' | '1120'; // 1110 = Cash/Bank, 1120 = Accounts Receivable
    ipAddress: string;
    userAgent: string;
  }): Promise<{ transactionId: string; referenceNumber: string; totalPosted: string }> {
    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      const orderRes = await client.query(
        `SELECT o.*, e.commission_expense_acct_id, e.commission_payable_acct_id
         FROM orders o
         JOIN employees e ON e.id = o.assigned_technician_id
         WHERE o.id = $1 FOR UPDATE`,
        [params.orderId]
      );
      if (orderRes.rowCount === 0) {
        throw new Error(`Order ${params.orderId} does not exist.`);
      }
      const order = orderRes.rows[0];

      if (order.status !== 'PENDING_APPROVAL') {
        throw new Error(`Order ${order.order_number} cannot be approved from status ${order.status}.`);
      }

      // Enforce Maker-Checker Separation of Duties
      if (order.completed_by_user_id === params.checkerUserId) {
        throw new Error(
          'MAKER_CHECKER_VIOLATION: The user who submitted the field invoice cannot approve and post their own journal entry.'
        );
      }

      const lines: JournalLineInput[] = [];

      // Leg 1: Cash / Accounts Receivable vs Service & Spareparts Revenue
      lines.push({
        accountCode: params.settlementAccountCode,
        memo: `Penerimaan Tagihan ${order.invoice_number} - ${order.client_contact_name}`,
        debit: order.grand_total,
        credit: '0.0000',
      });

      if (Money.toScaled(order.subtotal_labor) > 0n) {
        lines.push({
          accountCode: '4110',
          memo: `Pendapatan Jasa Service AC (${order.invoice_number})`,
          debit: '0.0000',
          credit: order.subtotal_labor,
        });
      }

      if (Money.toScaled(order.subtotal_parts) > 0n) {
        lines.push({
          accountCode: '4120',
          memo: `Pendapatan Sparepart & Freon (${order.invoice_number})`,
          debit: '0.0000',
          credit: order.subtotal_parts,
        });
      }

      // Leg 2: Perpetual Inventory COGS Recognition (DR 5110 HPP / CR 1130 Inventory)
      if (Money.toScaled(order.total_cogs_parts) > 0n) {
        lines.push({
          accountCode: '5110',
          memo: `HPP Pemakaian Sparepart & Freon (${order.invoice_number})`,
          debit: order.total_cogs_parts,
          credit: '0.0000',
        });
        lines.push({
          accountCode: '1130',
          memo: `Pengurangan Persediaan Gudang (${order.invoice_number})`,
          debit: '0.0000',
          credit: order.total_cogs_parts,
        });
      }

      // Leg 3: Automated Technician Commission Accrual (DR 5120 Commission Expense / CR 2120 Accrued Commission Payable)
      if (Money.toScaled(order.calculated_commission) > 0n) {
        lines.push({
          accountCode: '5120',
          employeeId: order.assigned_technician_id,
          memo: `Beban Komisi Teknisi atas ${order.invoice_number}`,
          debit: order.calculated_commission,
          credit: '0.0000',
        });
        lines.push({
          accountCode: '2120',
          employeeId: order.assigned_technician_id,
          memo: `Utang Komisi Teknisi atas ${order.invoice_number}`,
          debit: '0.0000',
          credit: order.calculated_commission,
        });
      }

      const referenceNumber = order.invoice_number.replace(/^INV-/, 'JRN-');
      const txResult = await this.postBalancedTransactionInternal(client, {
        referenceNumber,
        transactionDate: new Date().toISOString().slice(0, 10),
        description: `Posting Otomatis Invoice ${order.invoice_number} (${order.ac_brand} ${order.ac_capacity_pk} - ${order.client_contact_name})`,
        orderId: order.id,
        makerUserId: order.completed_by_user_id,
        checkerUserId: params.checkerUserId,
        checkerRole: params.checkerRole,
        lines,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      });

      await client.query(
        `UPDATE orders SET
          status = 'COMPLETED_POSTED',
          approved_by_user_id = $1,
          approved_at = NOW(),
          updated_at = NOW()
         WHERE id = $2`,
        [params.checkerUserId, order.id]
      );

      await client.query('COMMIT');
      return txResult;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * CORE ACID DOUBLE-ENTRY ENGINE:
   * Enforces mathematical zero-sum (Sum(Debit) - Sum(Credit) === 0.0000) before database write.
   */
  private async postBalancedTransactionInternal(
    client: PoolClient,
    req: PostJournalRequest
  ): Promise<{ transactionId: string; referenceNumber: string; totalPosted: string }> {
    if (req.lines.length < 2) {
      throw new Error('DOUBLE_ENTRY_ERROR: A journal transaction requires at least 2 line items.');
    }

    let totalDebitScaled = 0n;
    let totalCreditScaled = 0n;

    for (const [idx, line] of req.lines.entries()) {
      const debitScaled = Money.toScaled(line.debit);
      const creditScaled = Money.toScaled(line.credit);

      if (debitScaled < 0n || creditScaled < 0n) {
        throw new Error(`DOUBLE_ENTRY_ERROR: Line ${idx + 1} contains a negative monetary amount.`);
      }
      if ((debitScaled === 0n && creditScaled === 0n) || (debitScaled > 0n && creditScaled > 0n)) {
        throw new Error(
          `DOUBLE_ENTRY_ERROR: Line ${idx + 1} (${line.accountCode}) must have strictly positive Debit OR Credit, never both.`
        );
      }

      totalDebitScaled += debitScaled;
      totalCreditScaled += creditScaled;
    }

    // Strict Zero-Sum Assertion: Sum(Debit) - Sum(Credit) = 0
    const imbalanceScaled = totalDebitScaled - totalCreditScaled;
    if (imbalanceScaled !== 0n || totalDebitScaled === 0n) {
      throw new Error(
        `ZERO_SUM_VIOLATION: Total Debit (${Money.format(totalDebitScaled)}) != Total Credit (${Money.format(
          totalCreditScaled
        )}). Variance: ${Money.format(imbalanceScaled)}`
      );
    }

    // Verify Active Open Financial Period covering transactionDate
    const periodRes = await client.query<{ id: string }>(
      `SELECT id FROM financial_periods
       WHERE $1::date BETWEEN start_date AND end_date
         AND status = 'OPEN'
       FOR SHARE`,
      [req.transactionDate]
    );
    if (periodRes.rowCount === 0) {
      throw new Error(`PERIOD_LOCKED_OR_MISSING: No OPEN financial period found for date ${req.transactionDate}.`);
    }
    const financialPeriodId = periodRes.rows[0].id;

    // Insert Transaction Header
    const txRes = await client.query<{ id: string }>(
      `INSERT INTO transactions (
        reference_number, financial_period_id, order_id, transaction_date,
        description, status, created_by, approved_by, posted_at
      ) VALUES ($1, $2, $3, $4, $5, 'POSTED', $6, $7, NOW())
      RETURNING id`,
      [
        req.referenceNumber,
        financialPeriodId,
        req.orderId ?? null,
        req.transactionDate,
        req.description,
        req.makerUserId,
        req.checkerUserId,
      ]
    );
    const transactionId = txRes.rows[0].id;

    // Resolve Chart of Accounts codes & validate active status
    const accountCodes = Array.from(new Set(req.lines.map((l) => l.accountCode)));
    const coaRes = await client.query<{ id: string; account_code: string; is_active: boolean }>(
      `SELECT id, account_code, is_active FROM chart_of_accounts WHERE account_code = ANY($1::varchar[])`,
      [accountCodes]
    );
    const coaMap = new Map(coaRes.rows.map((r) => [r.account_code, r]));

    for (let i = 0; i < req.lines.length; i++) {
      const line = req.lines[i];
      const acct = coaMap.get(line.accountCode);
      if (!acct || !acct.is_active) {
        throw new Error(`INVALID_ACCOUNT: Account code ${line.accountCode} does not exist or is inactive.`);
      }

      await client.query(
        `INSERT INTO journal_entries (
          transaction_id, line_number, account_id, employee_id, memo, debit, credit
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          transactionId,
          i + 1,
          acct.id,
          line.employeeId ?? null,
          line.memo,
          Money.format(Money.toScaled(line.debit)),
          Money.format(Money.toScaled(line.credit)),
        ]
      );
    }

    await this.appendAuditLog(client, {
      actorUserId: req.checkerUserId,
      actorRole: req.checkerRole,
      actionType: 'JOURNAL_APPROVED_AND_POSTED',
      entityTable: 'transactions',
      entityId: transactionId,
      previousState: { status: 'PENDING_APPROVAL' },
      newState: {
        referenceNumber: req.referenceNumber,
        status: 'POSTED',
        totalDebit: Money.format(totalDebitScaled),
        totalCredit: Money.format(totalCreditScaled),
        lineCount: req.lines.length,
      },
      ipAddress: req.ipAddress,
      userAgent: req.userAgent,
    });

    return {
      transactionId,
      referenceNumber: req.referenceNumber,
      totalPosted: Money.format(totalDebitScaled),
    };
  }

  /**
   * FORMAL REVERSING ENTRY ENGINE (Jurnal Pembalik / Credit Note):
   * Posted entries are immutable and can never be deleted. To correct an error,
   * this method generates an exact mirror transaction swapping Debits and Credits.
   */
  public async createReversingEntry(params: {
    originalTransactionId: string;
    reversalDate: string;
    reversalReason: string;
    actorUserId: string;
    actorRole: 'ADMIN' | 'FINANCE';
    ipAddress: string;
    userAgent: string;
  }): Promise<{ reversalTransactionId: string; reversalReference: string }> {
    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      const origRes = await client.query(
        `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`,
        [params.originalTransactionId]
      );
      if (origRes.rowCount === 0) {
        throw new Error(`Original transaction ${params.originalTransactionId} not found.`);
      }
      const origTx = origRes.rows[0];
      if (origTx.status !== 'POSTED') {
        throw new Error(`Only POSTED transactions can be reversed (current status: ${origTx.status}).`);
      }

      const periodRes = await client.query<{ id: string }>(
        `SELECT id FROM financial_periods
         WHERE $1::date BETWEEN start_date AND end_date AND status = 'OPEN'`,
        [params.reversalDate]
      );
      if (periodRes.rowCount === 0) {
        throw new Error(`No OPEN financial period for reversal date ${params.reversalDate}.`);
      }

      const origLinesRes = await client.query(
        `SELECT account_id, employee_id, memo, debit, credit
         FROM journal_entries
         WHERE transaction_id = $1
         ORDER BY line_number ASC`,
        [params.originalTransactionId]
      );

      const reversalReference = `REV-${origTx.reference_number}`;
      const revTxRes = await client.query<{ id: string }>(
        `INSERT INTO transactions (
          reference_number, financial_period_id, order_id, transaction_date,
          description, status, reverses_transaction_id, reversal_reason,
          created_by, approved_by, posted_at
        ) VALUES ($1, $2, $3, $4, $5, 'POSTED', $6, $7, $8, $8, NOW())
        RETURNING id`,
        [
          reversalReference,
          periodRes.rows[0].id,
          origTx.order_id,
          params.reversalDate,
          `JURNAL PEMBALIK atas ${origTx.reference_number}: ${params.reversalReason}`,
          origTx.id,
          params.reversalReason,
          params.actorUserId,
        ]
      );
      const reversalTransactionId = revTxRes.rows[0].id;

      // Insert Inverted Mirror Lines (Swap Debit <-> Credit)
      for (let i = 0; i < origLinesRes.rows.length; i++) {
        const line = origLinesRes.rows[i];
        await client.query(
          `INSERT INTO journal_entries (
            transaction_id, line_number, account_id, employee_id, memo, debit, credit
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            reversalTransactionId,
            i + 1,
            line.account_id,
            line.employee_id,
            `[REVERSAL] ${line.memo}`,
            line.credit, // Original Credit becomes Debit
            line.debit,  // Original Debit becomes Credit
          ]
        );
      }

      // Mark original transaction as REVERSED (Allowed by trigger trg_lock_posted_transactions)
      await client.query(
        `UPDATE transactions SET status = 'REVERSED', updated_at = NOW() WHERE id = $1`,
        [origTx.id]
      );

      await this.appendAuditLog(client, {
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        actionType: 'JOURNAL_REVERSED',
        entityTable: 'transactions',
        entityId: origTx.id,
        previousState: { status: 'POSTED' },
        newState: {
          status: 'REVERSED',
          reversedByTransactionId: reversalTransactionId,
          reversalReference,
          reversalReason: params.reversalReason,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      });

      await client.query('COMMIT');
      return { reversalTransactionId, reversalReference };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
