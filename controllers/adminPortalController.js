const mongoose = require('mongoose');
const Reseller = require('../models/Reseller');
const ClientAccount = require('../models/ClientAccount');
const User = require('../models/User');

const RESELLER_STATUSES = new Set(['active', 'inactive', 'pending']);
const CLIENT_ACCOUNT_STATUSES = new Set(['active', 'inactive', 'suspended', 'pending']);

const normalizeTrimmedText = (value) => String(value || '').trim();

const normalizeOptionalObjectId = (value) => {
  const trimmed = normalizeTrimmedText(value);
  if (!trimmed) {
    return null;
  }

  return mongoose.Types.ObjectId.isValid(trimmed) ? trimmed : '__invalid__';
};

const normalizeStatus = (value, allowedValues, fallback) => {
  const normalized = normalizeTrimmedText(value).toLowerCase();
  return allowedValues.has(normalized) ? normalized : fallback;
};

const normalizeNonNegativeInteger = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.floor(parsed));
};

const normalizeAssignedNumbers = (value) => {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => normalizeTrimmedText(item)).filter(Boolean))];
  }

  const text = normalizeTrimmedText(value);
  if (!text) {
    return [];
  }

  return [...new Set(text.split(',').map((item) => normalizeTrimmedText(item)).filter(Boolean))];
};

const sanitizeReseller = (reseller) => ({
  id: String(reseller._id),
  name: reseller.name || '',
  companyName: reseller.companyName || '',
  contactEmail: reseller.contactEmail || '',
  contactPhone: reseller.contactPhone || '',
  status: reseller.status || 'pending',
  notes: reseller.notes || '',
  createdAt: reseller.createdAt,
  updatedAt: reseller.updatedAt,
});

