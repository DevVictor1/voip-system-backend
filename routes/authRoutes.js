const express = require('express');
const { login, me, bootstrapUser, listUsers, createUser } = require('../controllers/authController');
const { authenticate, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/login', login);
router.get('/me', authenticate, me);
router.post('/bootstrap', bootstrapUser);
router.get('/users', authenticate, requireRole('admin'), listUsers);
router.post('/users', authenticate, requireRole('admin'), createUser);

module.exports = router;
