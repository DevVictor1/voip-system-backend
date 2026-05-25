const mongoose = require('mongoose');
const Reseller = require('../models/Reseller');
const ClientAccount = require('../models/ClientAccount');
const User = require('../models/User');

const RESELLER_STATUSES = new Set(['active', 'inactive', 'pending']);
const CLIENT_ACCOUNT_STATUSES = new Set(['active', 'inactive', 'suspended', 'pending']);
const CLIENT_NUMBER_TYPES = new Set(['voice', 'sms', 'voice+sms']);
const CLIENT_NUMBER_STATUSES = new Set(['active', 'pending', 'porting', 'inactive']);
const CLIENT_ACCOUNT_ACTIVITY_LIMIT = 100;

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

const normalizeAssignedNumberRecord = (record = {}) => {
  const phoneNumber = normalizeTrimmedText(record?.phoneNumber);
  if (!phoneNumber) {
    return null;
  }

  const assignedUserId = normalizeOptionalObjectId(record?.assignedUserId);
  if (assignedUserId === '__invalid__') {
    return '__invalid__';
  }

  return {
    phoneNumber,
    label: normalizeTrimmedText(record?.label),
    type: normalizeStatus(record?.type, CLIENT_NUMBER_TYPES, 'voice'),
    status: normalizeStatus(record?.status, CLIENT_NUMBER_STATUSES, 'pending'),
    assignedUserId: assignedUserId || null,
    assignedDepartment: normalizeTrimmedText(record?.assignedDepartment),
    notes: normalizeTrimmedText(record?.notes),
  };
};

const normalizeAssignedNumberRecords = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const records = value
    .map((record) => normalizeAssignedNumberRecord(record))
    .filter(Boolean);

  if (records.includes('__invalid__')) {
    return '__invalid__';
  }

  const seenPhoneNumbers = new Set();
  return records.filter((record) => {
    const key = record.phoneNumber.toLowerCase();
    if (seenPhoneNumbers.has(key)) {
      return false;
    }
    seenPhoneNumbers.add(key);
    return true;
  });
};

const buildStructuredAssignedNumbers = (account) => {
  const structuredRecords = Array.isArray(account?.assignedNumberRecords)
    ? account.assignedNumberRecords
    : [];
  const legacyNumbers = Array.isArray(account?.assignedNumbers)
    ? account.assignedNumbers
    : [];

  const normalizedRecords = structuredRecords
    .map((record) => {
      const normalizedPhoneNumber = normalizeTrimmedText(record?.phoneNumber);
      if (!normalizedPhoneNumber) {
        return null;
      }

      return {
        phoneNumber: normalizedPhoneNumber,
        label: normalizeTrimmedText(record?.label),
        type: normalizeStatus(record?.type, CLIENT_NUMBER_TYPES, 'voice'),
        status: normalizeStatus(record?.status, CLIENT_NUMBER_STATUSES, 'pending'),
        assignedUserId: record?.assignedUserId?._id
          ? String(record.assignedUserId._id)
          : (record?.assignedUserId ? String(record.assignedUserId) : null),
        assignedUser: record?.assignedUserId?._id
          ? {
              id: String(record.assignedUserId._id),
              name: record.assignedUserId.name || '',
              email: record.assignedUserId.email || '',
              role: record.assignedUserId.role || '',
            }
          : null,
        assignedDepartment: normalizeTrimmedText(record?.assignedDepartment),
        notes: normalizeTrimmedText(record?.notes),
      };
    })
    .filter(Boolean);

  const existingPhoneNumbers = new Set(
    normalizedRecords.map((record) => record.phoneNumber.toLowerCase())
  );

  const legacyRecords = legacyNumbers
    .map((phoneNumber) => normalizeTrimmedText(phoneNumber))
    .filter(Boolean)
    .filter((phoneNumber) => !existingPhoneNumbers.has(phoneNumber.toLowerCase()))
    .map((phoneNumber) => ({
      phoneNumber,
      label: '',
      type: 'voice',
      status: 'active',
      assignedUserId: null,
      assignedUser: null,
      assignedDepartment: '',
      notes: '',
      isLegacy: true,
    }));

  return [...normalizedRecords, ...legacyRecords];
};

const normalizeAdminNoteText = (value) => normalizeTrimmedText(value);

const getActorMetadata = (user) => ({
  actorId: user?._id || null,
  actorName: normalizeTrimmedText(user?.name || user?.email || 'Admin User'),
});

const buildActivityEntry = (action, description, user) => ({
  action,
  description,
  ...getActorMetadata(user),
  createdAt: new Date(),
});

