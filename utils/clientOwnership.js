const mongoose = require('mongoose');

const normalizeClientAccountId = (value) => {
  if (!value) return null;

  const text = String(value?._id || value).trim();
  if (!text || !mongoose.Types.ObjectId.isValid(text)) {
    return null;
  }

  return new mongoose.Types.ObjectId(text);
};

const getClientAccountIdString = (value) => {
  const normalized = normalizeClientAccountId(value);
  return normalized ? String(normalized) : '';
};

const recordBelongsToClientAccount = (record, clientAccountId) => {
  const expectedId = getClientAccountIdString(clientAccountId);
  const actualId = getClientAccountIdString(record?.clientAccountId);

  if (!expectedId || !actualId) {
    return false;
  }

  return actualId === expectedId;
};

const assignClientAccountIdIfPresent = (target, clientAccountId) => {
  const normalized = normalizeClientAccountId(clientAccountId);
  if (!target || !normalized) {
    return target;
  }

  target.clientAccountId = normalized;
  return target;
};

const resolveUserPrimaryClientAccount = async (user) => {
  if (!user?._id) return null;

  if (user.clientAccountId) {
    return normalizeClientAccountId(user.clientAccountId);
  }

  const ClientAccount = require('../models/ClientAccount');
  const clientAccount = await ClientAccount.findOne({
    $or: [
      { adminUserId: user._id },
      { assignedUserIds: user._id },
    ],
  })
    .select('_id')
    .sort({ updatedAt: -1 });

  return clientAccount?._id || null;
};

const buildClientOwnershipQuery = (clientAccountId) => {
  const normalized = normalizeClientAccountId(clientAccountId);
  return normalized ? { clientAccountId: normalized } : {};
};

module.exports = {
  normalizeClientAccountId,
  getClientAccountIdString,
  recordBelongsToClientAccount,
  assignClientAccountIdIfPresent,
  resolveUserPrimaryClientAccount,
  buildClientOwnershipQuery,
};
