const express = require('express');
const {
  listResellers,
  getReseller,
  createReseller,
  updateReseller,
  listClientAccounts,
  getClientAccount,
  createClientAccount,
  updateClientAccount,
} = require('../controllers/adminPortalController');
const { authenticate, requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, requireRole('admin'));

router.get('/resellers', listResellers);
router.get('/resellers/:id', getReseller);
router.post('/resellers', createReseller);
router.put('/resellers/:id', updateReseller);

router.get('/client-accounts', listClientAccounts);
router.get('/client-accounts/:id', getClientAccount);
router.post('/client-accounts', createClientAccount);
router.put('/client-accounts/:id', updateClientAccount);

module.exports = router;
