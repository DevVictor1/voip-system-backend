const express = require('express');
const {
  assignResellerPortalClientAdmin,
  createResellerPortalClientAccount,
  getResellerPortalClientAccountDetails,
  getResellerPortalSummary,
  listResellerPortalAssignableUsers,
  listResellerPortalClientAccounts,
  updateResellerPortalAssignedUsers,
  updateResellerPortalClientAccount,
} = require('../controllers/resellerPortalController');
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
  requireResellerContext,
} = require('../middleware/accountContextMiddleware');

const router = express.Router();

router.use(authenticate, resolveAccountContext);

router.get('/summary', getResellerPortalSummary);
router.get('/client-accounts', requireResellerContext, listResellerPortalClientAccounts);
router.post('/client-accounts', requireResellerContext, createResellerPortalClientAccount);
router.get(
  '/client-accounts/:clientAccountId',
  requireCanAccessClientAccount('clientAccountId'),
  getResellerPortalClientAccountDetails
);
router.put(
  '/client-accounts/:clientAccountId',
  requireCanManageClientAccount('clientAccountId'),
  updateResellerPortalClientAccount
);
router.patch(
  '/client-accounts/:clientAccountId/admin-user',
  requireCanManageClientAccount('clientAccountId'),
  assignResellerPortalClientAdmin
);
router.get(
  '/client-accounts/:clientAccountId/assignable-users',
  requireCanManageClientAccount('clientAccountId'),
  listResellerPortalAssignableUsers
);
router.put(
  '/client-accounts/:clientAccountId/assigned-users',
  requireCanManageClientAccount('clientAccountId'),
  updateResellerPortalAssignedUsers
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
