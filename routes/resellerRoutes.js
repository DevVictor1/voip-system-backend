const express = require('express');
const { getResellerOverview } = require('../controllers/adminPortalController');
const { authenticate, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, requireRole('admin'));

router.get('/overview', getResellerOverview);

module.exports = router;
