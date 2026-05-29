const ClientAccount = require('../models/ClientAccount');
const Reseller = require('../models/Reseller');
const {
  getUserRole,
  isClientAdmin,
  isClientUser,
  isPlatformAdmin,
  isResellerAdmin,
} = require('../utils/accessControl');
const {
  getClientAccountIdString,
  normalizeClientAccountId,
  resolveUserPrimaryClientAccount,
} = require('../utils/clientOwnership');

// Stage 2 foundation only:
// This resolves tenant/client context for routes that opt in. It does not
// globally filter production messages, calls, SMS, contacts, teams, or Twilio flows.

const buildBaseContext = (user) => ({
  user,
  userId: user?._id ? String(user._id) : '',
  role: getUserRole(user),
  isPlatformAdmin: isPlatformAdmin(user),
  isResellerAdmin: isResellerAdmin(user),
  isClientAdmin: isClientAdmin(user),
  isClientUser: isClientUser(user),
  reseller: null,
  resellerId: null,
  primaryClientAccount: null,
  primaryClientAccountId: null,
  selectedClientAccount: null,
  selectedClientAccountId: null,
  requestedClientAccountId: null,
});

const getRequestedClientAccountId = (req) => {
  const candidates = [
    req.params?.clientAccountId,
    req.params?.accountId,
    req.query?.clientAccountId,
    req.query?.accountId,
    req.body?.clientAccountId,
    req.body?.accountId,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeClientAccountId(candidate);
    if (normalized) return normalized;
  }

  return null;
};

const findResellerForUser = async (user) => {
  if (!user?._id) return null;
  return Reseller.findOne({ assignedUserIds: user._id })
    .populate('assignedUserIds', 'name email role clientAccountId')
    .sort({ updatedAt: -1 });
};

const findPrimaryClientAccountForUser = async (user) => {
  const primaryClientAccountId = await resolveUserPrimaryClientAccount(user);
  if (!primaryClientAccountId) return null;

  return ClientAccount.findById(primaryClientAccountId)
    .populate('resellerId', 'name companyName status')
    .populate('adminUserId', 'name email role clientAccountId')
    .populate('assignedUserIds', 'name email role clientAccountId');
};

const findSelectedClientAccount = async ({ context, requestedClientAccountId }) => {
  if (!requestedClientAccountId) {
    return context.primaryClientAccount || null;
  }

  if (context.isPlatformAdmin) {
    return ClientAccount.findById(requestedClientAccountId)
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role clientAccountId')
      .populate('assignedUserIds', 'name email role clientAccountId');
  }

  if (context.isResellerAdmin && context.resellerId) {
    return ClientAccount.findOne({
      _id: requestedClientAccountId,
      resellerId: context.resellerId,
    })
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role clientAccountId')
      .populate('assignedUserIds', 'name email role clientAccountId');
  }

  const primaryClientAccountId = getClientAccountIdString(context.primaryClientAccountId);
  if (primaryClientAccountId && primaryClientAccountId === getClientAccountIdString(requestedClientAccountId)) {
    return context.primaryClientAccount || ClientAccount.findById(requestedClientAccountId)
      .populate('resellerId', 'name companyName status')
      .populate('adminUserId', 'name email role clientAccountId')
      .populate('assignedUserIds', 'name email role clientAccountId');
  }

  return null;
};

const resolveAccountContext = async (req, _res, next) => {
  try {
    const context = buildBaseContext(req.user);

    if (req.user?._id) {
      const [reseller, primaryClientAccount] = await Promise.all([
        findResellerForUser(req.user),
        findPrimaryClientAccountForUser(req.user),
      ]);

      context.reseller = reseller || null;
      context.resellerId = reseller?._id || null;
      context.primaryClientAccount = primaryClientAccount || null;
      context.primaryClientAccountId = primaryClientAccount?._id || null;
    }

    context.requestedClientAccountId = getRequestedClientAccountId(req);
    context.selectedClientAccount = await findSelectedClientAccount({
      context,
      requestedClientAccountId: context.requestedClientAccountId,
    });
    context.selectedClientAccountId = context.selectedClientAccount?._id || null;

    req.accountContext = context;
    req.reseller = context.reseller;
    req.clientAccount = context.selectedClientAccount || context.primaryClientAccount;

    return next();
  } catch (error) {
    console.error('Account context resolution error:', error);
    return next(error);
  }
};

