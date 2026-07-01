const ClientAccount = require('../models/ClientAccount');
const ClientPhoneNumber = require('../models/ClientPhoneNumber');

const CLIENT_PHONE_NUMBER_STATUSES = new Set(['active', 'pending', 'porting', 'inactive', 'archived']);

const normalizeTrimmedText = (value) => String(value || '').trim();

const normalizePhoneNumber = (value) => {
  const raw = normalizeTrimmedText(value);
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;

  return raw;
};

const normalizeStatus = (value, fallback = 'pending') => {
  const normalized = normalizeTrimmedText(value).toLowerCase();
  return CLIENT_PHONE_NUMBER_STATUSES.has(normalized) ? normalized : fallback;
};

const normalizeCapabilities = (value) => {
  if (Array.isArray(value)) {
    const values = new Set(value.map((item) => normalizeTrimmedText(item).toLowerCase()));
    return {
      voice: values.has('voice'),
      sms: values.has('sms'),
      mms: values.has('mms'),
    };
  }

  if (typeof value === 'object' && value !== null) {
    return {
      voice: Boolean(value.voice),
      sms: Boolean(value.sms),
      mms: Boolean(value.mms),
    };
  }

  const normalized = normalizeTrimmedText(value).toLowerCase();
  return {
    voice: !normalized || normalized.includes('voice'),
    sms: normalized.includes('sms') || normalized.includes('messaging'),
    mms: normalized.includes('mms') || normalized.includes('messaging'),
  };
};

const capabilitiesToClientAccountType = (capabilities = {}) => {
  if (capabilities.voice && capabilities.sms) return 'voice+sms';
  if (capabilities.sms || capabilities.mms) return 'sms';
  return 'voice';
};

const sanitizeClientPhoneNumber = (numberRecord) => ({
  id: String(numberRecord._id),
  phoneNumber: numberRecord.phoneNumber || '',
  clientAccountId: numberRecord.clientAccountId?._id
    ? String(numberRecord.clientAccountId._id)
    : String(numberRecord.clientAccountId || ''),
  clientAccount: numberRecord.clientAccountId?._id
    ? {
        id: String(numberRecord.clientAccountId._id),
        companyName: numberRecord.clientAccountId.companyName || '',
        accountStatus: numberRecord.clientAccountId.accountStatus || 'pending',
      }
    : null,
  resellerId: numberRecord.resellerId?._id
    ? String(numberRecord.resellerId._id)
    : (numberRecord.resellerId ? String(numberRecord.resellerId) : null),
  reseller: numberRecord.resellerId?._id
    ? {
        id: String(numberRecord.resellerId._id),
        companyName: numberRecord.resellerId.companyName || '',
        status: numberRecord.resellerId.status || 'pending',
      }
    : null,
  label: numberRecord.label || '',
  capabilities: {
    voice: Boolean(numberRecord.capabilities?.voice),
    sms: Boolean(numberRecord.capabilities?.sms),
    mms: Boolean(numberRecord.capabilities?.mms),
  },
  status: numberRecord.status || 'pending',
  archivedAt: numberRecord.archivedAt || null,
  isArchived: Boolean(numberRecord.archivedAt || numberRecord.status === 'archived'),
  assignedUserId: numberRecord.assignedUserId?._id
    ? String(numberRecord.assignedUserId._id)
    : (numberRecord.assignedUserId ? String(numberRecord.assignedUserId) : null),
  assignedUser: numberRecord.assignedUserId?._id
    ? {
        id: String(numberRecord.assignedUserId._id),
        name: numberRecord.assignedUserId.name || '',
        email: numberRecord.assignedUserId.email || '',
        role: numberRecord.assignedUserId.role || '',
      }
    : null,
  assignedDepartment: numberRecord.assignedDepartment || '',
  route: numberRecord.route || '',
  notes: numberRecord.notes || '',
  source: numberRecord.source || 'portal',
  createdAt: numberRecord.createdAt,
  updatedAt: numberRecord.updatedAt,
});

const populateClientPhoneNumberQuery = (query) => query
  .populate('clientAccountId', 'companyName accountStatus resellerId')
  .populate('resellerId', 'companyName status')
  .populate('assignedUserId', 'name email role clientAccountId');

const syncClientAccountAssignedNumbers = async (clientAccountId) => {
  const clientAccount = await ClientAccount.findById(clientAccountId);
  if (!clientAccount) return null;

  const numberRecords = await ClientPhoneNumber.find({
    clientAccountId,
    archivedAt: null,
    status: { $ne: 'archived' },
  })
    .sort({ createdAt: 1, updatedAt: 1 });

  clientAccount.assignedNumbers = numberRecords.map((record) => record.phoneNumber);
  clientAccount.assignedNumberRecords = numberRecords.map((record) => ({
    phoneNumber: record.phoneNumber,
    label: record.label || '',
    type: capabilitiesToClientAccountType(record.capabilities),
    status: normalizeStatus(record.status, 'pending'),
    assignedUserId: record.assignedUserId || null,
    assignedDepartment: record.assignedDepartment || record.route || '',
    notes: record.notes || '',
  }));

  await clientAccount.save();
  return clientAccount;
};

module.exports = {
  CLIENT_PHONE_NUMBER_STATUSES,
  capabilitiesToClientAccountType,
  normalizeCapabilities,
  normalizePhoneNumber,
  normalizeStatus,
  populateClientPhoneNumberQuery,
  sanitizeClientPhoneNumber,
  syncClientAccountAssignedNumbers,
};
