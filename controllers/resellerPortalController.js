const mongoose = require('mongoose');
const Reseller = require('../models/Reseller');
const ClientAccount = require('../models/ClientAccount');
const User = require('../models/User');
const { isPlatformAdmin } = require('../utils/accessControl');
const { getClientAccountIdString } = require('../utils/clientOwnership');

const CLIENT_ACCOUNT_STATUSES = new Set(['active', 'inactive', 'suspended', 'pending']);
const CLIENT_ACCOUNT_ACTIVITY_LIMIT = 100;
const SCOPED_ASSIGNABLE_ROLES = new Set(['agent', 'client_admin', 'client_user']);

const normalizeTrimmedText = (value) => String(value || '').trim();

const normalizeStatus = (value, allowedValues, fallback) => {
  const normalized = normalizeTrimmedText(value).toLowerCase();
  return allowedValues.has(normalized) ? normalized : fallback;
};

const normalizeNonNegativeInteger = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
};

const normalizeOptionalObjectId = (value) => {
  const trimmed = normalizeTrimmedText(value);
  if (!trimmed) return null;
  return mongoose.Types.ObjectId.isValid(trimmed) ? trimmed : '__invalid__';
};

const normalizeObjectIdList = (values = []) => {
  if (!Array.isArray(values)) return { error: 'assignedUserIds must be an array' };

  const normalizedIds = [];
  const seenIds = new Set();

  for (const value of values) {
    const id = normalizeTrimmedText(value);
    if (!id) continue;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return { error: 'assignedUserIds contains an invalid user id' };
    }
    if (!seenIds.has(id)) {
      normalizedIds.push(id);
      seenIds.add(id);
    }
  }

  return { ids: normalizedIds };
};

const getActorName = (user) => normalizeTrimmedText(user?.name || user?.email || 'Portal user');

const appendActivityEntry = (account, action, description, user) => {
  const currentEntries = Array.isArray(account.activityLog) ? account.activityLog : [];
  account.activityLog = [
    ...currentEntries,
    {
      action,
      description,
      actorId: user?._id || null,
      actorName: getActorName(user),
      createdAt: new Date(),
    },
  ].slice(-CLIENT_ACCOUNT_ACTIVITY_LIMIT);
};

const populateClientAccountQuery = (query) => query
  .populate('resellerId', 'name companyName status')
  .populate('adminUserId', 'name email role clientAccountId')
  .populate('assignedUserIds', 'name email role clientAccountId isActive')
  .populate('assignedNumberRecords.assignedUserId', 'name email role clientAccountId');

const findPopulatedClientAccountById = (clientAccountId) => (
  populateClientAccountQuery(ClientAccount.findById(clientAccountId))
);

const validateReferencedUser = async ({ userId, clientAccountId, allowDifferentClientAccounts = false }) => {
  const normalizedUserId = normalizeOptionalObjectId(userId);
  if (!normalizedUserId) return { user: null };
  if (normalizedUserId === '__invalid__') return { error: 'Selected user id is invalid' };

  const user = await User.findById(normalizedUserId).select('name email role clientAccountId isActive');
  if (!user) return { error: 'Selected user could not be found' };

  if (!allowDifferentClientAccounts) {
    if (!SCOPED_ASSIGNABLE_ROLES.has(String(user.role || '').toLowerCase())) {
      return { error: 'Selected user has a role that cannot be assigned from this portal' };
    }

    const userClientAccountId = getClientAccountIdString(user.clientAccountId);
    const clientId = getClientAccountIdString(clientAccountId);
    if (userClientAccountId && userClientAccountId !== clientId) {
      return { error: 'Selected user belongs to another client organization' };
    }

    const assignedElsewhere = await ClientAccount.exists({
      _id: { $ne: clientAccountId },
      assignedUserIds: user._id,
    });

    if (assignedElsewhere) {
      return { error: 'Selected user belongs to another client organization' };
    }
  }

  return { user };
};

