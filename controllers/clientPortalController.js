const ClientAccount = require('../models/ClientAccount');

const normalizeChecklistKey = (value) => String(value || '').trim().toLowerCase();

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
    progressPercentage,
    onboardingStatus,
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

  return {
    id: String(account._id),
    companyName: account.companyName || '',
    accountStatus: account.accountStatus || 'pending',
    plan: account.plan || '',
    seatLimit: Number.isFinite(account.seatLimit) ? account.seatLimit : 0,
    seatUsage: assignedUsers.length,
    assignedUsers,
    assignedNumbersCount: assignedNumberRecords.length || assignedNumbers.length,
    assignedNumberRecords: assignedNumberRecords.map((record) => ({
      phoneNumber: record.phoneNumber || '',
      label: record.label || '',
      type: record.type || 'voice',
      status: record.status || 'pending',
      assignedDepartment: record.assignedDepartment || '',
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
    onboardingProgressPercentage: checklistSummary.progressPercentage,
    onboardingStatus: account.onboardingStatus || checklistSummary.onboardingStatus,
    readyForProduction: checklistSummary.checklist.some(
      (item) => item.key === 'ready_for_production' && item.completed
    ),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
};

exports.getClientPortalSummary = async (req, res) => {
  try {
    const clientAccount = await ClientAccount.findOne({
      $or: [
        { adminUserId: req.user._id },
        { assignedUserIds: req.user._id },
      ],
    })
      .populate('resellerId', 'companyName status')
      .populate('adminUserId', 'name email role')
      .populate('assignedUserIds', 'name email role')
      .sort({ updatedAt: -1 });

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
