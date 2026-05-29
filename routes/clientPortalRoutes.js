const express = require('express');
const {
  getClientPortalSummary,
  getClientPortalAccountDetails,
  listClientPortalAssignableUsers,
  updateClientPortalAssignedUsers,
  updateClientPortalProfile,
} = require('../controllers/clientPortalController');
const {
  createClientNumber,
  deleteClientNumber,
  listClientNumbers,
  updateClientNumber,
} = require('../controllers/clientNumberOwnershipController');
const {
  assignScopedUser,
  createScopedUser,
  listScopedUsers,
  removeScopedUser,
  updateScopedUser,
} = require('../controllers/scopedUserManagementController');
const { authenticate } = require('../middleware/authMiddleware');
const {
  resolveAccountContext,
  requireCanAccessClientAccount,
  requireCanManageClientAccount,
} = require('../middleware/accountContextMiddleware');

const router = express.Router();

router.use(authenticate, resolveAccountContext);

router.get('/summary', getClientPortalSummary);
router.get(
  '/client-accounts/:clientAccountId',
  requireCanAccessClientAccount('clientAccountId'),
  getClientPortalAccountDetails
);
router.put(
  '/client-accounts/:clientAccountId/profile',
  requireCanManageClientAccount('clientAccountId'),
  updateClientPortalProfile
);
router.get(
  '/client-accounts/:clientAccountId/assignable-users',
  requireCanManageClientAccount('clientAccountId'),
  listClientPortalAssignableUsers
);
router.put(
  '/client-accounts/:clientAccountId/assigned-users',
  requireCanManageClientAccount('clientAccountId'),
  updateClientPortalAssignedUsers
);
router.get(
  '/client-accounts/:clientAccountId/users',
  requireCanAccessClientAccount('clientAccountId'),
  listScopedUsers
);
router.post(
  '/client-accounts/:clientAccountId/users',
  requireCanManageClientAccount('clientAccountId'),
  createScopedUser
);
router.post(
  '/client-accounts/:clientAccountId/users/:userId/assign',
  requireCanManageClientAccount('clientAccountId'),
  assignScopedUser
);
router.put(
  '/client-accounts/:clientAccountId/users/:userId',
  requireCanManageClientAccount('clientAccountId'),
  updateScopedUser
);
router.delete(
  '/client-accounts/:clientAccountId/users/:userId',
  requireCanManageClientAccount('clientAccountId'),
  removeScopedUser
);
router.get(
  '/client-accounts/:clientAccountId/numbers',
  requireCanAccessClientAccount('clientAccountId'),
  listClientNumbers
);
router.post(
  '/client-accounts/:clientAccountId/numbers',
  requireCanManageClientAccount('clientAccountId'),
  createClientNumber
);
router.put(
  '/client-accounts/:clientAccountId/numbers/:numberId',
  requireCanManageClientAccount('clientAccountId'),
  updateClientNumber
);
router.delete(
  '/client-accounts/:clientAccountId/numbers/:numberId',
  requireCanManageClientAccount('clientAccountId'),
  deleteClientNumber
);

module.exports = router;
