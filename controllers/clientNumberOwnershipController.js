const mongoose = require('mongoose');
const ClientAccount = require('../models/ClientAccount');
const ClientPhoneNumber = require('../models/ClientPhoneNumber');
const User = require('../models/User');
const { isPlatformAdmin } = require('../utils/accessControl');
const { getClientAccountIdString } = require('../utils/clientOwnership');
const {
  normalizeCapabilities,
  normalizePhoneNumber,
  normalizeStatus,
  populateClientPhoneNumberQuery,
  sanitizeClientPhoneNumber,
  syncClientAccountAssignedNumbers,
} = require('../utils/clientNumberOwnership');

const normalizeTrimmedText = (value) => String(value || '').trim();

const normalizeOptionalObjectId = (value) => {
  const trimmed = normalizeTrimmedText(value);
  if (!trimmed) return null;
  return mongoose.Types.ObjectId.isValid(trimmed) ? trimmed : '__invalid__';
};

const findScopedClientAccount = async (req, clientAccountId) => {
  if (isPlatformAdmin(req.user)) {
    return ClientAccount.findById(clientAccountId);
  }

  const selectedAccountId = getClientAccountIdString(req.accountContext?.selectedClientAccountId);
  const primaryAccountId = getClientAccountIdString(req.accountContext?.primaryClientAccountId);
  const requestedId = getClientAccountIdString(clientAccountId);

  if (requestedId && (requestedId === selectedAccountId || requestedId === primaryAccountId)) {
    return ClientAccount.findById(clientAccountId);
  }

  return null;
};

const validateAssignedUser = async ({ assignedUserId, clientAccountId, allowDifferentClientAccounts = false }) => {
  const normalizedUserId = normalizeOptionalObjectId(assignedUserId);
  if (!normalizedUserId) return { user: null };
  if (normalizedUserId === '__invalid__') return { error: 'Assigned user id is invalid' };

  const user = await User.findById(normalizedUserId).select('name email role clientAccountId');
  if (!user) return { error: 'Assigned user not found' };

  if (!allowDifferentClientAccounts) {
    const userClientId = getClientAccountIdString(user.clientAccountId);
    const clientId = getClientAccountIdString(clientAccountId);
    if (userClientId && userClientId !== clientId) {
      return { error: 'Assigned user belongs to another client organization' };
    }
  }

  return { user };
};

const ensurePhoneNumberAvailable = async ({ phoneNumber, clientAccountId, excludeNumberId = null }) => {
  const existing = await ClientPhoneNumber.findOne({
    phoneNumber,
    ...(excludeNumberId ? { _id: { $ne: excludeNumberId } } : {}),
  }).select('_id clientAccountId');

  if (!existing) return null;

  if (getClientAccountIdString(existing.clientAccountId) === getClientAccountIdString(clientAccountId)) {
    return null;
  }

  return 'This phone number is already assigned to another client organization';
};

const buildNumberPayload = async ({ req, clientAccount, existingNumber = null }) => {
  const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber ?? existingNumber?.phoneNumber);
  if (!phoneNumber) {
    return { error: 'Phone number is required' };
  }

  const duplicateError = await ensurePhoneNumberAvailable({
    phoneNumber,
    clientAccountId: clientAccount._id,
    excludeNumberId: existingNumber?._id || null,
  });
  if (duplicateError) return { error: duplicateError };

  const userLookup = await validateAssignedUser({
    assignedUserId: req.body?.assignedUserId ?? existingNumber?.assignedUserId,
    clientAccountId: clientAccount._id,
    allowDifferentClientAccounts: false,
  });
  if (userLookup.error) return { error: userLookup.error };

  return {
    payload: {
      phoneNumber,
      clientAccountId: clientAccount._id,
      resellerId: clientAccount.resellerId || null,
      label: normalizeTrimmedText(req.body?.label ?? existingNumber?.label),
      capabilities: normalizeCapabilities(req.body?.capabilities ?? existingNumber?.capabilities),
      status: normalizeStatus(req.body?.status ?? existingNumber?.status, existingNumber?.status || 'pending'),
      assignedUserId: userLookup.user?._id || null,
      assignedDepartment: normalizeTrimmedText(req.body?.assignedDepartment ?? existingNumber?.assignedDepartment),
      route: normalizeTrimmedText(req.body?.route ?? existingNumber?.route),
      notes: normalizeTrimmedText(req.body?.notes ?? existingNumber?.notes),
      source: existingNumber?.source || 'portal',
      archivedAt: existingNumber?.archivedAt || null,
      archivedBy: existingNumber?.archivedBy || null,
    },
  };
};