const appendActivityEntries = (clientAccount, entries = []) => {
  const normalizedEntries = entries.filter(Boolean);
  if (normalizedEntries.length === 0) {
    return;
  }

  const currentEntries = Array.isArray(clientAccount.activityLog)
    ? clientAccount.activityLog
    : [];

  clientAccount.activityLog = [...currentEntries, ...normalizedEntries].slice(-CLIENT_ACCOUNT_ACTIVITY_LIMIT);
};

const buildComparableAssignedNumberRecord = (record = {}) => ({
  phoneNumber: normalizeTrimmedText(record?.phoneNumber),
  label: normalizeTrimmedText(record?.label),
  type: normalizeStatus(record?.type, CLIENT_NUMBER_TYPES, 'voice'),
  status: normalizeStatus(record?.status, CLIENT_NUMBER_STATUSES, 'pending'),
  assignedUserId: record?.assignedUserId?._id
    ? String(record.assignedUserId._id)
    : (record?.assignedUserId ? String(record.assignedUserId) : ''),
  assignedDepartment: normalizeTrimmedText(record?.assignedDepartment),
  notes: normalizeTrimmedText(record?.notes),
});

const haveUserIdsChanged = (previousValues = [], nextValues = []) => {
  const previous = [...new Set(
    previousValues.map((value) => (
      value?._id ? String(value._id) : String(value || '').trim()
    )).filter(Boolean)
  )].sort();
  const next = [...new Set(
    nextValues.map((value) => String(value || '').trim()).filter(Boolean)
  )].sort();

  return previous.length !== next.length || previous.some((value, index) => value !== next[index]);
};

