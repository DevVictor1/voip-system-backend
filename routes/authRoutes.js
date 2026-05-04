const express = require('express');
const {
  login,
  me,
  listTeammates,
  listAgentStatus,
  updateMyAvailabilityStatus,
  bootstrapUser,
  listUsers,
  createUser,
  getUser,
  updateUser,
  resetUserPassword,
  deleteUser,
} = require('../controllers/authController');
const { authenticate, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/login', login);
router.get('/me', authenticate, me);
router.patch('/me/availability-status', authenticate, updateMyAvailabilityStatus);
router.get('/teammates', authenticate, listTeammates);
router.get('/agent-status', authenticate, requireRole('admin'), listAgentStatus);
router.post('/bootstrap', bootstrapUser);
router.get('/users', authenticate, requireRole('admin'), listUsers);
router.post('/users', authenticate, requireRole('admin'), createUser);
router.get('/users/:id', authenticate, requireRole('admin'), getUser);
router.put('/users/:id', authenticate, requireRole('admin'), updateUser);
router.patch('/users/:id/password', authenticate, requireRole('admin'), resetUserPassword);
router.delete('/users/:id', authenticate, requireRole('admin'), deleteUser);

module.exports = router;