const validateReferencedUsers = async ({
  assignedUserIds,
  clientAccountId,
  allowDifferentClientAccounts = false,
}) => {
  const normalized = normalizeObjectIdList(assignedUserIds);
  if (normalized.error) return normalized;
  if (normalized.ids.length === 0) return { userIds: [] };

  const users = await User.find({ _id: { $in: normalized.ids } })
    .select('name email role clientAccountId isActive');

  if (users.length !== normalized.ids.length) {
    return { error: 'One or more selected users could not be found' };
  }

  if (!allowDifferentClientAccounts) {
    const privilegedUser = users.find((user) => !SCOPED_ASSIGNABLE_ROLES.has(String(user.role || '').toLowerCase()));
    if (privilegedUser) {
      return { error: 'One or more selected users has a role that cannot be assigned from this portal' };
    }

    const clientId = getClientAccountIdString(clientAccountId);
    const blockedUser = users.find((user) => {
      const userClientAccountId = getClientAccountIdString(user.clientAccountId);
      return userClientAccountId && userClientAccountId !== clientId;
    });

    if (blockedUser) {
      return { error: 'One or more selected users belongs to another client organization' };
    }

    const assignedElsewhere = await ClientAccount.exists({
      _id: { $ne: clientAccountId },
      assignedUserIds: { $in: normalized.ids },
    });

    if (assignedElsewhere) {
      return { error: 'One or more selected users belongs to another client organization' };
    }
  }

  return { userIds: normalized.ids };
};

const resolveManagedResellerId = async (req) => {
  if (!isPlatformAdmin(req.user)) {
    return req.accountContext?.resellerId || null;
  }

  const requestedResellerId = normalizeOptionalObjectId(
    req.body?.resellerId || req.query?.resellerId || req.accountContext?.resellerId
  );
  if (requestedResellerId === '__invalid__') return '__invalid__';
  return requestedResellerId;
};

const normalizeChecklistKey = (value) => String(value || '').trim().toLowerCase();

const buildChecklistProgress = (checklist = []) => {
  const items = Array.isArray(checklist) ? checklist : [];
  const completedCount = items.filter((item) => item?.completed).length;
  const totalItems = items.length;

  return {
    progressPercentage: totalItems > 0
      ? Math.round((completedCount / totalItems) * 100)
      : 0,
    readyForProduction: items.some(
      (item) => normalizeChecklistKey(item?.key) === 'ready_for_production' && Boolean(item?.completed)
    ),
  };
};

