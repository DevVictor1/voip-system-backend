const User = require('../models/User');
const ClientAccount = require('../models/ClientAccount');
const {
  CLIENT_ADMIN_ROLE,
  CLIENT_USER_ROLE,
  LEGACY_AGENT_ROLE,
  isClientAdmin,
  isPlatformAdmin,
  isResellerAdmin,
  normalizeRole,
} = require('../utils/accessControl');
const { getClientAccountIdString } = require('../utils/clientOwnership');

const SCOPED_ADMIN_ASSIGNABLE_ROLES = new Set([
  LEGACY_AGENT_ROLE,
  CLIENT_ADMIN_ROLE,
  CLIENT_USER_ROLE,
]);

const normalizeTrimmedText = (value) => String(value || '').trim();
const normalizeEmail = (value) => normalizeTrimmedText(value).toLowerCase();

const sanitizeScopedUser = (user) => user.toSafeObject();

const isDuplicateKeyError = (error) => error?.code === 11000;

const buildDuplicateErrorMessage = (error) => {
  if (error?.keyPattern?.agentId) return 'agentId is already in use';
  if (error?.keyPattern?.email) return 'User already exists';
  return 'Duplicate value';
};

const normalizeDepartment = (department) => {
  const normalized = normalizeTrimmedText(department).toLowerCase();
  return ['tech', 'support', 'sales'].includes(normalized) ? normalized : null;
};

const normalizeAvailabilityStatus = (status) => {
  const normalized = normalizeTrimmedText(status).toLowerCase();
  return ['online', 'busy', 'meeting', 'break', 'offline'].includes(normalized) ? normalized : 'online';
};

const normalizeAssignmentStatus = (status) => {
  const normalized = normalizeTrimmedText(status).toLowerCase();
  return ['available', 'busy', 'offline'].includes(normalized) ? normalized : 'offline';
};

const normalizeNonNegativeInteger = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
};

const normalizeAgentIdSegment = (value) => normalizeTrimmedText(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_+|_+$/g, '');

const buildAgentIdBase = ({ name, role, department }) => {
  const normalizedName = normalizeAgentIdSegment(name) || 'user';
  const normalizedRole = normalizeRole(role);
  const prefix = normalizedRole === CLIENT_ADMIN_ROLE
    ? 'client_admin'
    : normalizedRole === CLIENT_USER_ROLE
      ? 'client'
      : (normalizeAgentIdSegment(department) || 'agent');

  return `${prefix}_${normalizedName}`;
};

const findExistingAgentUser = (agentId, excludeUserId = null) => {
  if (!agentId) return null;
  return User.findOne({
    agentId,
    ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
  });
};

const resolveAgentId = async ({ agentId, name, role, department, excludeUserId = null }) => {
  const explicitAgentId = normalizeTrimmedText(agentId);
  if (explicitAgentId) return explicitAgentId;

  const base = buildAgentIdBase({ name, role, department });
  let candidate = base;
  let suffix = 2;

  while (await findExistingAgentUser(candidate, excludeUserId)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }

  return candidate;
};

const canUseRole = (req, role) => {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return false;
  if (isPlatformAdmin(req.user)) return true;
  if (isResellerAdmin(req.user) || isClientAdmin(req.user)) {
    return SCOPED_ADMIN_ASSIGNABLE_ROLES.has(normalizedRole);
  }
  return false;
};

const resolveTargetClientAccount = async (req) => {
  const clientAccountId = req.params.clientAccountId || req.body?.clientAccountId;
  const clientAccount = await ClientAccount.findById(clientAccountId);
  if (!clientAccount) return null;
  return clientAccount;
};

const ensureUserCanBelongToClient = async (req, user, clientAccountId) => {
  if (isPlatformAdmin(req.user)) return null;

  if (!SCOPED_ADMIN_ASSIGNABLE_ROLES.has(normalizeRole(user.role))) {
    return 'User role cannot be managed from this portal';
  }

  const userClientId = getClientAccountIdString(user.clientAccountId);
  const targetClientId = getClientAccountIdString(clientAccountId);

  if (userClientId && userClientId !== targetClientId) {
    return 'User belongs to another client organization';
  }

  const assignedElsewhere = await ClientAccount.exists({
    _id: { $ne: clientAccountId },
    assignedUserIds: user._id,
  });

  if (assignedElsewhere) {
    return 'User belongs to another client organization';
  }

  return null;
};

