const express = require('express');
const router = express.Router();

const {
  getNumbers,
  createNumber,
  updateNumber,
  deleteNumber,
} = require('../controllers/numberController');

router.get('/', getNumbers);
router.post('/', createNumber);
router.put('/:id', updateNumber);
router.delete('/:id', deleteNumber);

module.exports = router;