const sanitizeClientAccount = (account) => {
  const assignedNumberRecords = Array.isArray(account?.assignedNumberRecords)
    ? account.assignedNumberRecords.filter((record) => String(record?.phoneNumber || '').trim())
    : [];
  const assignedNumbers = Array.isArray(account?.assignedNumbers)
    ? account.assignedNumbers.filter((value) => String(value || '').trim())
    : [];
  const assignedUsers = Array.isArray(account?.assignedUserIds)
    ? account.assignedUserIds
        .filter((user) => user?._id)
        .map((user) => ({
          id: String(user._id),
          name: user.name || '',
          email: user.email || '',
          role: user.role || '',
        }))
    : [];
  const checklistProgress = buildChecklistProgress(account?.onboardingChecklist);

  return {
    id: String(account._id),
    resellerId: account.resellerId?._id
      ? String(account.resellerId._id)
      : (account.resellerId ? String(account.resellerId) : null),
    reseller: account.resellerId?._id
      ? {
          id: String(account.resellerId._id),
          companyName: account.resellerId.companyName || '',
          status: account.resellerId.status || 'pending',
        }
      : null,
    companyName: account.companyName || '',
    accountStatus: account.accountStatus || 'pending',
    plan: account.plan || '',
    seatLimit: Number.isFinite(account.seatLimit) ? account.seatLimit : 0,
    seatUsage: assignedUsers.length,
    assignedUsers,
    assignedUserIds: assignedUsers.map((user) => user.id),
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
    assignedNumbersCount: assignedNumberRecords.length || assignedNumbers.length,
    onboardingProgressPercentage: checklistProgress.progressPercentage,
    readyForProduction: checklistProgress.readyForProduction,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
};

const sanitizeReseller = (reseller, clientAccounts = []) => {
  const activeClients = clientAccounts.filter((account) => account.accountStatus === 'active').length;
  const suspendedOrPendingClients = clientAccounts.filter((account) => (
    account.accountStatus === 'suspended' || account.accountStatus === 'pending'
  )).length;
  const totalAssignedNumberMetadataCount = clientAccounts.reduce((total, account) => (
    total + (Number(account.assignedNumbersCount) || 0)
  ), 0);

  return {
    id: String(reseller._id),
    name: reseller.name || '',
    companyName: reseller.companyName || '',
    contactEmail: reseller.contactEmail || '',
    contactPhone: reseller.contactPhone || '',
    status: reseller.status || 'pending',
    totalClientAccounts: clientAccounts.length,
    activeClients,
    suspendedOrPendingClients,
    totalAssignedNumberMetadataCount,
    assignedUsersCount: Array.isArray(reseller.assignedUserIds)
      ? reseller.assignedUserIds.filter((user) => user?._id).length
      : 0,
    createdAt: reseller.createdAt,
    updatedAt: reseller.updatedAt,
  };
};

exports.getResellerPortalSummary = async (req, res) => {
  try {
    const reseller = req.accountContext?.reseller
      || await Reseller.findOne({ assignedUserIds: req.user._id })
        .populate('assignedUserIds', 'name email role')
        .sort({ updatedAt: -1 });

    if (!reseller && !isPlatformAdmin(req.user)) {
      return res.json({
        reseller: null,
        clientAccounts: [],
        portalState: 'unlinked',
      });
    }

    const clientAccounts = await populateClientAccountQuery(
      ClientAccount.find(reseller?._id ? { resellerId: reseller._id } : {})
        .sort({ createdAt: -1 })
    );

    const sanitizedClientAccounts = clientAccounts.map(sanitizeClientAccount);

    return res.json({
      reseller: reseller
        ? sanitizeReseller(reseller, sanitizedClientAccounts)
        : {
            id: null,
            name: 'Platform Admin',
            companyName: 'All Partner Accounts',
            status: 'active',
            totalClientAccounts: sanitizedClientAccounts.length,
            activeClients: sanitizedClientAccounts.filter((account) => account.accountStatus === 'active').length,
            suspendedOrPendingClients: sanitizedClientAccounts.filter((account) => (
              account.accountStatus === 'suspended' || account.accountStatus === 'pending'
            )).length,
            totalAssignedNumberMetadataCount: sanitizedClientAccounts.reduce((total, account) => (
              total + (Number(account.assignedNumbersCount) || 0)
            ), 0),
            assignedUsersCount: 0,
          },
      clientAccounts: sanitizedClientAccounts,
      portalState: 'linked',
    });
  } catch (error) {
    console.error('Reseller portal summary error:', error);
    return res.status(500).json({ error: 'Failed to load reseller portal summary' });
  }
};

exports.listResellerPortalClientAccounts = async (req, res) => {
  try {
    const resellerId = await resolveManagedResellerId(req);
    if (resellerId === '__invalid__') {
      return res.status(400).json({ error: 'Reseller id is invalid' });
    }

    if (!resellerId && !isPlatformAdmin(req.user)) {
      return res.status(403).json({ error: 'Reseller access is required' });
    }

    const query = resellerId ? { resellerId } : {};
    const clientAccounts = await populateClientAccountQuery(
      ClientAccount.find(query).sort({ createdAt: -1 })
    );

    return res.json({
      clientAccounts: clientAccounts.map(sanitizeClientAccount),
    });
  } catch (error) {
    console.error('Reseller portal list clients error:', error);
    return res.status(500).json({ error: 'Failed to load client organizations' });
  }
};

exports.getResellerPortalClientAccountDetails = async (req, res) => {
  try {
    const clientAccount = await findPopulatedClientAccountById(req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    return res.json({ clientAccount: sanitizeClientAccount(clientAccount) });
  } catch (error) {
    console.error('Reseller portal client details error:', error);
    return res.status(500).json({ error: 'Failed to load client organization' });
  }
};

exports.createResellerPortalClientAccount = async (req, res) => {
  try {
    const resellerId = await resolveManagedResellerId(req);
    if (resellerId === '__invalid__') {
      return res.status(400).json({ error: 'Reseller id is invalid' });
    }

    if (!resellerId) {
      return res.status(400).json({ error: 'Reseller is required to create a client organization' });
    }

    const reseller = await Reseller.findById(resellerId).select('_id');
    if (!reseller) {
      return res.status(404).json({ error: 'Reseller not found' });
    }

    const companyName = normalizeTrimmedText(req.body?.companyName);
    if (!companyName) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    const clientAccount = await ClientAccount.create({
      resellerId,
      companyName,
      accountStatus: normalizeStatus(req.body?.accountStatus, CLIENT_ACCOUNT_STATUSES, 'pending'),
      plan: normalizeTrimmedText(req.body?.plan),
      seatLimit: normalizeNonNegativeInteger(req.body?.seatLimit, 0),
      activityLog: [{
        action: 'account_created',
        description: 'Client organization was created from the partner console',
        actorId: req.user?._id || null,
        actorName: getActorName(req.user),
        createdAt: new Date(),
      }],
    });

    const populatedAccount = await findPopulatedClientAccountById(clientAccount._id);
    return res.status(201).json({ clientAccount: sanitizeClientAccount(populatedAccount) });
  } catch (error) {
    console.error('Reseller portal create client error:', error);
    return res.status(500).json({ error: 'Failed to create client organization' });
  }
};

exports.updateResellerPortalClientAccount = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findById(req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const nextCompanyName = normalizeTrimmedText(req.body?.companyName ?? clientAccount.companyName);
    if (!nextCompanyName) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    const nextStatus = normalizeStatus(
      req.body?.accountStatus ?? clientAccount.accountStatus,
      CLIENT_ACCOUNT_STATUSES,
      clientAccount.accountStatus || 'pending'
    );
    const nextPlan = normalizeTrimmedText(req.body?.plan ?? clientAccount.plan);
    const nextSeatLimit = normalizeNonNegativeInteger(req.body?.seatLimit, clientAccount.seatLimit || 0);

    const changed = (
      clientAccount.companyName !== nextCompanyName
      || clientAccount.accountStatus !== nextStatus
      || clientAccount.plan !== nextPlan
      || Number(clientAccount.seatLimit || 0) !== nextSeatLimit
    );

    clientAccount.companyName = nextCompanyName;
    clientAccount.accountStatus = nextStatus;
    clientAccount.plan = nextPlan;
    clientAccount.seatLimit = nextSeatLimit;

    if (changed) {
      appendActivityEntry(
        clientAccount,
        'details_updated',
        'Client organization details were updated from the partner console',
        req.user
      );
    }

    await clientAccount.save();

    const populatedAccount = await findPopulatedClientAccountById(clientAccount._id);
    return res.json({ clientAccount: sanitizeClientAccount(populatedAccount) });
  } catch (error) {
    console.error('Reseller portal update client error:', error);
    return res.status(500).json({ error: 'Failed to update client organization' });
  }
};

exports.assignResellerPortalClientAdmin = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findById(req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const userLookup = await validateReferencedUser({
      userId: req.body?.adminUserId,
      clientAccountId: clientAccount._id,
      allowDifferentClientAccounts: isPlatformAdmin(req.user),
    });

    if (userLookup.error) {
      return res.status(400).json({ error: userLookup.error });
    }

    const currentAdminId = getClientAccountIdString(clientAccount.adminUserId);
    const nextAdminId = userLookup.user?._id ? String(userLookup.user._id) : '';

    clientAccount.adminUserId = userLookup.user?._id || null;
    if (userLookup.user?._id) {
      userLookup.user.clientAccountId = clientAccount._id;
      await userLookup.user.save();
      const currentAssignedIds = Array.isArray(clientAccount.assignedUserIds)
        ? clientAccount.assignedUserIds.map((value) => String(value))
        : [];
      if (!currentAssignedIds.includes(String(userLookup.user._id))) {
        clientAccount.assignedUserIds = [...currentAssignedIds, userLookup.user._id];
      }
    }

    if (currentAdminId !== nextAdminId) {
      appendActivityEntry(
        clientAccount,
        'client_admin_changed',
        nextAdminId ? 'Client administrator was assigned' : 'Client administrator was cleared',
        req.user
      );
    }

    await clientAccount.save();

    const populatedAccount = await findPopulatedClientAccountById(clientAccount._id);
    return res.json({ clientAccount: sanitizeClientAccount(populatedAccount) });
  } catch (error) {
    console.error('Reseller portal assign admin error:', error);
    return res.status(500).json({ error: 'Failed to update client administrator' });
  }
};

