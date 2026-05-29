const express = require('express');
const {
  listResellers,
  getReseller,
  createReseller,
  updateReseller,
  addResellerNote,
  deleteResellerNote,
  listClientAccounts,
  getClientAccount,
  createClientAccount,
  updateClientAccount,
  updateClientAccountStatus,
  addClientAccountNote,
  deleteClientAccountNote,
} = require('../controllers/adminPortalController');
const {
  createClientNumber,
  deleteClientNumber,
  listAllClientNumbers,
  listClientNumbers,
  updateClientNumber,
} = require('../controllers/clientNumberOwnershipController');
const { authenticate, requirePlatformAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, requirePlatformAdmin);

router.get('/resellers', listResellers);
router.get('/resellers/:id', getReseller);
router.post('/resellers', createReseller);
router.put('/resellers/:id', updateReseller);
router.post('/resellers/:id/notes', addResellerNote);
router.delete('/resellers/:id/notes/:noteId', deleteResellerNote);

router.get('/client-accounts', listClientAccounts);
router.get('/client-accounts/:id', getClientAccount);
router.post('/client-accounts', createClientAccount);
router.put('/client-accounts/:id', updateClientAccount);
router.patch('/client-accounts/:id/status', updateClientAccountStatus);
router.post('/client-accounts/:id/notes', addClientAccountNote);
router.delete('/client-accounts/:id/notes/:noteId', deleteClientAccountNote);
router.get('/client-numbers', listAllClientNumbers);
router.get('/client-accounts/:clientAccountId/numbers', listClientNumbers);
router.post('/client-accounts/:clientAccountId/numbers', createClientNumber);
router.put('/client-accounts/:clientAccountId/numbers/:numberId', updateClientNumber);
router.delete('/client-accounts/:clientAccountId/numbers/:numberId', deleteClientNumber);

module.exports = router;
