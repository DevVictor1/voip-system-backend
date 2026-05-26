const Reseller = require('../models/Reseller');
const ClientAccount = require('../models/ClientAccount');

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
    companyName: account.companyName || '',
    accountStatus: account.accountStatus || 'pending',
    plan: account.plan || '',
    seatLimit: Number.isFinite(account.seatLimit) ? account.seatLimit : 0,
    seatUsage: assignedUsers.length,
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
    const reseller = await Reseller.findOne({
      assignedUserIds: req.user._id,
    })
      .populate('assignedUserIds', 'name email role')
      .sort({ updatedAt: -1 });

    if (!reseller) {
      return res.json({
        reseller: null,
        clientAccounts: [],
        portalState: 'unlinked',
      });
    }

    const clientAccounts = await ClientAccount.find({
      resellerId: reseller._id,
    })
      .populate('assignedUserIds', 'name email role')
      .sort({ createdAt: -1 });

    const sanitizedClientAccounts = clientAccounts.map(sanitizeClientAccount);

    return res.json({
      reseller: sanitizeReseller(reseller, sanitizedClientAccounts),
      clientAccounts: sanitizedClientAccounts,
      portalState: 'linked',
    });
  } catch (error) {
    console.error('Reseller portal summary error:', error);
    return res.status(500).json({ error: 'Failed to load reseller portal summary' });
  }
};