exports.listResellerPortalAssignableUsers = async (req, res) => {
  try {
    const clientAccountId = req.params.clientAccountId;
    const clientId = getClientAccountIdString(clientAccountId);
    const query = isPlatformAdmin(req.user)
      ? {}
      : {
          $or: [
            { clientAccountId: null },
            { clientAccountId },
            { clientAccountId: { $exists: false } },
          ],
        };

    const users = await User.find(query)
      .select('name email role clientAccountId isActive')
      .sort({ name: 1, email: 1 });

    return res.json({
      users: users.map((user) => ({
        id: String(user._id),
        name: user.name || '',
        email: user.email || '',
        role: user.role || '',
        isActive: typeof user.isActive === 'boolean' ? user.isActive : true,
        clientAccountId: getClientAccountIdString(user.clientAccountId) || null,
        alreadyLinkedToThisClient: getClientAccountIdString(user.clientAccountId) === clientId,
      })),
    });
  } catch (error) {
    console.error('Reseller portal list assignable users error:', error);
    return res.status(500).json({ error: 'Failed to load available users' });
  }
};

exports.updateResellerPortalAssignedUsers = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findById(req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const assignedUsersLookup = await validateReferencedUsers({
      assignedUserIds: req.body?.assignedUserIds,
      clientAccountId: clientAccount._id,
      allowDifferentClientAccounts: isPlatformAdmin(req.user),
    });

    if (assignedUsersLookup.error) {
      return res.status(400).json({ error: assignedUsersLookup.error });
    }

    const currentIds = (Array.isArray(clientAccount.assignedUserIds) ? clientAccount.assignedUserIds : [])
      .map((value) => String(value))
      .sort();
    const nextIds = [...(assignedUsersLookup.userIds || [])].sort();
    const changed = currentIds.join('|') !== nextIds.join('|');

    clientAccount.assignedUserIds = assignedUsersLookup.userIds || [];

    if (changed) {
      appendActivityEntry(
        clientAccount,
        'assigned_users_changed',
        'Client organization users were updated from the partner console',
        req.user
      );
    }

    await clientAccount.save();
    const retainedUserIds = [
      ...(assignedUsersLookup.userIds || []),
      ...(clientAccount.adminUserId ? [clientAccount.adminUserId] : []),
    ];

    await User.updateMany(
      { _id: { $in: retainedUserIds } },
      { clientAccountId: clientAccount._id }
    );
    await User.updateMany(
      {
        clientAccountId: clientAccount._id,
        _id: { $nin: retainedUserIds },
      },
      { clientAccountId: null }
    );

    const populatedAccount = await findPopulatedClientAccountById(clientAccount._id);
    return res.json({ clientAccount: sanitizeClientAccount(populatedAccount) });
  } catch (error) {
    console.error('Reseller portal update users error:', error);
    return res.status(500).json({ error: 'Failed to update assigned users' });
  }
};
