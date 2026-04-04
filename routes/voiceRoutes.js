const express = require('express');
const router = express.Router();
const { generateToken } = require('../controllers/voiceController');

// ✅ SINGLE SOURCE OF TRUTH
router.get('/token', generateToken);

module.exports = router;