const haveAssignedNumberRecordsChanged = (previousValues = [], nextValues = []) => {
  const previous = previousValues
    .map((record) => JSON.stringify(buildComparableAssignedNumberRecord(record)))
    .filter(Boolean)
    .sort();
  const next = nextValues
    .map((record) => JSON.stringify(buildComparableAssignedNumberRecord(record)))
    .filter(Boolean)
    .sort();

  return previous.length !== next.length || previous.some((value, index) => value !== next[index]);
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
  assignedNumberRecords: buildStructuredAssignedNumbers(account),
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
  assignedUserIds: Array.isArray(account.assignedUserIds)
    ? account.assignedUserIds.map((user) => (
        user?._id ? String(user._id) : String(user)
      ))
    : [],
  assignedUsers: Array.isArray(account.assignedUserIds)
    ? account.assignedUserIds
        .filter((user) => user?._id)
        .map((user) => ({
          id: String(user._id),
          name: user.name || '',
          email: user.email || '',
          role: user.role || '',
        }))
    : [],
  adminNotes: Array.isArray(account.adminNotes)
    ? account.adminNotes.map((note) => ({
        id: note?._id ? String(note._id) : '',
        text: note?.text || '',
        authorId: note?.authorId ? String(note.authorId) : null,
        authorName: note?.authorName || '',
        createdAt: note?.createdAt || null,
      }))
    : [],
  activityLog: Array.isArray(account.activityLog)
    ? account.activityLog.map((entry) => ({
        action: entry?.action || '',
        description: entry?.description || '',
        actorId: entry?.actorId ? String(entry.actorId) : null,
        actorName: entry?.actorName || '',
        createdAt: entry?.createdAt || null,
      }))
    : [],
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

const validateReferencedUsers = async (assignedUserIds = []) => {
  if (!Array.isArray(assignedUserIds)) {
    return { error: 'assignedUserIds must be an array' };
  }

  const normalizedIds = [...new Set(
    assignedUserIds
      .map((value) => normalizeOptionalObjectId(value))
      .filter(Boolean)
  )];

  if (normalizedIds.includes('__invalid__')) {
    return { error: 'assignedUserIds contains an invalid user id' };
  }

  if (normalizedIds.length === 0) {
    return { userIds: [], users: [] };
  }

  const users = await User.find({
    _id: { $in: normalizedIds },
  }).select('name email role');

  if (users.length !== normalizedIds.length) {
    return { error: 'One or more assigned users were not found' };
  }

  return { userIds: normalizedIds, users };
};

const validateAssignedNumberRecordUsers = async (records = []) => {
  const assignedUserIds = [...new Set(
    records
      .map((record) => record?.assignedUserId)
      .filter(Boolean)
  )];

  return validateReferencedUsers(assignedUserIds);
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
      .populate('assignedUserIds', 'name email role')
      .populate('assignedNumberRecords.assignedUserId', 'name email role')
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
      .populate('adminUserId', 'name email role')
      .populate('assignedUserIds', 'name email role')
      .populate('assignedNumberRecords.assignedUserId', 'name email role');

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
    const assignedUserIdsInput = Array.isArray(req.body?.assignedUserIds) ? req.body.assignedUserIds : [];
    const assignedNumberRecordsInput = normalizeAssignedNumberRecords(req.body?.assignedNumberRecords);

    if (assignedNumberRecordsInput === '__invalid__') {
      return res.status(400).json({ error: 'assignedNumberRecords contains an invalid assigned user id' });
    }

    const [resellerLookup, userLookup, assignedUsersLookup, assignedNumberRecordUsersLookup] = await Promise.all([
      validateReferencedReseller(resellerId),
      validateReferencedUser(adminUserId),
      validateReferencedUsers(assignedUserIdsInput),
      validateAssignedNumberRecordUsers(assignedNumberRecordsInput),
    ]);

    if (resellerLookup.error) {
      return res.status(400).json({ error: resellerLookup.error });
    }

    if (userLookup.error) {
      return res.status(400).json({ error: userLookup.error });
    }

    if (assignedUsersLookup.error) {
      return res.status(400).json({ error: assignedUsersLookup.error });
    }

    if (assignedNumberRecordUsersLookup.error) {
      return res.status(400).json({ error: assignedNumberRecordUsersLookup.error });
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
      assignedNumbers: assignedNumberRecordsInput.length > 0
        ? assignedNumberRecordsInput.map((record) => record.phoneNumber)
        : normalizeAssignedNumbers(req.body?.assignedNumbers),
      assignedNumberRecords: assignedNumberRecordsInput,
      adminUserId: userLookup.user?._id || null,
      assignedUserIds: assignedUsersLookup.userIds || [],
      activityLog: [
        buildActivityEntry('account_created', 'Client account created in Admin Portal', req.user),
      ],
    });

    const populatedAccount = await ClientAccount.findById(clientAccount._id)
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role')
      .populate('assignedUserIds', 'name email role')
      .populate('assignedNumberRecords.assignedUserId', 'name email role');

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
    const assignedUserIdsInput = req.body?.assignedUserIds !== undefined
      ? req.body.assignedUserIds
      : clientAccount.assignedUserIds;
    const assignedNumberRecordsInput = req.body?.assignedNumberRecords !== undefined
      ? normalizeAssignedNumberRecords(req.body.assignedNumberRecords)
      : normalizeAssignedNumberRecords(clientAccount.assignedNumberRecords);

    if (assignedNumberRecordsInput === '__invalid__') {
      return res.status(400).json({ error: 'assignedNumberRecords contains an invalid assigned user id' });
    }

    const [resellerLookup, userLookup, assignedUsersLookup, assignedNumberRecordUsersLookup] = await Promise.all([
      validateReferencedReseller(resellerId),
      validateReferencedUser(adminUserId),
      validateReferencedUsers(assignedUserIdsInput),
      validateAssignedNumberRecordUsers(assignedNumberRecordsInput),
    ]);

    if (resellerLookup.error) {
      return res.status(400).json({ error: resellerLookup.error });
    }

    if (userLookup.error) {
      return res.status(400).json({ error: userLookup.error });
    }

    if (assignedUsersLookup.error) {
      return res.status(400).json({ error: assignedUsersLookup.error });
    }

    if (assignedNumberRecordUsersLookup.error) {
      return res.status(400).json({ error: assignedNumberRecordUsersLookup.error });
    }

    const companyName = normalizeTrimmedText(req.body?.companyName ?? clientAccount.companyName);
    if (!companyName) {
      return res.status(400).json({ error: 'companyName is required' });
    }

    const nextStatus = normalizeStatus(
      req.body?.accountStatus ?? clientAccount.accountStatus,
      CLIENT_ACCOUNT_STATUSES,
      clientAccount.accountStatus || 'pending'
    );
    const nextAssignedNumbers = assignedNumberRecordsInput.length > 0
      ? assignedNumberRecordsInput.map((record) => record.phoneNumber)
      : normalizeAssignedNumbers(
          req.body?.assignedNumbers !== undefined ? req.body?.assignedNumbers : clientAccount.assignedNumbers
        );

    const nextActivityEntries = [];

    if (String(clientAccount.accountStatus || '') !== String(nextStatus || '')) {
      nextActivityEntries.push(buildActivityEntry(
        'status_changed',
        `Account status changed from ${clientAccount.accountStatus || 'unknown'} to ${nextStatus}`,
        req.user
      ));
    }

    if (haveUserIdsChanged(clientAccount.assignedUserIds, assignedUsersLookup.userIds || [])) {
      nextActivityEntries.push(buildActivityEntry(
        'assigned_users_changed',
        'Client user seat assignments were updated',
        req.user
      ));
    }

    if (haveAssignedNumberRecordsChanged(clientAccount.assignedNumberRecords, assignedNumberRecordsInput)) {
      nextActivityEntries.push(buildActivityEntry(
        'number_metadata_changed',
        'Client number metadata was updated',
        req.user
      ));
    }

    clientAccount.resellerId = resellerLookup.reseller?._id || null;
    clientAccount.companyName = companyName;
    clientAccount.accountStatus = nextStatus;
    clientAccount.plan = normalizeTrimmedText(req.body?.plan ?? clientAccount.plan);
    clientAccount.seatLimit = normalizeNonNegativeInteger(req.body?.seatLimit ?? clientAccount.seatLimit, 0);
    clientAccount.assignedNumbers = nextAssignedNumbers;
    clientAccount.assignedNumberRecords = assignedNumberRecordsInput;
    clientAccount.adminUserId = userLookup.user?._id || null;
    clientAccount.assignedUserIds = assignedUsersLookup.userIds || [];
    appendActivityEntries(clientAccount, nextActivityEntries);

    await clientAccount.save();

    const populatedAccount = await ClientAccount.findById(clientAccount._id)
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role')
      .populate('assignedUserIds', 'name email role')
      .populate('assignedNumberRecords.assignedUserId', 'name email role');

    return res.json({
      clientAccount: sanitizeClientAccount(populatedAccount),
    });
  } catch (error) {
    console.error('Admin portal update client account error:', error);
    return res.status(500).json({ error: 'Failed to update client account' });
  }
};

