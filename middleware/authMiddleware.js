const jwt = require('jsonwebtoken');
const User = require('../models/User');
const {
  canManageClientAccount,
  hasAnyRole,
  isClientAdmin,
  isPlatformAdmin,
  isResellerAdmin,
} = require('../utils/accessControl');

const getJwtSecret = () => {
  return process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || '';
};

const extractBearerToken = (req) => {
  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  return authHeader.slice(7).trim();
};

const authenticate = async (req, res, next) => {
  try {
    if (!getJwtSecret()) {
      return res.status(500).json({ error: 'JWT secret is not configured' });
    }

    const token = extractBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const payload = jwt.verify(token, getJwtSecret());
    const user = await User.findById(payload.sub);

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.auth = payload;
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!hasAnyRole(req.user, roles)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
  };
};

const requirePlatformAdmin = requireRole('platform_admin');
const requireResellerAdmin = requireRole('reseller_admin');
const requireClientAdmin = requireRole('client_admin');

const requireCanManageClientAccount = (paramName = 'id') => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const clientAccountId = req.params?.[paramName] || req.body?.clientAccountId;
      if (!clientAccountId) {
        return res.status(400).json({ error: 'clientAccountId is required' });
      }

      const allowed = await canManageClientAccount(req.user, clientAccountId);
      if (!allowed) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      return next();
    } catch (error) {
      return res.status(500).json({ error: 'Failed to verify client account access' });
    }
  };
};

module.exports = {
  authenticate,
  requireRole,
  requirePlatformAdmin,
  requireResellerAdmin,
  requireClientAdmin,
  requireCanManageClientAccount,
  extractBearerToken,
  isPlatformAdmin,
  isResellerAdmin,
  isClientAdmin,
  canManageClientAccount,
};
