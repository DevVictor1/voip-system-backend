const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Call = require('../models/Call');

const DEFAULT_EXPIRES_IN = '7d';
const FINAL_CALL_STATUSES = ['completed', 'canceled', 'failed', 'busy', 'no-answer'];

const getJwtSecret = () => {
  return process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || '';
};

const signToken = (user) => {
  return jwt.sign(
    {
      sub: String(user._id),
      role: user.role,
      agentId: user.agentId || null,
      email: user.email,
    },
    getJwtSecret(),
    {
      expiresIn: process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRES_IN,
    }
  );
};

const sanitizeUser = (user) => user.toSafeObject();
const sanitizeTeammate = (user) => ({
  id: user._id,
  name: user.name,
  role: user.role,
  agentId: user.agentId,
  department: user.department,
  isActive: user.isActive,
  status: user.status || 'offline',
  maxActiveChats: Number.isFinite(user.maxActiveChats) ? user.maxActiveChats : 5,
  currentActiveChats: Number.isFinite(user.currentActiveChats) ? user.currentActiveChats : 0,
  maxConcurrentCalls: Number.isFinite(user.maxConcurrentCalls) ? user.maxConcurrentCalls : 1,
  isAssignable: typeof user.isAssignable === 'boolean' ? user.isAssignable : true,
});

const isDuplicateKeyError = (error) => error?.code === 11000;

const buildDuplicateErrorMessage = (error) => {
  const duplicateFields = error?.keyPattern || {};

  if (duplicateFields.agentId) {
    return 'agentId is already in use';
  }

  if (duplicateFields.email) {
    return 'User already exists';
  }

  return 'Duplicate value';
};

const findExistingAgentUser = (agentId, excludeUserId) => {
  if (!agentId) {
    return null;
  }

  const query = { agentId };

  if (excludeUserId) {
    query._id = { $ne: excludeUserId };
  }

  return User.findOne(query);
};

const dedupeAgentIds = (agentIds = []) => [...new Set(agentIds.filter(Boolean))];

const resolveActiveCallCounts = async (agentIds = []) => {
  const uniqueAgentIds = dedupeAgentIds(agentIds);

  if (uniqueAgentIds.length === 0) {
    return {};
  }

  const counts = await Call.aggregate([
    {
      $match: {
        assignedAgentId: { $in: uniqueAgentIds },
        status: { $nin: FINAL_CALL_STATUSES },
      },
    },
    {
      $group: {
        _id: '$assignedAgentId',
        count: { $sum: 1 },
      },
    },
  ]);

  return counts.reduce((acc, item) => {
    if (item?._id) {
      acc[item._id] = item.count || 0;
    }

    return acc;
  }, {});
};

const normalizeRole = (role) => {
  if (role === 'admin' || role === 'agent') {
    return role;
  }

  return '';
};

const normalizeDepartment = (department) => {
  const normalized = String(department || '').trim().toLowerCase();
  if (['tech', 'support', 'sales'].includes(normalized)) {
    return normalized;
  }

  return null;
};

const normalizeStatus = (status) => {
  const normalized = String(status || '').trim().toLowerCase();
  if (['available', 'busy', 'offline'].includes(normalized)) {
    return normalized;
  }

  return 'offline';
};

const normalizeNonNegativeInteger = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.floor(parsed));
};

const normalizeAgentIdSegment = (value) => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
};

const buildAutoAgentIdBase = ({ name, role, department }) => {
  const normalizedName = normalizeAgentIdSegment(name) || 'user';
  const prefix = role === 'admin'
    ? 'admin'
    : (normalizeAgentIdSegment(department) || 'agent');

  return `${prefix}_${normalizedName}`;
};

const resolveCreateAgentId = async ({ agentId, name, role, department }) => {
  const explicitAgentId = agentId ? String(agentId).trim() : '';

  if (explicitAgentId) {
    return explicitAgentId;
  }

  const baseAgentId = buildAutoAgentIdBase({ name, role, department });
  let candidate = baseAgentId;
  let suffix = 2;

  while (await findExistingAgentUser(candidate)) {
    candidate = `${baseAgentId}_${suffix}`;
    suffix += 1;
  }

  return candidate;
};

const hasInvalidDepartmentInput = (department) => {
  if (department === undefined || department === null) return false;
  return String(department).trim() !== '' && !normalizeDepartment(department);
};

