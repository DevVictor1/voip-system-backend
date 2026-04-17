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
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = req.body?.role === 'admin' ? 'admin' : req.body?.role === 'agent' ? 'agent' : '';
    const agentId = req.body?.agentId ? String(req.body.agentId).trim() : null;
    const isActive = req.body?.isActive === false ? false : true;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Name, email, password, and role are required' });
    }

    if (role === 'agent' && !agentId) {
      return res.status(400).json({ error: 'agentId is required for agent users' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const user = await User.create({
      name,
      email,
      password,
      role,
      agentId: role === 'admin' ? agentId : agentId,
      isActive,
    });

    return res.status(201).json({
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Auth create user error:', error);
    return res.status(500).json({ error: 'Failed to create user' });
  }
};

exports.signToken = signToken;
