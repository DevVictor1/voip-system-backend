const jwt = require('jsonwebtoken');
const User = require('../models/User');

const DEFAULT_EXPIRES_IN = '7d';

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
  isActive: user.isActive,
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

const normalizeRole = (role) => {
  if (role === 'admin' || role === 'agent') {
    return role;
  }

  return '';
};

const buildUserPayload = ({
  name,
  email,
  role,
  agentId,
  isActive,
}) => {
  const normalizedRole = normalizeRole(role);
  const normalizedAgentId = agentId ? String(agentId).trim() : null;

  return {
    name: String(name || '').trim(),
    email: String(email || '').trim().toLowerCase(),
    role: normalizedRole,
    agentId: normalizedRole === 'agent' ? normalizedAgentId : normalizedAgentId,
    isActive: isActive === false ? false : true,
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
      .select('name role agentId isActive')
      .sort({ name: 1 });

    return res.json({
      teammates: teammates.map(sanitizeTeammate),
    });
  } catch (error) {
    console.error('Auth list teammates error:', error);
    return res.status(500).json({ error: 'Failed to fetch teammates' });
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
    const agentId = req.body?.agentId ? String(req.body.agentId).trim() : null;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const existingAgentUser = await findExistingAgentUser(agentId);
    if (existingAgentUser) {
      return res.status(409).json({ error: 'agentId is already in use' });
    }

    const user = await User.create({
      name,
      email,
      password,
      role,
      agentId,
      isActive: true,
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

    if (payload.role === 'agent' && !payload.agentId) {
      return res.status(400).json({ error: 'agentId is required for agent users' });
    }

    const existingUser = await User.findOne({ email: payload.email });
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const existingAgentUser = await findExistingAgentUser(payload.agentId);
    if (existingAgentUser) {
      return res.status(409).json({ error: 'agentId is already in use' });
    }

    const user = await User.create({
      ...payload,
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

    if (payload.role === 'agent' && !payload.agentId) {
      return res.status(400).json({ error: 'agentId is required for agent users' });
    }

    const existingUser = await User.findOne({
      email: payload.email,
      _id: { $ne: user._id },
    });

    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const existingAgentUser = await findExistingAgentUser(payload.agentId, user._id);
    if (existingAgentUser) {
      return res.status(409).json({ error: 'agentId is already in use' });
    }

    user.name = payload.name;
    user.email = payload.email;
    user.role = payload.role;
    user.agentId = payload.agentId;
    user.isActive = payload.isActive;

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
