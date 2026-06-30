const express = require('express');
const router = express.Router();
const { authenticate, requirePlatformAdmin } = require('../middleware/authMiddleware');

const {
  getNumbers,
  createNumber,
  updateNumber,
  deleteNumber,
} = require('../controllers/numberController');

router.use(authenticate, requirePlatformAdmin);

router.get('/', getNumbers);
router.post('/', createNumber);
router.put('/:id', updateNumber);
router.delete('/:id', deleteNumber);

module.exports = router;