const sanitizeClientAccount = (account) => ({
  id: String(account._id),
  resellerId: account.resellerId?._id
    ? String(account.resellerId._id)
    : (account.resellerId ? String(account.resellerId) : null),
  reseller: account.resellerId?._id
    ? {
        id: String(account.resellerId._id),
        name: account.resellerId.name || '',
        companyName: account.resellerId.companyName || '',
        status: account.resellerId.status || 'pending',
      }
    : null,
  companyName: account.companyName || '',
  accountStatus: account.accountStatus || 'pending',
  plan: account.plan || '',
  seatLimit: Number.isFinite(account.seatLimit) ? account.seatLimit : 0,
  assignedNumbers: Array.isArray(account.assignedNumbers) ? account.assignedNumbers : [],
  adminUserId: account.adminUserId?._id
    ? String(account.adminUserId._id)
    : (account.adminUserId ? String(account.adminUserId) : null),
  adminUser: account.adminUserId?._id
    ? {
        id: String(account.adminUserId._id),
        name: account.adminUserId.name || '',
        email: account.adminUserId.email || '',
        role: account.adminUserId.role || '',
      }
    : null,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

const validateReferencedUser = async (adminUserId) => {
  if (!adminUserId) {
    return { user: null };
  }

  if (adminUserId === '__invalid__') {
    return { error: 'adminUserId is invalid' };
  }

  const user = await User.findById(adminUserId).select('name email role');
  if (!user) {
    return { error: 'Admin user not found' };
  }

  return { user };
};

const validateReferencedReseller = async (resellerId) => {
  if (!resellerId) {
    return { reseller: null };
  }

  if (resellerId === '__invalid__') {
    return { error: 'resellerId is invalid' };
  }

  const reseller = await Reseller.findById(resellerId);
  if (!reseller) {
    return { error: 'Reseller not found' };
  }

  return { reseller };
};

exports.listResellers = async (_req, res) => {
  try {
    const resellers = await Reseller.find({}).sort({ createdAt: -1 });
    return res.json({
      resellers: resellers.map(sanitizeReseller),
    });
  } catch (error) {
    console.error('Admin portal list resellers error:', error);
    return res.status(500).json({ error: 'Failed to fetch resellers' });
  }
};

exports.getReseller = async (req, res) => {
  try {
    const reseller = await Reseller.findById(req.params.id);
    if (!reseller) {
      return res.status(404).json({ error: 'Reseller not found' });
    }

    return res.json({
      reseller: sanitizeReseller(reseller),
    });
  } catch (error) {
    console.error('Admin portal get reseller error:', error);
    return res.status(500).json({ error: 'Failed to fetch reseller' });
  }
};

exports.createReseller = async (req, res) => {
  try {
    const payload = {
      name: normalizeTrimmedText(req.body?.name),
      companyName: normalizeTrimmedText(req.body?.companyName),
      contactEmail: normalizeTrimmedText(req.body?.contactEmail).toLowerCase(),
      contactPhone: normalizeTrimmedText(req.body?.contactPhone),
      status: normalizeStatus(req.body?.status, RESELLER_STATUSES, 'pending'),
      notes: normalizeTrimmedText(req.body?.notes),
    };

    if (!payload.name || !payload.companyName) {
      return res.status(400).json({ error: 'name and companyName are required' });
    }

    const reseller = await Reseller.create(payload);
    return res.status(201).json({
      reseller: sanitizeReseller(reseller),
    });
  } catch (error) {
    console.error('Admin portal create reseller error:', error);
    return res.status(500).json({ error: 'Failed to create reseller' });
  }
};

exports.updateReseller = async (req, res) => {
  try {
    const reseller = await Reseller.findById(req.params.id);
    if (!reseller) {
      return res.status(404).json({ error: 'Reseller not found' });
    }

    const nextName = normalizeTrimmedText(req.body?.name ?? reseller.name);
    const nextCompanyName = normalizeTrimmedText(req.body?.companyName ?? reseller.companyName);

    if (!nextName || !nextCompanyName) {
      return res.status(400).json({ error: 'name and companyName are required' });
    }

    reseller.name = nextName;
    reseller.companyName = nextCompanyName;
    reseller.contactEmail = normalizeTrimmedText(req.body?.contactEmail ?? reseller.contactEmail).toLowerCase();
    reseller.contactPhone = normalizeTrimmedText(req.body?.contactPhone ?? reseller.contactPhone);
    reseller.status = normalizeStatus(req.body?.status ?? reseller.status, RESELLER_STATUSES, reseller.status || 'pending');
    reseller.notes = normalizeTrimmedText(req.body?.notes ?? reseller.notes);

    await reseller.save();

    return res.json({
      reseller: sanitizeReseller(reseller),
    });
  } catch (error) {
    console.error('Admin portal update reseller error:', error);
    return res.status(500).json({ error: 'Failed to update reseller' });
  }
};

exports.listClientAccounts = async (_req, res) => {
  try {
    const clientAccounts = await ClientAccount.find({})
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role')
      .sort({ createdAt: -1 });

    return res.json({
      clientAccounts: clientAccounts.map(sanitizeClientAccount),
    });
  } catch (error) {
    console.error('Admin portal list client accounts error:', error);
    return res.status(500).json({ error: 'Failed to fetch client accounts' });
  }
};

exports.getClientAccount = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findById(req.params.id)
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role');

    if (!clientAccount) {
      return res.status(404).json({ error: 'Client account not found' });
    }

    return res.json({
      clientAccount: sanitizeClientAccount(clientAccount),
    });
  } catch (error) {
    console.error('Admin portal get client account error:', error);
    return res.status(500).json({ error: 'Failed to fetch client account' });
  }
};

