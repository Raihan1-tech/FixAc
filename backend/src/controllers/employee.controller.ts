import crypto from 'crypto';
import { Pool } from 'pg';
import { AccountingEngineService, Money } from '../services/accounting.service';

export interface CreateEmployeeDTO {
  fullName: string;
  username: string;
  email: string;
  phoneNumber: string;
  role: 'ADMIN' | 'FINANCE' | 'TECHNICIAN';
  skillSpecialization: string;
  employmentStatus: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  baseSalary: string;            // DECIMAL(18, 4)
  commissionType: 'PERCENTAGE' | 'FLAT_RATE';
  commissionRatePct: string;     // DECIMAL(18, 4), e.g., "20.0000" for 20%
  commissionFlatAmount: string;  // DECIMAL(18, 4), e.g., "50000.0000"
  commissionExpenseAccountCode?: string; // Defaults to '5120' (Beban Komisi & Insentif Teknisi)
  commissionPayableAccountCode?: string; // Defaults to '2120' (Utang Komisi & Gaji Teknisi)
}

export interface UpdateEmployeeDTO {
  role?: 'ADMIN' | 'FINANCE' | 'TECHNICIAN';
  skillSpecialization?: string;
  employmentStatus?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  baseSalary?: string;
  commissionType?: 'PERCENTAGE' | 'FLAT_RATE';
  commissionRatePct?: string;
  commissionFlatAmount?: string;
}

export class EmployeeHRController {
  constructor(
    private readonly dbPool: Pool,
    private readonly accountingService: AccountingEngineService
  ) {}

  /**
   * Generates a cryptographically strong one-time temporary password
   * and returns both the cleartext (shown once to Admin) and PBKDF2/Argon2 hash.
   */
  private generateTemporaryCredentials(): { tempPassword: string; passwordHash: string } {
    const randomPart = crypto.randomBytes(6).toString('base64url');
    const tempPassword = `Hvac#${randomPart}!9`;
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.pbkdf2Sync(tempPassword, salt, 100000, 64, 'sha512').toString('hex');
    return {
      tempPassword,
      passwordHash: `pbkdf2_sha512$100000$${salt}$${derivedKey}`,
    };
  }

