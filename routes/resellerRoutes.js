const express = require('express');
const { getResellerOverview } = require('../controllers/adminPortalController');
const { authenticate, requirePlatformAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, requirePlatformAdmin);

router.get('/overview', getResellerOverview);

module.exports = router;