const buildUserPayload = ({
  name,
  email,
  role,
  agentId,
  department,
  isActive,
  status,
  maxActiveChats,
  currentActiveChats,
  maxConcurrentCalls,
  isAssignable,
}) => {
  const normalizedRole = normalizeRole(role);
  const normalizedAgentId = agentId ? String(agentId).trim() : null;
  const normalizedDepartment = normalizeDepartment(department);

  return {
    name: String(name || '').trim(),
    email: String(email || '').trim().toLowerCase(),
    role: normalizedRole,
    agentId: normalizedRole === 'agent' ? normalizedAgentId : normalizedAgentId,
    department: normalizedDepartment,
    isActive: isActive === false ? false : true,
    status: normalizeStatus(status),
    maxActiveChats: normalizeNonNegativeInteger(maxActiveChats, 5),
    currentActiveChats: normalizeNonNegativeInteger(currentActiveChats, 0),
    maxConcurrentCalls: normalizeNonNegativeInteger(maxConcurrentCalls, 1),
    isAssignable: isAssignable === false ? false : true,
  };
};

exports.login = async (req, res) => {
  try {
    if (!getJwtSecret()) {
      return res.status(500).json({ error: 'JWT secret is not configured' });
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email }).select('+password');

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user);

    return res.json({
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Auth login error:', error);
    return res.status(500).json({ error: 'Failed to login' });
  }
};

exports.me = async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.json({
    user: sanitizeUser(req.user),
  });
};

exports.listTeammates = async (req, res) => {
  try {
    const currentUserId = String(req.user?._id || '');
    const teammates = await User.find({
      isActive: true,
      agentId: { $type: 'string', $ne: '' },
      _id: { $ne: currentUserId },
    })
      .select('name role agentId department isActive status maxActiveChats currentActiveChats maxConcurrentCalls isAssignable')
      .sort({ name: 1 });

    return res.json({
      teammates: teammates.map(sanitizeTeammate),
    });
  } catch (error) {
    console.error('Auth list teammates error:', error);
    return res.status(500).json({ error: 'Failed to fetch teammates' });
  }
};

exports.listAgentStatus = async (_req, res) => {
  try {
    const users = await User.find({
      agentId: { $type: 'string', $ne: '' },
    })
      .select('name role agentId department isActive status maxConcurrentCalls isAssignable')
      .sort({ name: 1, createdAt: 1 });

    const activeCallCounts = await resolveActiveCallCounts(
      users.map((user) => user.agentId)
    );

    const agentStatus = users.map((user) => {
      const agentId = user.agentId || '';
      const connected = Boolean(global.connectedUsers?.[agentId]);
      const voiceReady = Boolean(global.agentVoiceReady?.[agentId]);
      const presenceStatus = global.agentStatus?.[agentId] || 'offline';

      return {
        id: String(user._id),
        name: user.name,
        role: user.role,
        department: user.department,
        agentId,
        isActive: user.isActive !== false,
        isAssignable: typeof user.isAssignable === 'boolean' ? user.isAssignable : true,
        status: user.status || 'offline',
        connected,
        presenceStatus,
        voiceReady,
        activeCallCount: activeCallCounts[agentId] || 0,
        maxConcurrentCalls: Number.isFinite(user.maxConcurrentCalls) ? user.maxConcurrentCalls : 1,
      };
    });

    return res.json({ agentStatus });
  } catch (error) {
    console.error('Auth list agent status error:', error);
    return res.status(500).json({ error: 'Failed to fetch agent status' });
  }
};

