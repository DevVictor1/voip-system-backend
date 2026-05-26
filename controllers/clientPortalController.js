const ClientAccount = require('../models/ClientAccount');

const normalizeChecklistKey = (value) => String(value || '').trim().toLowerCase();

const isChecklistItemComplete = (checklist = [], key) => (
  checklist.some((item) => normalizeChecklistKey(item?.key) === key && Boolean(item?.completed))
);

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
    const clientAccount = await ClientAccount.findOne({
      $or: [
        { adminUserId: req.user._id },
        { assignedUserIds: req.user._id },
      ],
    })
      .populate('resellerId', 'companyName status')
      .populate('adminUserId', 'name email role')
      .populate('assignedUserIds', 'name email role')
      .populate('assignedNumberRecords.assignedUserId', 'name email role')
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
