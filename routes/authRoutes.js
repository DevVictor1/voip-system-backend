const express = require('express');
const { login, me, bootstrapUser } = require('../controllers/authController');
const { authenticate } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/login', login);
router.get('/me', authenticate, me);
router.post('/bootstrap', bootstrapUser);

module.exports = router;