exports.createClientAccount = async (req, res) => {
  try {
    const resellerId = normalizeOptionalObjectId(req.body?.resellerId);
    const adminUserId = normalizeOptionalObjectId(req.body?.adminUserId);

    const [resellerLookup, userLookup] = await Promise.all([
      validateReferencedReseller(resellerId),
      validateReferencedUser(adminUserId),
    ]);

    if (resellerLookup.error) {
      return res.status(400).json({ error: resellerLookup.error });
    }

    if (userLookup.error) {
      return res.status(400).json({ error: userLookup.error });
    }

    const companyName = normalizeTrimmedText(req.body?.companyName);
    if (!companyName) {
      return res.status(400).json({ error: 'companyName is required' });
    }

    const clientAccount = await ClientAccount.create({
      resellerId: resellerLookup.reseller?._id || null,
      companyName,
      accountStatus: normalizeStatus(req.body?.accountStatus, CLIENT_ACCOUNT_STATUSES, 'pending'),
      plan: normalizeTrimmedText(req.body?.plan),
      seatLimit: normalizeNonNegativeInteger(req.body?.seatLimit, 0),
      assignedNumbers: normalizeAssignedNumbers(req.body?.assignedNumbers),
      adminUserId: userLookup.user?._id || null,
    });

    const populatedAccount = await ClientAccount.findById(clientAccount._id)
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role');

    return res.status(201).json({
      clientAccount: sanitizeClientAccount(populatedAccount),
    });
  } catch (error) {
    console.error('Admin portal create client account error:', error);
    return res.status(500).json({ error: 'Failed to create client account' });
  }
};

exports.updateClientAccount = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findById(req.params.id);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client account not found' });
    }

    const resellerId = normalizeOptionalObjectId(
      req.body?.resellerId !== undefined ? req.body?.resellerId : clientAccount.resellerId
    );
    const adminUserId = normalizeOptionalObjectId(
      req.body?.adminUserId !== undefined ? req.body?.adminUserId : clientAccount.adminUserId
    );

    const [resellerLookup, userLookup] = await Promise.all([
      validateReferencedReseller(resellerId),
      validateReferencedUser(adminUserId),
    ]);

    if (resellerLookup.error) {
      return res.status(400).json({ error: resellerLookup.error });
    }

    if (userLookup.error) {
      return res.status(400).json({ error: userLookup.error });
    }

    const companyName = normalizeTrimmedText(req.body?.companyName ?? clientAccount.companyName);
    if (!companyName) {
      return res.status(400).json({ error: 'companyName is required' });
    }

    clientAccount.resellerId = resellerLookup.reseller?._id || null;
    clientAccount.companyName = companyName;
    clientAccount.accountStatus = normalizeStatus(
      req.body?.accountStatus ?? clientAccount.accountStatus,
      CLIENT_ACCOUNT_STATUSES,
      clientAccount.accountStatus || 'pending'
    );
    clientAccount.plan = normalizeTrimmedText(req.body?.plan ?? clientAccount.plan);
    clientAccount.seatLimit = normalizeNonNegativeInteger(req.body?.seatLimit ?? clientAccount.seatLimit, 0);
    clientAccount.assignedNumbers = normalizeAssignedNumbers(
      req.body?.assignedNumbers !== undefined ? req.body?.assignedNumbers : clientAccount.assignedNumbers
    );
    clientAccount.adminUserId = userLookup.user?._id || null;

    await clientAccount.save();

    const populatedAccount = await ClientAccount.findById(clientAccount._id)
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role');

    return res.json({
      clientAccount: sanitizeClientAccount(populatedAccount),
    });
  } catch (error) {
    console.error('Admin portal update client account error:', error);
    return res.status(500).json({ error: 'Failed to update client account' });
  }
};

exports.getResellerOverview = async (_req, res) => {
  try {
    const [resellerCount, clientAccountCount] = await Promise.all([
      Reseller.countDocuments({}),
      ClientAccount.countDocuments({}),
    ]);

    return res.json({
      overview: {
        resellerCount,
        clientAccountCount,
        phase: 'stage-2-foundation',
        accessModel: 'admin-managed',
      },
    });
  } catch (error) {
    console.error('Reseller overview error:', error);
    return res.status(500).json({ error: 'Failed to fetch reseller overview' });
  }
};
