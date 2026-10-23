import React, { createContext, useContext, useState, useEffect, useRef } from 'react';

// =============================================================================
// 1. DOMAIN TYPES & RBAC MODELS
// =============================================================================
export type UserRole = 'ADMIN' | 'FINANCE' | 'TECHNICIAN';
export type EmploymentStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
export type CommissionScheme = 'PERCENTAGE' | 'FLAT_RATE';

export interface AuthenticatedUser {
  id: string;
  username: string;
  fullName: string;
  email: string;
  role: UserRole;
  employeeId?: string;
  employmentStatus: EmploymentStatus;
}

export interface EmployeeRecord {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string;
  phoneNumber: string;
  role: UserRole;
  skillSpecialization: string;
  employmentStatus: EmploymentStatus;
  baseSalary: number;
  commissionType: CommissionScheme;
  commissionRatePct: number;
  commissionFlatAmount: number;
  expenseAccountCode: string;
  payableAccountCode: string;
  completedJobs: number;
}

export interface InvoiceLineItem {
  id: string;
  itemType: 'SERVICE_LABOR' | 'SPAREPART' | 'REFRIGERANT_GAS';
  description: string;
  quantity: number;
  unitPrice: number;
  unitCostCogs: number;
}

export interface InspectionData {
  measuredAmperage: string;
  operatingPressurePsi: string;
  evaporatorCleanliness: 'CLEAN' | 'DIRTY_CLEANED' | 'CORRODED_NEEDS_REPLACE';
  drainLineCondition: 'CLEAR' | 'CLOGGED_FLUSHED' | 'LEAKING_REPAIRED';
  indoorBlowerFanStatus: 'NORMAL' | 'NOISY_LUBRICATED' | 'FAULTY';
  outdoorFanMotorStatus: 'NORMAL' | 'WEAK' | 'FAULTY_REPLACED';
  capacitorCondition: 'GOOD' | 'WEAK_REPLACED' | 'BLOWN_REPLACED';
  diagnosticNote: string;
}

// =============================================================================
// 2. AUTHENTICATION & PERSISTENT RBAC CONTEXT
// =============================================================================
interface AuthContextValue {
  user: AuthenticatedUser | null;
  login: (username: string, password: string) => boolean;
  logout: () => void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
};

const STORAGE_SESSION_KEY = 'hvac_erp_active_session_v1';

export const ProtectedRoute: React.FC<{
  allowedRoles: UserRole[];
  children: React.ReactNode;
  onUnauthorizedRedirect: () => void;
}> = ({ allowedRoles, children, onUnauthorizedRedirect }) => {
  const { user, notify } = useAuth();

  useEffect(() => {
    if (!user) {
      notify('Sesi belum aktif. Silakan login terlebih dahulu.', 'error');
      onUnauthorizedRedirect();
      return;
    }
    if (user.employmentStatus !== 'ACTIVE') {
      notify(`Akses ditolak: Status kepegawaian Anda saat ini ${user.employmentStatus}.`, 'error');
      onUnauthorizedRedirect();
      return;
    }
    if (!allowedRoles.includes(user.role)) {
      notify(`Akses RBAC Ditolak: Role ${user.role} tidak diizinkan mengakses modul ini.`, 'error');
      onUnauthorizedRedirect();
    }
  }, [user, allowedRoles, notify, onUnauthorizedRedirect]);

  if (!user || user.employmentStatus !== 'ACTIVE' || !allowedRoles.includes(user.role)) {
    return null;
  }

  return <>{children}</>;
};