exports.listClientNumbers = async (req, res) => {
  try {
    const clientAccount = await findScopedClientAccount(req, req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const includeArchived = String(req.query?.includeArchived || '').toLowerCase() === 'true';
    const query = includeArchived
      ? { clientAccountId: clientAccount._id }
      : { clientAccountId: clientAccount._id, archivedAt: null, status: { $ne: 'archived' } };
    const numbers = await populateClientPhoneNumberQuery(
      ClientPhoneNumber.find(query).sort({ createdAt: -1 })
    );

    return res.json({ numbers: numbers.map(sanitizeClientPhoneNumber) });
  } catch (error) {
    console.error('Client number list error:', error);
    return res.status(500).json({ error: 'Failed to load phone numbers' });
  }
};

exports.createClientNumber = async (req, res) => {
  try {
    const clientAccount = await findScopedClientAccount(req, req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const payloadResult = await buildNumberPayload({ req, clientAccount });
    if (payloadResult.error) {
      return res.status(400).json({ error: payloadResult.error });
    }

    const created = await ClientPhoneNumber.create(payloadResult.payload);
    await syncClientAccountAssignedNumbers(clientAccount._id);

    const populated = await populateClientPhoneNumberQuery(ClientPhoneNumber.findById(created._id));
    return res.status(201).json({ number: sanitizeClientPhoneNumber(populated) });
  } catch (error) {
    console.error('Client number create error:', error);
    return res.status(500).json({ error: 'Failed to create phone number' });
  }
};

exports.updateClientNumber = async (req, res) => {
  try {
    const clientAccount = await findScopedClientAccount(req, req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const numberRecord = await ClientPhoneNumber.findOne({
      _id: req.params.numberId,
      clientAccountId: clientAccount._id,
    });
    if (!numberRecord) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    const payloadResult = await buildNumberPayload({ req, clientAccount, existingNumber: numberRecord });
    if (payloadResult.error) {
      return res.status(400).json({ error: payloadResult.error });
    }

    Object.assign(numberRecord, payloadResult.payload);
    if (numberRecord.status !== 'archived') {
      numberRecord.archivedAt = null;
      numberRecord.archivedBy = null;
    } else {
      numberRecord.archivedAt = numberRecord.archivedAt || new Date();
      numberRecord.archivedBy = numberRecord.archivedBy || req.user?._id || null;
    }
    await numberRecord.save();
    await syncClientAccountAssignedNumbers(clientAccount._id);

    const populated = await populateClientPhoneNumberQuery(ClientPhoneNumber.findById(numberRecord._id));
    return res.json({ number: sanitizeClientPhoneNumber(populated) });
  } catch (error) {
    console.error('Client number update error:', error);
    return res.status(500).json({ error: 'Failed to update phone number' });
  }
};

exports.deleteClientNumber = async (req, res) => {
  try {
    const clientAccount = await findScopedClientAccount(req, req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const numberRecord = await ClientPhoneNumber.findOne({
      _id: req.params.numberId,
      clientAccountId: clientAccount._id,
    });

    if (!numberRecord) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    numberRecord.status = 'archived';
    numberRecord.archivedAt = numberRecord.archivedAt || new Date();
    numberRecord.archivedBy = numberRecord.archivedBy || req.user?._id || null;
    await numberRecord.save();
    await syncClientAccountAssignedNumbers(clientAccount._id);
    return res.json({ success: true });
  } catch (error) {
    console.error('Client number archive error:', error);
    return res.status(500).json({ error: 'Failed to archive phone number' });
  }
};

exports.listAllClientNumbers = async (req, res) => {
  try {
    const includeArchived = String(req.query?.includeArchived || '').toLowerCase() === 'true';
    const query = includeArchived ? {} : { archivedAt: null, status: { $ne: 'archived' } };
    const numbers = await populateClientPhoneNumberQuery(
      ClientPhoneNumber.find(query).sort({ updatedAt: -1, createdAt: -1 })
    );

    return res.json({ numbers: numbers.map(sanitizeClientPhoneNumber) });
  } catch (error) {
    console.error('Admin client number list error:', error);
    return res.status(500).json({ error: 'Failed to load phone numbers' });
  }
};

exports.updateClientNumberById = async (req, res) => {
  try {
    const numberRecord = await ClientPhoneNumber.findById(req.params.numberId);
    if (!numberRecord) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    const clientAccount = await ClientAccount.findById(numberRecord.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const payloadResult = await buildNumberPayload({ req, clientAccount, existingNumber: numberRecord });
    if (payloadResult.error) {
      return res.status(400).json({ error: payloadResult.error });
    }

    Object.assign(numberRecord, payloadResult.payload);
    if (numberRecord.status !== 'archived') {
      numberRecord.archivedAt = null;
      numberRecord.archivedBy = null;
    } else {
      numberRecord.archivedAt = numberRecord.archivedAt || new Date();
      numberRecord.archivedBy = numberRecord.archivedBy || req.user?._id || null;
    }
    await numberRecord.save();
    await syncClientAccountAssignedNumbers(clientAccount._id);

    const populated = await populateClientPhoneNumberQuery(ClientPhoneNumber.findById(numberRecord._id));
    return res.json({ number: sanitizeClientPhoneNumber(populated) });
  } catch (error) {
    console.error('Admin client number update error:', error);
    return res.status(500).json({ error: 'Failed to update phone number' });
  }
};

exports.archiveClientNumberById = async (req, res) => {
  try {
    const numberRecord = await ClientPhoneNumber.findById(req.params.numberId);
    if (!numberRecord) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    numberRecord.status = 'archived';
    numberRecord.archivedAt = numberRecord.archivedAt || new Date();
    numberRecord.archivedBy = numberRecord.archivedBy || req.user?._id || null;
    await numberRecord.save();
    await syncClientAccountAssignedNumbers(numberRecord.clientAccountId);

    const populated = await populateClientPhoneNumberQuery(ClientPhoneNumber.findById(numberRecord._id));
    return res.json({ number: sanitizeClientPhoneNumber(populated) });
  } catch (error) {
    console.error('Admin client number archive error:', error);
    return res.status(500).json({ error: 'Failed to archive phone number' });
  }
};
