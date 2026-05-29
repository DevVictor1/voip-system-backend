const LEGACY_ADMIN_ROLE = 'admin';
const LEGACY_AGENT_ROLE = 'agent';
const PLATFORM_ADMIN_ROLE = 'platform_admin';
const RESELLER_ADMIN_ROLE = 'reseller_admin';
const CLIENT_ADMIN_ROLE = 'client_admin';
const CLIENT_USER_ROLE = 'client_user';

const USER_ROLES = [
  LEGACY_ADMIN_ROLE,
  LEGACY_AGENT_ROLE,
  PLATFORM_ADMIN_ROLE,
  RESELLER_ADMIN_ROLE,
  CLIENT_ADMIN_ROLE,
  CLIENT_USER_ROLE,
];

const PLATFORM_ADMIN_ROLES = new Set([LEGACY_ADMIN_ROLE, PLATFORM_ADMIN_ROLE]);
const RESELLER_ADMIN_ROLES = new Set([RESELLER_ADMIN_ROLE]);
const CLIENT_ADMIN_ROLES = new Set([CLIENT_ADMIN_ROLE]);
const CLIENT_USER_ROLES = new Set([CLIENT_USER_ROLE]);
const CLIENT_ACCESS_ROLES = new Set([CLIENT_ADMIN_ROLE, CLIENT_USER_ROLE]);

const normalizeRole = (role) => {
  const normalized = String(role || '').trim().toLowerCase();
  return USER_ROLES.includes(normalized) ? normalized : '';
};

const getUserRole = (user) => normalizeRole(user?.role);

const isPlatformAdmin = (user) => PLATFORM_ADMIN_ROLES.has(getUserRole(user));
const isResellerAdmin = (user) => RESELLER_ADMIN_ROLES.has(getUserRole(user));
const isClientAdmin = (user) => CLIENT_ADMIN_ROLES.has(getUserRole(user));
const isClientUser = (user) => CLIENT_USER_ROLES.has(getUserRole(user));
const hasClientPortalAccess = (user) => CLIENT_ACCESS_ROLES.has(getUserRole(user)) || isPlatformAdmin(user);

const expandCompatibleRoles = (roles = []) => {
  const expanded = new Set();

  roles.forEach((role) => {
    const normalizedRole = normalizeRole(role);
    if (!normalizedRole) return;

    expanded.add(normalizedRole);

    if (normalizedRole === LEGACY_ADMIN_ROLE || normalizedRole === PLATFORM_ADMIN_ROLE) {
      expanded.add(LEGACY_ADMIN_ROLE);
      expanded.add(PLATFORM_ADMIN_ROLE);
    }

    if (normalizedRole === LEGACY_AGENT_ROLE) {
      expanded.add(LEGACY_AGENT_ROLE);
      expanded.add(RESELLER_ADMIN_ROLE);
      expanded.add(CLIENT_ADMIN_ROLE);
      expanded.add(CLIENT_USER_ROLE);
    }
  });

  return expanded;
};

const hasAnyRole = (user, roles = []) => {
  const userRole = getUserRole(user);
  if (!userRole) return false;
  return expandCompatibleRoles(roles).has(userRole);
};

const canManageClientAccount = async (user, clientAccountId) => {
  if (!user || !clientAccountId) return false;
  if (isPlatformAdmin(user)) return true;

  const userId = user?._id;
  if (!userId) return false;

  const ClientAccount = require('../models/ClientAccount');

  if (isClientAdmin(user)) {
    return Boolean(await ClientAccount.exists({
      _id: clientAccountId,
      adminUserId: userId,
    }));
  }

  if (isResellerAdmin(user)) {
    const Reseller = require('../models/Reseller');
    const reseller = await Reseller.findOne({ assignedUserIds: userId }).select('_id');
    if (!reseller?._id) return false;

    return Boolean(await ClientAccount.exists({
      _id: clientAccountId,
      resellerId: reseller._id,
    }));
  }

  return false;
};

module.exports = {
  USER_ROLES,
  LEGACY_ADMIN_ROLE,
  LEGACY_AGENT_ROLE,
  PLATFORM_ADMIN_ROLE,
  RESELLER_ADMIN_ROLE,
  CLIENT_ADMIN_ROLE,
  CLIENT_USER_ROLE,
  normalizeRole,
  getUserRole,
  isPlatformAdmin,
  isResellerAdmin,
  isClientAdmin,
  isClientUser,
  hasClientPortalAccess,
  hasAnyRole,
  canManageClientAccount,
};