const ensureAccountContext = async (req, res, next) => {
  const requestedClientAccountId = getRequestedClientAccountId(req);
  const existingRequestedClientAccountId = getClientAccountIdString(
    req.accountContext?.requestedClientAccountId
  );
  const nextRequestedClientAccountId = getClientAccountIdString(requestedClientAccountId);

  if (
    req.accountContext
    && (!nextRequestedClientAccountId || existingRequestedClientAccountId === nextRequestedClientAccountId)
  ) {
    return next();
  }

  return resolveAccountContext(req, res, next);
};

const requireClientContext = async (req, res, next) => {
  await ensureAccountContext(req, res, (error) => {
    if (error) return next(error);
    if (!req.accountContext?.selectedClientAccount && !req.accountContext?.primaryClientAccount) {
      return res.status(403).json({ error: 'Client account access is required' });
    }
    return next();
  });
};

const requireResellerContext = async (req, res, next) => {
  await ensureAccountContext(req, res, (error) => {
    if (error) return next(error);
    if (!req.accountContext?.reseller && !req.accountContext?.isPlatformAdmin) {
      return res.status(403).json({ error: 'Reseller access is required' });
    }
    return next();
  });
};

const canAccessClientAccountFromContext = (context, clientAccountId) => {
  if (!context || !clientAccountId) return false;
  if (context.isPlatformAdmin) return true;

  const requestedId = getClientAccountIdString(clientAccountId);
  const selectedId = getClientAccountIdString(context.selectedClientAccountId);
  const primaryId = getClientAccountIdString(context.primaryClientAccountId);

  return Boolean(requestedId && (requestedId === selectedId || requestedId === primaryId));
};

const canManageClientAccountFromContext = (context, clientAccountId) => {
  if (!canAccessClientAccountFromContext(context, clientAccountId)) {
    return false;
  }

  if (context.isPlatformAdmin || context.isResellerAdmin) {
    return true;
  }

  if (context.isClientAdmin) {
    const selectedAccount = context.selectedClientAccount || context.primaryClientAccount;
    return getClientAccountIdString(selectedAccount?.adminUserId) === context.userId;
  }

  return false;
};

const requireCanAccessClientAccount = (paramName = 'clientAccountId') => {
  return async (req, res, next) => {
    await ensureAccountContext(req, res, (error) => {
      if (error) return next(error);

      const requestedId = normalizeClientAccountId(
        req.params?.[paramName]
        || req.body?.clientAccountId
        || req.query?.clientAccountId
        || req.accountContext?.selectedClientAccountId
      );

      if (!requestedId || !canAccessClientAccountFromContext(req.accountContext, requestedId)) {
        return res.status(403).json({ error: 'Client account access denied' });
      }

      return next();
    });
  };
};

const requireCanManageClientAccount = (paramName = 'clientAccountId') => {
  return async (req, res, next) => {
    await ensureAccountContext(req, res, (error) => {
      if (error) return next(error);

      const requestedId = normalizeClientAccountId(
        req.params?.[paramName]
        || req.body?.clientAccountId
        || req.query?.clientAccountId
        || req.accountContext?.selectedClientAccountId
      );

      if (!requestedId || !canManageClientAccountFromContext(req.accountContext, requestedId)) {
        return res.status(403).json({ error: 'Client account management access denied' });
      }

      return next();
    });
  };
};

module.exports = {
  resolveAccountContext,
  requireClientContext,
  requireResellerContext,
  requireCanAccessClientAccount,
  requireCanManageClientAccount,
  canAccessClientAccountFromContext,
  canManageClientAccountFromContext,
};
