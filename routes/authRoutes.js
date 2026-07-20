const express = require('express');
const {
  login,
  me,
  updateMyProfile,
  listTeammates,
  listAgentStatus,
  updateMyAvailabilityStatus,
  updateMyAvatar,
  toggleMyFavoriteConversation,
  toggleMyTeamChatNotifications,
  updateMyClosedTeamChat,
  bootstrapUser,
  listUsers,
  createUser,
  getUser,
  updateUser,
  resetUserPassword,
  deleteUser,
} = require('../controllers/authController');
const { authenticate, requirePlatformAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/login', login);
router.get('/me', authenticate, me);
router.patch('/me/profile', authenticate, updateMyProfile);
router.patch('/me/availability-status', authenticate, updateMyAvailabilityStatus);
router.patch('/me/avatar', authenticate, updateMyAvatar);
router.patch('/me/favorites', authenticate, toggleMyFavoriteConversation);
router.patch('/me/team-chat-notifications', authenticate, toggleMyTeamChatNotifications);
router.patch('/me/team-chat-closed', authenticate, updateMyClosedTeamChat);
router.get('/teammates', authenticate, listTeammates);
router.get('/agent-status', authenticate, requirePlatformAdmin, listAgentStatus);
router.post('/bootstrap', bootstrapUser);
router.get('/users', authenticate, requirePlatformAdmin, listUsers);
router.post('/users', authenticate, requirePlatformAdmin, createUser);
router.get('/users/:id', authenticate, requirePlatformAdmin, getUser);
router.put('/users/:id', authenticate, requirePlatformAdmin, updateUser);
router.patch('/users/:id/password', authenticate, requirePlatformAdmin, resetUserPassword);
router.delete('/users/:id', authenticate, requirePlatformAdmin, deleteUser);

module.exports = router;