const addUserToClientAccount = async (clientAccount, userId) => {
  const userIdText = String(userId);
  const currentIds = Array.isArray(clientAccount.assignedUserIds)
    ? clientAccount.assignedUserIds.map((value) => String(value))
    : [];

  if (!currentIds.includes(userIdText)) {
    clientAccount.assignedUserIds = [...currentIds, userId];
    await clientAccount.save();
  }
};

const removeUserFromClientAccount = async (clientAccount, userId) => {
  const userIdText = String(userId);
  const currentIds = Array.isArray(clientAccount.assignedUserIds)
    ? clientAccount.assignedUserIds.map((value) => String(value))
    : [];

  clientAccount.assignedUserIds = currentIds.filter((value) => value !== userIdText);
  if (String(clientAccount.adminUserId || '') === userIdText) {
    clientAccount.adminUserId = null;
  }
  await clientAccount.save();
};

exports.listScopedUsers = async (req, res) => {
  try {
    const clientAccount = await resolveTargetClientAccount(req);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const users = await User.find({
      $or: [
        { clientAccountId: clientAccount._id },
        { _id: { $in: clientAccount.assignedUserIds || [] } },
        ...(clientAccount.adminUserId ? [{ _id: clientAccount.adminUserId }] : []),
      ],
    }).sort({ name: 1, email: 1 });

    return res.json({
      users: users.map(sanitizeScopedUser),
    });
  } catch (error) {
    console.error('Scoped user list error:', error);
    return res.status(500).json({ error: 'Failed to load organization users' });
  }
};

exports.createScopedUser = async (req, res) => {
  try {
    const clientAccount = await resolveTargetClientAccount(req);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const name = normalizeTrimmedText(req.body?.name);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const role = normalizeRole(req.body?.role) || CLIENT_USER_ROLE;
    const department = normalizeDepartment(req.body?.department);

    if (!canUseRole(req, role)) {
      return res.status(403).json({ error: 'Selected role is not allowed for this portal' });
    }

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (
      req.body?.makeClientAdmin === true
      && !(isPlatformAdmin(req.user) || isResellerAdmin(req.user))
    ) {
      return res.status(403).json({ error: 'Client admin assignment is not allowed for this portal role' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const agentId = await resolveAgentId({
      agentId: req.body?.agentId,
      name,
      role,
      department,
    });

    if (await findExistingAgentUser(agentId)) {
      return res.status(409).json({ error: 'agentId is already in use' });
    }

    const user = await User.create({
      name,
      email,
      password,
      role,
      agentId,
      department,
      clientAccountId: clientAccount._id,
      isActive: req.body?.isActive === false ? false : true,
      status: normalizeAssignmentStatus(req.body?.status),
      availabilityStatus: normalizeAvailabilityStatus(req.body?.availabilityStatus),
      maxActiveChats: normalizeNonNegativeInteger(req.body?.maxActiveChats, 5),
      currentActiveChats: normalizeNonNegativeInteger(req.body?.currentActiveChats, 0),
      maxConcurrentCalls: normalizeNonNegativeInteger(req.body?.maxConcurrentCalls, 1),
      isAssignable: req.body?.isAssignable === false ? false : true,
    });

    await addUserToClientAccount(clientAccount, user._id);
    if (role === CLIENT_ADMIN_ROLE && req.body?.makeClientAdmin === true) {
      clientAccount.adminUserId = user._id;
      await clientAccount.save();
    }

    return res.status(201).json({ user: sanitizeScopedUser(user) });
  } catch (error) {
    console.error('Scoped user create error:', error);
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ error: buildDuplicateErrorMessage(error) });
    }
    return res.status(500).json({ error: 'Failed to create organization user' });
  }
};

exports.assignScopedUser = async (req, res) => {
  try {
    const clientAccount = await resolveTargetClientAccount(req);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const assignmentError = await ensureUserCanBelongToClient(req, user, clientAccount._id);
    if (assignmentError) {
      return res.status(403).json({ error: assignmentError });
    }

    user.clientAccountId = clientAccount._id;
    await user.save();
    await addUserToClientAccount(clientAccount, user._id);

    return res.json({ user: sanitizeScopedUser(user) });
  } catch (error) {
    console.error('Scoped user assign error:', error);
    return res.status(500).json({ error: 'Failed to assign organization user' });
  }
};