  /**
   * POST /api/v1/admin/employees
   * Atomically provisions User account, Employee HR profile, binds Chart of Accounts
   * payroll/commission sub-ledgers, and records an immutable Audit Log entry.
   */
  public async onboardEmployee(
    dto: CreateEmployeeDTO,
    adminContext: { adminUserId: string; ipAddress: string; userAgent: string }
  ): Promise<{
    employeeId: string;
    userId: string;
    employeeCode: string;
    temporaryPassword: string;
    boundAccounts: { expenseCode: string; payableCode: string };
  }> {
    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // 1. Resolve & Validate Chart of Accounts Bindings for Payroll/Commission
      const expenseCode = dto.commissionExpenseAccountCode ?? '5120';
      const payableCode = dto.commissionPayableAccountCode ?? '2120';

      const coaRes = await client.query<{ id: string; account_code: string; category: string }>(
        `SELECT id, account_code, category
         FROM chart_of_accounts
         WHERE account_code IN ($1, $2) AND is_active = TRUE`,
        [expenseCode, payableCode]
      );
      const expenseAcct = coaRes.rows.find((r) => r.account_code === expenseCode && r.category === 'EXPENSE');
      const payableAcct = coaRes.rows.find((r) => r.account_code === payableCode && r.category === 'LIABILITY');

      if (!expenseAcct || !payableAcct) {
        throw new Error(
          `COA_BINDING_ERROR: Could not bind employee to Expense (${expenseCode}) and Liability (${payableCode}) accounts.`
        );
      }

      // 2. Generate Temporary Password & Provision RBAC User Record
      const { tempPassword, passwordHash } = this.generateTemporaryCredentials();

      const userRes = await client.query<{ id: string }>(
        `INSERT INTO users (
          username, email, password_hash, role, must_change_password,
          temp_password_expires, is_active, created_by
        ) VALUES ($1, $2, $3, $4, TRUE, NOW() + INTERVAL '72 hours', $5, $6)
        RETURNING id`,
        [
          dto.username.toLowerCase().trim(),
          dto.email.toLowerCase().trim(),
          passwordHash,
          dto.role,
          dto.employmentStatus === 'ACTIVE',
          adminContext.adminUserId,
        ]
      );
      const userId = userRes.rows[0].id;

      // 3. Generate Sequential Employee Code & Insert HR Profile
      const seqRes = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM employees`);
      const nextNum = (parseInt(seqRes.rows[0].count, 10) + 1).toString().padStart(4, '0');
      const employeeCode = `EMP-${new Date().getFullYear()}-${nextNum}`;

      const empRes = await client.query<{ id: string }>(
        `INSERT INTO employees (
          user_id, employee_code, full_name, phone_number, skill_specialization,
          employment_status, base_salary, commission_type, commission_rate_pct,
          commission_flat_amount, commission_expense_acct_id, commission_payable_acct_id, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING id`,
        [
          userId,
          employeeCode,
          dto.fullName.trim(),
          dto.phoneNumber.trim(),
          dto.skillSpecialization,
          dto.employmentStatus,
          Money.format(Money.toScaled(dto.baseSalary)),
          dto.commissionType,
          Money.format(Money.toScaled(dto.commissionRatePct)),
          Money.format(Money.toScaled(dto.commissionFlatAmount)),
          expenseAcct.id,
          payableAcct.id,
          adminContext.adminUserId,
        ]
      );
      const employeeId = empRes.rows[0].id;

      // 4. Write Immutable Audit Log
      await this.accountingService.appendAuditLog(client, {
        actorUserId: adminContext.adminUserId,
        actorRole: 'ADMIN',
        actionType: 'EMPLOYEE_ONBOARDED',
        entityTable: 'employees',
        entityId: employeeId,
        previousState: null,
        newState: {
          employeeCode,
          fullName: dto.fullName,
          role: dto.role,
          employmentStatus: dto.employmentStatus,
          commissionType: dto.commissionType,
          commissionRatePct: dto.commissionRatePct,
          commissionFlatAmount: dto.commissionFlatAmount,
          boundExpenseAccount: expenseCode,
          boundPayableAccount: payableCode,
        },
        ipAddress: adminContext.ipAddress,
        userAgent: adminContext.userAgent,
      });

      await client.query('COMMIT');
      return {
        employeeId,
        userId,
        employeeCode,
        temporaryPassword: tempPassword,
        boundAccounts: { expenseCode, payableCode },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * PATCH /api/v1/admin/employees/:id
   * Updates Employment Status (ACTIVE/INACTIVE/SUSPENDED), Role permissions, or Commission Scheme.
   */
  public async updateEmployeeLifecycle(
    employeeId: string,
    dto: UpdateEmployeeDTO,
    adminContext: { adminUserId: string; ipAddress: string; userAgent: string }
  ): Promise<void> {
    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

      const prevRes = await client.query(
        `SELECT e.*, u.role FROM employees e JOIN users u ON u.id = e.user_id WHERE e.id = $1 FOR UPDATE`,
        [employeeId]
      );
      if (prevRes.rowCount === 0) {
        throw new Error(`Employee ${employeeId} not found.`);
      }
      const prev = prevRes.rows[0];

      const nextStatus = dto.employmentStatus ?? prev.employment_status;
      const nextRole = dto.role ?? prev.role;

      await client.query(
        `UPDATE employees SET
          skill_specialization = COALESCE($1, skill_specialization),
          employment_status = $2,
          base_salary = COALESCE($3, base_salary),
          commission_type = COALESCE($4, commission_type),
          commission_rate_pct = COALESCE($5, commission_rate_pct),
          commission_flat_amount = COALESCE($6, commission_flat_amount),
          updated_at = NOW()
         WHERE id = $7`,
        [
          dto.skillSpecialization ?? null,
          nextStatus,
          dto.baseSalary ? Money.format(Money.toScaled(dto.baseSalary)) : null,
          dto.commissionType ?? null,
          dto.commissionRatePct ? Money.format(Money.toScaled(dto.commissionRatePct)) : null,
          dto.commissionFlatAmount ? Money.format(Money.toScaled(dto.commissionFlatAmount)) : null,
          employeeId,
        ]
      );

      // Synchronize User RBAC active flag and role
      await client.query(
        `UPDATE users SET role = $1, is_active = $2, updated_at = NOW() WHERE id = $3`,
        [nextRole, nextStatus === 'ACTIVE', prev.user_id]
      );

      await this.accountingService.appendAuditLog(client, {
        actorUserId: adminContext.adminUserId,
        actorRole: 'ADMIN',
        actionType: prev.role !== nextRole ? 'ROLE_ELEVATION_OR_CHANGE' : 'EMPLOYEE_LIFECYCLE_UPDATED',
        entityTable: 'employees',
        entityId: employeeId,
        previousState: {
          role: prev.role,
          employmentStatus: prev.employment_status,
          commissionType: prev.commission_type,
          commissionRatePct: prev.commission_rate_pct,
          commissionFlatAmount: prev.commission_flat_amount,
        },
        newState: {
          role: nextRole,
          employmentStatus: nextStatus,
          commissionType: dto.commissionType ?? prev.commission_type,
          commissionRatePct: dto.commissionRatePct ?? prev.commission_rate_pct,
          commissionFlatAmount: dto.commissionFlatAmount ?? prev.commission_flat_amount,
        },
        ipAddress: adminContext.ipAddress,
        userAgent: adminContext.userAgent,
      });

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * POST /api/v1/admin/employees/:id/reset-password
   * Issues a new one-time temporary password and forces password change on next login.
   */
  public async resetTemporaryPassword(
    employeeId: string,
    adminContext: { adminUserId: string; ipAddress: string; userAgent: string }
  ): Promise<{ temporaryPassword: string; expiresInHours: number }> {
    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN');
      const empRes = await client.query<{ user_id: string; employee_code: string }>(
        `SELECT user_id, employee_code FROM employees WHERE id = $1 FOR UPDATE`,
        [employeeId]
      );
      if (empRes.rowCount === 0) {
        throw new Error(`Employee ${employeeId} not found.`);
      }

      const { tempPassword, passwordHash } = this.generateTemporaryCredentials();
      await client.query(
        `UPDATE users SET
          password_hash = $1,
          must_change_password = TRUE,
          temp_password_expires = NOW() + INTERVAL '24 hours',
          updated_at = NOW()
         WHERE id = $2`,
        [passwordHash, empRes.rows[0].user_id]
      );

      await this.accountingService.appendAuditLog(client, {
        actorUserId: adminContext.adminUserId,
        actorRole: 'ADMIN',
        actionType: 'EMPLOYEE_PASSWORD_RESET',
        entityTable: 'users',
        entityId: empRes.rows[0].user_id,
        previousState: { mustChangePassword: false },
        newState: { mustChangePassword: true, employeeCode: empRes.rows[0].employee_code },
        ipAddress: adminContext.ipAddress,
        userAgent: adminContext.userAgent,
      });

      await client.query('COMMIT');
      return { temporaryPassword: tempPassword, expiresInHours: 24 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