exports.bootstrapUser = async (req, res) => {
  try {
    const bootstrapToken = process.env.AUTH_BOOTSTRAP_TOKEN;

    if (!bootstrapToken) {
      return res.status(404).json({ error: 'Not found' });
    }

    const providedToken = req.headers['x-bootstrap-token'] || req.body?.bootstrapToken;

    if (!providedToken || providedToken !== bootstrapToken) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    const role = req.body?.role === 'admin' ? 'admin' : 'agent';
    const requestedAgentId = req.body?.agentId ? String(req.body.agentId).trim() : null;
    const department = normalizeDepartment(req.body?.department);

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (hasInvalidDepartmentInput(req.body?.department)) {
      return res.status(400).json({ error: 'Invalid department' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const existingAgentUser = await findExistingAgentUser(requestedAgentId);
    if (existingAgentUser) {
      return res.status(409).json({ error: 'agentId is already in use' });
    }

    const agentId = await resolveCreateAgentId({
      agentId: requestedAgentId,
      name,
      role,
      department,
    });

    const user = await User.create({
      name,
      email,
      password,
      role,
      agentId,
      department,
      isActive: true,
      status: normalizeStatus(req.body?.status),
      maxActiveChats: normalizeNonNegativeInteger(req.body?.maxActiveChats, 5),
      currentActiveChats: normalizeNonNegativeInteger(req.body?.currentActiveChats, 0),
      maxConcurrentCalls: normalizeNonNegativeInteger(req.body?.maxConcurrentCalls, 1),
      isAssignable: req.body?.isAssignable === false ? false : true,
    });

    return res.status(201).json({
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Auth bootstrap error:', error);
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ error: buildDuplicateErrorMessage(error) });
    }
    return res.status(500).json({ error: 'Failed to create user' });
  }
};

exports.listUsers = async (_req, res) => {
  try {
    const users = await User.find({})
      .sort({ createdAt: -1 });

    return res.json({
      users: users.map(sanitizeUser),
    });
  } catch (error) {
    console.error('Auth list users error:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
};

exports.createUser = async (req, res) => {
  try {
    const payload = buildUserPayload(req.body || {});
    const password = String(req.body?.password || '');

    if (!payload.name || !payload.email || !password || !payload.role) {
      return res.status(400).json({ error: 'Name, email, password, and role are required' });
    }

    if (hasInvalidDepartmentInput(req.body?.department)) {
      return res.status(400).json({ error: 'Invalid department' });
    }

    const existingUser = await User.findOne({ email: payload.email });
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const existingAgentUser = await findExistingAgentUser(payload.agentId);
    if (existingAgentUser) {
      return res.status(409).json({ error: 'agentId is already in use' });
    }

    const agentId = await resolveCreateAgentId(payload);

    const user = await User.create({
      ...payload,
      agentId,
      password,
    });

    return res.status(201).json({
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Auth create user error:', error);
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ error: buildDuplicateErrorMessage(error) });
    }
    return res.status(500).json({ error: 'Failed to create user' });
  }
};

exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Auth get user error:', error);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const payload = buildUserPayload({
      ...user.toObject(),
      ...req.body,
    });

    if (!payload.name || !payload.email || !payload.role) {
      return res.status(400).json({ error: 'Name, email, and role are required' });
    }

    if (hasInvalidDepartmentInput(req.body?.department)) {
      return res.status(400).json({ error: 'Invalid department' });
    }

    const currentAgentId = user.agentId ? String(user.agentId).trim() : null;
    const requestedAgentId = payload.agentId ? String(payload.agentId).trim() : null;
    const isChangingExistingAgentId = Boolean(
      currentAgentId
      && requestedAgentId
      && requestedAgentId !== currentAgentId
    );

    if (isChangingExistingAgentId) {
      return res.status(400).json({
        error: 'agentId is locked after creation because it is used for calls, messaging, and presence',
      });
    }

    const finalAgentId = currentAgentId || requestedAgentId;

    if (payload.role === 'agent' && !finalAgentId) {
      return res.status(400).json({ error: 'agentId is required for agent users' });
    }

    const existingUser = await User.findOne({
      email: payload.email,
      _id: { $ne: user._id },
    });

    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const existingAgentUser = await findExistingAgentUser(finalAgentId, user._id);
    if (existingAgentUser) {
      return res.status(409).json({ error: 'agentId is already in use' });
    }

    user.name = payload.name;
    user.email = payload.email;
    user.role = payload.role;
    user.agentId = finalAgentId;
    user.department = payload.department;
    user.isActive = payload.isActive;
    user.status = payload.status;
    user.maxActiveChats = payload.maxActiveChats;
    user.currentActiveChats = payload.currentActiveChats;
    user.maxConcurrentCalls = payload.maxConcurrentCalls;
    user.isAssignable = payload.isAssignable;

    await user.save();

    return res.json({
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Auth update user error:', error);
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ error: buildDuplicateErrorMessage(error) });
    }
    return res.status(500).json({ error: 'Failed to update user' });
  }
};

exports.resetUserPassword = async (req, res) => {
  try {
    const password = String(req.body?.password || '');

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const user = await User.findById(req.params.id).select('+password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.password = password;
    await user.save();

    return res.json({
      user: sanitizeUser(user),
      message: 'Password reset successfully',
    });
  } catch (error) {
    console.error('Auth reset password error:', error);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    if (String(req.user?._id) === String(req.params.id)) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const user = await User.findByIdAndDelete(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      success: true,
    });
  } catch (error) {
    console.error('Auth delete user error:', error);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
};

exports.signToken = signToken;