exports.removeScopedUser = async (req, res) => {
  try {
    const clientAccount = await resolveTargetClientAccount(req);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const clientAssignedUserIds = Array.isArray(clientAccount.assignedUserIds)
      ? clientAccount.assignedUserIds.map((value) => String(value))
      : [];
    const userBelongsByClientField = getClientAccountIdString(user.clientAccountId) === getClientAccountIdString(clientAccount._id);
    const userBelongsByAssignment = clientAssignedUserIds.includes(String(user._id));

    if (!userBelongsByClientField && !userBelongsByAssignment) {
      return res.status(403).json({ error: 'User is not assigned to this client organization' });
    }

    if (!isPlatformAdmin(req.user) && !SCOPED_ADMIN_ASSIGNABLE_ROLES.has(normalizeRole(user.role))) {
      return res.status(403).json({ error: 'User role cannot be managed from this portal' });
    }

    if (userBelongsByClientField) {
      user.clientAccountId = null;
      await user.save();
    }
    await removeUserFromClientAccount(clientAccount, user._id);

    return res.json({ user: sanitizeScopedUser(user) });
  } catch (error) {
    console.error('Scoped user remove error:', error);
    return res.status(500).json({ error: 'Failed to remove organization user' });
  }
};

exports.updateScopedUser = async (req, res) => {
  try {
    const clientAccount = await resolveTargetClientAccount(req);
    if (!clientAccount) {
      return res.status(404).json({ error: 'Client organization not found' });
    }

    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (getClientAccountIdString(user.clientAccountId) !== getClientAccountIdString(clientAccount._id)) {
      return res.status(403).json({ error: 'User is not assigned to this client organization' });
    }

    if (!isPlatformAdmin(req.user) && !SCOPED_ADMIN_ASSIGNABLE_ROLES.has(normalizeRole(user.role))) {
      return res.status(403).json({ error: 'User role cannot be managed from this portal' });
    }

    const nextRole = req.body?.role !== undefined ? normalizeRole(req.body.role) : user.role;
    if (!canUseRole(req, nextRole)) {
      return res.status(403).json({ error: 'Selected role is not allowed for this portal' });
    }

    const nextName = normalizeTrimmedText(req.body?.name ?? user.name);
    const nextEmail = normalizeEmail(req.body?.email ?? user.email);
    if (!nextName || !nextEmail || !nextRole) {
      return res.status(400).json({ error: 'Name, email, and role are required' });
    }

    const existingUser = await User.findOne({
      email: nextEmail,
      _id: { $ne: user._id },
    });
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    user.name = nextName;
    user.email = nextEmail;
    user.role = nextRole;
    user.department = normalizeDepartment(req.body?.department ?? user.department);
    user.isActive = req.body?.isActive === undefined ? user.isActive : req.body.isActive !== false;
    user.status = normalizeAssignmentStatus(req.body?.status ?? user.status);
    user.availabilityStatus = normalizeAvailabilityStatus(req.body?.availabilityStatus ?? user.availabilityStatus);
    user.maxActiveChats = normalizeNonNegativeInteger(req.body?.maxActiveChats, user.maxActiveChats || 5);
    user.currentActiveChats = normalizeNonNegativeInteger(req.body?.currentActiveChats, user.currentActiveChats || 0);
    user.maxConcurrentCalls = normalizeNonNegativeInteger(req.body?.maxConcurrentCalls, user.maxConcurrentCalls || 1);
    user.isAssignable = req.body?.isAssignable === undefined ? user.isAssignable : req.body.isAssignable !== false;

    await user.save();
    await addUserToClientAccount(clientAccount, user._id);

    if (String(clientAccount.adminUserId || '') === String(user._id) && user.role !== CLIENT_ADMIN_ROLE) {
      clientAccount.adminUserId = null;
      await clientAccount.save();
    }

    return res.json({ user: sanitizeScopedUser(user) });
  } catch (error) {
    console.error('Scoped user update error:', error);
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ error: buildDuplicateErrorMessage(error) });
    }
    return res.status(500).json({ error: 'Failed to update organization user' });
  }
};