exports.updateClientAccountStatus = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findById(req.params.id);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client account not found' });
    }

    const nextStatus = normalizeStatus(
      req.body?.accountStatus,
      CLIENT_ACCOUNT_STATUSES,
      ''
    );

    if (!nextStatus) {
      return res.status(400).json({ error: 'accountStatus is required' });
    }

    const previousStatus = clientAccount.accountStatus;
    clientAccount.accountStatus = nextStatus;
    if (String(previousStatus || '') !== String(nextStatus || '')) {
      appendActivityEntries(clientAccount, [
        buildActivityEntry(
          'status_changed',
          `Account status changed from ${previousStatus || 'unknown'} to ${nextStatus}`,
          req.user
        ),
      ]);
    }
    await clientAccount.save();

    const populatedAccount = await ClientAccount.findById(clientAccount._id)
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role')
      .populate('assignedUserIds', 'name email role')
      .populate('assignedNumberRecords.assignedUserId', 'name email role');

    return res.json({
      clientAccount: sanitizeClientAccount(populatedAccount),
    });
  } catch (error) {
    console.error('Admin portal update client account status error:', error);
    return res.status(500).json({ error: 'Failed to update client account status' });
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

exports.addClientAccountNote = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findById(req.params.id);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client account not found' });
    }

    const text = normalizeAdminNoteText(req.body?.text);
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    const author = {
      text,
      authorId: req.user?._id || null,
      authorName: normalizeTrimmedText(req.user?.name || req.user?.email || 'Admin User'),
      createdAt: new Date(),
    };

    clientAccount.adminNotes = [...(Array.isArray(clientAccount.adminNotes) ? clientAccount.adminNotes : []), author];
    appendActivityEntries(clientAccount, [
      buildActivityEntry('note_added', 'An internal admin note was added', req.user),
    ]);

    await clientAccount.save();

    const populatedAccount = await ClientAccount.findById(clientAccount._id)
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role')
      .populate('assignedUserIds', 'name email role')
      .populate('assignedNumberRecords.assignedUserId', 'name email role');

    return res.status(201).json({
      clientAccount: sanitizeClientAccount(populatedAccount),
    });
  } catch (error) {
    console.error('Admin portal add client account note error:', error);
    return res.status(500).json({ error: 'Failed to add client account note' });
  }
};

exports.deleteClientAccountNote = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findById(req.params.id);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client account not found' });
    }

    const noteId = normalizeTrimmedText(req.params.noteId);
    const currentNotes = Array.isArray(clientAccount.adminNotes) ? clientAccount.adminNotes : [];
    const noteExists = currentNotes.some((note) => String(note?._id || '') === noteId);

    if (!noteExists) {
      return res.status(404).json({ error: 'Note not found' });
    }

    clientAccount.adminNotes = currentNotes.filter((note) => String(note?._id || '') !== noteId);
    appendActivityEntries(clientAccount, [
      buildActivityEntry('note_deleted', 'An internal admin note was deleted', req.user),
    ]);

    await clientAccount.save();

    const populatedAccount = await ClientAccount.findById(clientAccount._id)
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role')
      .populate('assignedUserIds', 'name email role')
      .populate('assignedNumberRecords.assignedUserId', 'name email role');

    return res.json({
      clientAccount: sanitizeClientAccount(populatedAccount),
    });
  } catch (error) {
    console.error('Admin portal delete client account note error:', error);
    return res.status(500).json({ error: 'Failed to delete client account note' });
  }
};