// =============================================================================
// 3. TECHNICIAN COMPLETION, INVOICE & DIGITAL SIGNATURE MODAL
// =============================================================================
export const TechnicianSignOffModal: React.FC<{
  orderNumber: string;
  clientName: string;
  inspection: InspectionData;
  lineItems: InvoiceLineItem[];
  onClose: () => void;
  onSubmitForMakerChecker: (signatureDataUrl: string, signedByName: string) => void;
}> = ({ orderNumber, clientName, inspection, lineItems, onClose, onSubmitForMakerChecker }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [signedByName, setSignedByName] = useState(clientName);

  const subtotalLabor = lineItems
    .filter((i) => i.itemType === 'SERVICE_LABOR')
    .reduce((acc, i) => acc + i.quantity * i.unitPrice, 0);
  const subtotalParts = lineItems
    .filter((i) => i.itemType !== 'SERVICE_LABOR')
    .reduce((acc, i) => acc + i.quantity * i.unitPrice, 0);
  const grandTotal = subtotalLabor + subtotalParts;

  const startDraw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
    setIsDrawing(true);
    setHasSignature(true);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasSignature || !canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/png');
    onSubmitForMakerChecker(dataUrl, signedByName);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-xl w-full p-6">
        <div className="flex justify-between items-center border-b pb-3 mb-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-blue-600">
              Maker Step • Field Sign-Off
            </span>
            <h3 className="text-lg font-bold text-slate-900">
              Tandai Selesai & Minta Persetujuan ({orderNumber})
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>

        <form onSubmit={handleConfirm} className="space-y-4">
          <div className="bg-slate-50 rounded-xl p-3 text-xs space-y-1 border border-slate-200">
            <div className="flex justify-between">
              <span className="text-slate-500">Telemetry Teknis:</span>
              <span className="font-mono font-semibold text-slate-800">
                {inspection.measuredAmperage} A | {inspection.operatingPressurePsi} PSI | Evap: {inspection.evaporatorCleanliness}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Jasa Service (Akun 4110):</span>
              <span className="font-mono">Rp {subtotalLabor.toLocaleString('id-ID')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Sparepart & Freon (Akun 4120):</span>
              <span className="font-mono">Rp {subtotalParts.toLocaleString('id-ID')}</span>
            </div>
            <div className="flex justify-between font-bold text-sm text-slate-900 pt-1 border-t">
              <span>Total Tagihan Invoice:</span>
              <span className="font-mono text-emerald-700">Rp {grandTotal.toLocaleString('id-ID')}.0000</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Nama Penandatangan (Pelanggan / Perwakilan)
            </label>
            <input
              type="text"
              required
              value={signedByName}
              onChange={(e) => setSignedByName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-xs font-semibold text-slate-700">
                Tanda Tangan Digital Pelanggan
              </label>
              <button
                type="button"
                onClick={clearSignature}
                className="text-xs text-rose-600 hover:underline"
              >
                Bersihkan Kanvas
              </button>
            </div>
            <canvas
              ref={canvasRef}
              width={500}
              height={150}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={() => setIsDrawing(false)}
              onMouseLeave={() => setIsDrawing(false)}
              className="w-full h-36 border-2 border-dashed border-slate-300 rounded-xl bg-slate-50 cursor-crosshair"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={!hasSignature}
              className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold disabled:opacity-40"
            >
              Generate Invoice & Kirim ke Finance Checker
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// =============================================================================
// 4. ADMIN HR EMPLOYEE ONBOARDING & PAYROLL GL BINDING MODAL
// =============================================================================
export const AdminEmployeeModal: React.FC<{
  onClose: () => void;
  onSaveEmployee: (newEmp: Omit<EmployeeRecord, 'id' | 'employeeCode' | 'completedJobs'>) => void;
}> = ({ onClose, onSaveEmployee }) => {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [role, setRole] = useState<UserRole>('TECHNICIAN');
  const [skillSpecialization, setSkillSpecialization] = useState('Inverter & VRV Specialist');
  const [employmentStatus, setEmploymentStatus] = useState<EmploymentStatus>('ACTIVE');
  const [baseSalary, setBaseSalary] = useState(4500000);
  const [commissionType, setCommissionType] = useState<CommissionScheme>('PERCENTAGE');
  const [commissionRatePct, setCommissionRatePct] = useState(20);
  const [commissionFlatAmount, setCommissionFlatAmount] = useState(50000);
  const [expenseAccountCode, setExpenseAccountCode] = useState('5120');
  const [payableAccountCode, setPayableAccountCode] = useState('2120');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveEmployee({
      fullName,
      email,
      phoneNumber,
      role,
      skillSpecialization,
      employmentStatus,
      baseSalary,
      commissionType,
      commissionRatePct,
      commissionFlatAmount,
      expenseAccountCode,
      payableAccountCode,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-2xl w-full p-6">
        <h3 className="text-lg font-bold text-slate-900 mb-4">
          Onboarding Pegawai / Teknisi & Integrasi Akun Gaji (COA)
        </h3>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Nama Lengkap</label>
            <input
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Email Korporat</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">No. WhatsApp / Telepon</label>
            <input
              required
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Role RBAC</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="w-full border rounded-lg px-3 py-2"
            >
              <option value="TECHNICIAN">TECHNICIAN (Field Service)</option>
              <option value="FINANCE">FINANCE (Accounting Checker)</option>
              <option value="ADMIN">ADMIN (Full ERP Control)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Spesialisasi Teknis</label>
            <input
              required
              value={skillSpecialization}
              onChange={(e) => setSkillSpecialization(e.target.value)}
              className="w-full border rounded-lg px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Status Kepegawaian</label>
            <select
              value={employmentStatus}
              onChange={(e) => setEmploymentStatus(e.target.value as EmploymentStatus)}
              className="w-full border rounded-lg px-3 py-2"
            >
              <option value="ACTIVE">ACTIVE</option>
              <option value="INACTIVE">INACTIVE</option>
              <option value="SUSPENDED">SUSPENDED</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Gaji Pokok Bulanan (IDR)</label>
            <input
              type="number"
              min={0}
              value={baseSalary}
              onChange={(e) => setBaseSalary(Number(e.target.value))}
              className="w-full border rounded-lg px-3 py-2 font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Skema Komisi</label>
            <select
              value={commissionType}
              onChange={(e) => setCommissionType(e.target.value as CommissionScheme)}
              className="w-full border rounded-lg px-3 py-2"
            >
              <option value="PERCENTAGE">Persentase Jasa Service (% per Job)</option>
              <option value="FLAT_RATE">Tarif Tetap (Flat Rate IDR per Job)</option>
            </select>
          </div>
          {commissionType === 'PERCENTAGE' ? (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Persentase Komisi (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                step="0.5"
                value={commissionRatePct}
                onChange={(e) => setCommissionRatePct(Number(e.target.value))}
                className="w-full border rounded-lg px-3 py-2 font-mono"
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Nominal Komisi Flat (IDR)</label>
              <input
                type="number"
                min={0}
                value={commissionFlatAmount}
                onChange={(e) => setCommissionFlatAmount(Number(e.target.value))}
                className="w-full border rounded-lg px-3 py-2 font-mono"
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Binding COA Beban Komisi</label>
            <select
              value={expenseAccountCode}
              onChange={(e) => setExpenseAccountCode(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 font-mono text-xs"
            >
              <option value="5120">5120 - Beban Komisi & Insentif Teknisi (DR)</option>
              <option value="5210">5210 - Beban Gaji Pokok Staf & Admin (DR)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Binding COA Utang Gaji/Komisi</label>
            <select
              value={payableAccountCode}
              onChange={(e) => setPayableAccountCode(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 font-mono text-xs"
            >
              <option value="2120">2120 - Utang Komisi & Gaji Teknisi (CR)</option>
            </select>
          </div>
          <div className="md:col-span-2 flex justify-end gap-2 pt-3 border-t">
            <button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">
              Batal
            </button>
            <button type="submit" className="px-5 py-2 bg-indigo-600 text-white font-semibold rounded-lg">
              Simpan & Provision Temporary Password
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
