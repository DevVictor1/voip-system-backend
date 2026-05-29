const mongoose = require('mongoose');
const ClientAccount = require('../models/ClientAccount');
const User = require('../models/User');
const { isPlatformAdmin } = require('../utils/accessControl');
const { getClientAccountIdString } = require('../utils/clientOwnership');

const normalizeChecklistKey = (value) => String(value || '').trim().toLowerCase();

const isChecklistItemComplete = (checklist = [], key) => (
  checklist.some((item) => normalizeChecklistKey(item?.key) === key && Boolean(item?.completed))
);

const CLIENT_ACCOUNT_ACTIVITY_LIMIT = 100;
const SCOPED_ASSIGNABLE_ROLES = new Set(['agent', 'client_admin', 'client_user']);

const normalizeTrimmedText = (value) => String(value || '').trim();

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

const validateAssignableUsers = async ({
  assignedUserIds,
  clientAccountId,
  allowDifferentClientAccounts = false,
}) => {
  const normalized = normalizeObjectIdList(assignedUserIds);
  if (normalized.error) return normalized;

  if (normalized.ids.length === 0) {
    return { userIds: [] };
  }

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

const listAssignableUsersForClient = async (clientAccountId, includeAllUsers = false) => {
  const clientId = getClientAccountIdString(clientAccountId);
  const query = includeAllUsers
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

  return users.map((user) => ({
    id: String(user._id),
    name: user.name || '',
    email: user.email || '',
    role: user.role || '',
    isActive: typeof user.isActive === 'boolean' ? user.isActive : true,
    clientAccountId: getClientAccountIdString(user.clientAccountId) || null,
    alreadyLinkedToThisClient: getClientAccountIdString(user.clientAccountId) === clientId,
  }));
};

const buildChecklistSummary = (checklist = []) => {
  const items = Array.isArray(checklist) ? checklist : [];
  const completedCount = items.filter((item) => item?.completed).length;
  const totalItems = items.length;
  const progressPercentage = totalItems > 0
    ? Math.round((completedCount / totalItems) * 100)
    : 0;

  let onboardingStatus = 'not_started';
  if (completedCount > 0) {
    onboardingStatus = completedCount === totalItems ? 'ready' : 'in_progress';
  }

  return {
    checklist: items.map((item) => ({
      key: normalizeChecklistKey(item?.key),
      label: item?.label || '',
      completed: Boolean(item?.completed),
    })),
    completedItems: items
      .filter((item) => item?.completed)
      .map((item) => ({
        key: normalizeChecklistKey(item?.key),
        label: item?.label || '',
      })),
    remainingItems: items
      .filter((item) => !item?.completed)
      .map((item) => ({
        key: normalizeChecklistKey(item?.key),
        label: item?.label || '',
      })),
    progressPercentage,
    onboardingStatus,
  };
};

const buildProvisioningReadinessSummary = ({
  account,
  checklistSummary,
  assignedUsers,
  assignedNumberRecords,
  assignedNumbers,
}) => {
  const seatLimit = Number.isFinite(account?.seatLimit) ? account.seatLimit : 0;
  const seatUsage = assignedUsers.length;
  const assignedNumbersCount = assignedNumberRecords.length || assignedNumbers.length;
  const hasClientAdmin = Boolean(account?.adminUserId?._id);
  const hasUsersSeatsPlan = seatLimit > 0 || seatUsage > 0;
  const hasPhoneNumbers = assignedNumbersCount > 0;
  const hasReseller = Boolean(account?.resellerId?._id);
  const isAccountActive = String(account?.accountStatus || '').trim().toLowerCase() === 'active';
  const smsComplianceChecked = isChecklistItemComplete(checklistSummary.checklist, 'sms_compliance_checked');
  const readyForProduction = isChecklistItemComplete(checklistSummary.checklist, 'ready_for_production');

  const readinessChecks = [
    { key: 'client_admin_assigned', label: 'Client admin assigned', completed: hasClientAdmin },
    { key: 'users_seats_planned', label: 'Users/seats planned', completed: hasUsersSeatsPlan },
    { key: 'phone_numbers_planned', label: 'Phone numbers planned', completed: hasPhoneNumbers },
    { key: 'onboarding_checklist_completed', label: 'Onboarding checklist completed', completed: checklistSummary.progressPercentage === 100 },
    { key: 'account_status_active', label: 'Account status active', completed: isAccountActive },
    { key: 'reseller_assigned', label: 'Reseller assigned', completed: hasReseller },
    { key: 'sms_compliance_checked', label: 'SMS compliance/A2P status checked', completed: smsComplianceChecked },
    { key: 'ready_for_production', label: 'Ready for production flag set', completed: readyForProduction },
  ];

  const missingItems = readinessChecks.filter((item) => !item.completed);
  const readinessPercentage = Math.round(
    (readinessChecks.filter((item) => item.completed).length / readinessChecks.length) * 100
  );

  let readinessStatus = 'not_ready';
  if (missingItems.length === 0 && readinessPercentage === 100 && checklistSummary.progressPercentage === 100) {
    readinessStatus = 'ready';
  } else if (readinessPercentage > 0 || checklistSummary.progressPercentage > 0) {
    readinessStatus = 'needs_attention';
  }

  return {
    readinessStatus,
    readinessPercentage,
    missingItems: missingItems.map((item) => item.label),
    checks: readinessChecks,
    readyForProduction,
  };
};

const sanitizeClientPortalAccount = (account) => {
  const checklistSummary = buildChecklistSummary(account?.onboardingChecklist);
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
  const assignedNumberRecords = Array.isArray(account?.assignedNumberRecords)
    ? account.assignedNumberRecords.filter((record) => String(record?.phoneNumber || '').trim())
    : [];
  const assignedNumbers = Array.isArray(account?.assignedNumbers)
    ? account.assignedNumbers.filter((value) => String(value || '').trim())
    : [];
  const readinessSummary = buildProvisioningReadinessSummary({
    account,
    checklistSummary,
    assignedUsers,
    assignedNumberRecords,
    assignedNumbers,
  });
  const seatLimit = Number.isFinite(account.seatLimit) ? account.seatLimit : 0;
  const seatUsage = assignedUsers.length;
  const assignedNumbersCount = assignedNumberRecords.length || assignedNumbers.length;

  return {
    id: String(account._id),
    companyName: account.companyName || '',
    accountStatus: account.accountStatus || 'pending',
    plan: account.plan || '',
    seatLimit,
    seatUsage,
    seatRemaining: Math.max(0, seatLimit - seatUsage),
    seatOverCapacity: seatLimit >= 0 && seatUsage > seatLimit,
    assignedUsers,
    assignedNumbersCount,
    assignedNumberRecords: assignedNumberRecords.map((record) => ({
      phoneNumber: record.phoneNumber || '',
      label: record.label || '',
      type: record.type || 'voice',
      status: record.status || 'pending',
      assignedUser: record?.assignedUserId?._id
        ? {
            id: String(record.assignedUserId._id),
            name: record.assignedUserId.name || '',
            email: record.assignedUserId.email || '',
            role: record.assignedUserId.role || '',
          }
        : null,
      assignedDepartment: record.assignedDepartment || '',
      notes: record.notes || '',
    })),
    reseller: account.resellerId?._id
      ? {
          id: String(account.resellerId._id),
          companyName: account.resellerId.companyName || '',
          status: account.resellerId.status || 'pending',
        }
      : null,
    adminUser: account.adminUserId?._id
      ? {
          id: String(account.adminUserId._id),
          name: account.adminUserId.name || '',
          email: account.adminUserId.email || '',
          role: account.adminUserId.role || '',
        }
      : null,
    onboardingChecklist: checklistSummary.checklist,
    onboardingCompletedItems: checklistSummary.completedItems,
    onboardingRemainingItems: checklistSummary.remainingItems,
    onboardingProgressPercentage: checklistSummary.progressPercentage,
    onboardingStatus: account.onboardingStatus || checklistSummary.onboardingStatus,
    smsComplianceChecked: isChecklistItemComplete(checklistSummary.checklist, 'sms_compliance_checked'),
    readyForProduction: readinessSummary.readyForProduction,
    provisioningReadiness: readinessSummary,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
};

exports.getClientPortalSummary = async (req, res) => {
  try {
    const contextClientAccountId = req.accountContext?.selectedClientAccountId
      || req.accountContext?.primaryClientAccountId;

    const clientAccount = contextClientAccountId
      ? await findPopulatedClientAccountById(contextClientAccountId)
      : await populateClientAccountQuery(ClientAccount.findOne({
          $or: [
            { adminUserId: req.user._id },
            { assignedUserIds: req.user._id },
          ],
        }).sort({ updatedAt: -1 }));

    if (!clientAccount) {
      return res.json({
        clientAccount: null,
        portalState: 'unlinked',
      });
    }

    return res.json({
      clientAccount: sanitizeClientPortalAccount(clientAccount),
      portalState: 'linked',
    });
  } catch (error) {
    console.error('Client portal summary error:', error);
    return res.status(500).json({ error: 'Failed to load client portal summary' });
  }
};

exports.getClientPortalAccountDetails = async (req, res) => {
  try {
    const clientAccount = await findPopulatedClientAccountById(req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    return res.json({
      clientAccount: sanitizeClientPortalAccount(clientAccount),
    });
  } catch (error) {
    console.error('Client portal details error:', error);
    return res.status(500).json({ error: 'Failed to load client organization' });
  }
};

exports.updateClientPortalProfile = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findById(req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const nextCompanyName = normalizeTrimmedText(req.body?.companyName ?? clientAccount.companyName);
    const nextPlan = normalizeTrimmedText(req.body?.plan ?? clientAccount.plan);

    if (!nextCompanyName) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    const changed = (
      clientAccount.companyName !== nextCompanyName
      || clientAccount.plan !== nextPlan
    );

    clientAccount.companyName = nextCompanyName;
    clientAccount.plan = nextPlan;

    if (changed) {
      appendActivityEntry(
        clientAccount,
        'profile_updated',
        'Client organization profile was updated',
        req.user
      );
    }

    await clientAccount.save();

    const populatedAccount = await findPopulatedClientAccountById(clientAccount._id);
    return res.json({
      clientAccount: sanitizeClientPortalAccount(populatedAccount),
    });
  } catch (error) {
    console.error('Client portal update profile error:', error);
    return res.status(500).json({ error: 'Failed to update client organization' });
  }
};

exports.listClientPortalAssignableUsers = async (req, res) => {
  try {
    const users = await listAssignableUsersForClient(
      req.params.clientAccountId,
      isPlatformAdmin(req.user)
    );

    return res.json({ users });
  } catch (error) {
    console.error('Client portal list assignable users error:', error);
    return res.status(500).json({ error: 'Failed to load available users' });
  }
};

exports.updateClientPortalAssignedUsers = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findById(req.params.clientAccountId);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const assignedUsersLookup = await validateAssignableUsers({
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
        'Client organization users were updated',
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
    return res.json({
      clientAccount: sanitizeClientPortalAccount(populatedAccount),
    });
  } catch (error) {
    console.error('Client portal update users error:', error);
    return res.status(500).json({ error: 'Failed to update assigned users' });
  }
};
