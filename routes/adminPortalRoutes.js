const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  listResellers,
  getReseller,
  createReseller,
  updateReseller,
  archiveReseller,
  restoreReseller,
  addResellerNote,
  deleteResellerNote,
  listClientAccounts,
  getClientAccount,
  createClientAccount,
  updateClientAccount,
  updateClientAccountStatus,
  archiveClientAccount,
  restoreClientAccount,
  addClientAccountNote,
  deleteClientAccountNote,
} = require('../controllers/adminPortalController');
const {
  archiveClientNumberById,
  createClientNumber,
  deleteClientNumber,
  listAllClientNumbers,
  listClientNumbers,
  updateClientNumber,
  updateClientNumberById,
} = require('../controllers/clientNumberOwnershipController');
const {
  assignScopedUser,
  createScopedUser,
  listScopedUsers,
  removeScopedUser,
  updateScopedUser,
} = require('../controllers/scopedUserManagementController');
const {
  activatePortingNumbers,
  archivePortingRequest,
  checkPortingRequestPortability,
  checkStandalonePhoneNumberPortability,
  createPortingRequest,
  getPortingRequestReadiness,
  getPortingRequest,
  listPortingRequests,
  updatePortingRequest,
  updatePortingRequestStatus,
  uploadPortingDocument,
  uploadPortingDocumentToTwilio,
} = require('../controllers/portingRequestController');
const { authenticate, requirePlatformAdmin } = require('../middleware/authMiddleware');

const router = express.Router();
const PORTING_DOCUMENT_DIR = path.join(process.cwd(), 'uploads', 'porting-documents');
const ALLOWED_PORTING_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const portingDocumentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      fs.mkdirSync(PORTING_DOCUMENT_DIR, { recursive: true });
      callback(null, PORTING_DOCUMENT_DIR);
    },
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname || '').toLowerCase();
      const safeExtension = extension.replace(/[^.\w-]/g, '') || '';
      callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExtension}`);
    },
  }),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => {
    const mimeType = String(file.mimetype || '').trim().toLowerCase();
    if (!ALLOWED_PORTING_DOCUMENT_TYPES.has(mimeType)) {
      callback(new Error('Only PDF, Word, PNG, JPG, or WebP documents are supported'));
      return;
    }

    callback(null, true);
  },
});

const handlePortingDocumentUpload = (req, res, next) => {
  portingDocumentUpload.single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'Document must be 10 MB or smaller' });
      return;
    }

    res.status(400).json({ error: error.message || 'Document upload failed' });
  });
};

router.use(authenticate, requirePlatformAdmin);

router.get('/resellers', listResellers);
router.get('/resellers/:id', getReseller);
router.post('/resellers', createReseller);
router.put('/resellers/:id', updateReseller);
router.patch('/resellers/:id/archive', archiveReseller);
router.patch('/resellers/:id/restore', restoreReseller);
router.post('/resellers/:id/notes', addResellerNote);
router.delete('/resellers/:id/notes/:noteId', deleteResellerNote);

router.get('/client-accounts', listClientAccounts);
router.get('/client-accounts/:id', getClientAccount);
router.post('/client-accounts', createClientAccount);
router.put('/client-accounts/:id', updateClientAccount);
router.patch('/client-accounts/:id/status', updateClientAccountStatus);
router.patch('/client-accounts/:id/archive', archiveClientAccount);
router.patch('/client-accounts/:id/restore', restoreClientAccount);
router.post('/client-accounts/:id/notes', addClientAccountNote);
router.delete('/client-accounts/:id/notes/:noteId', deleteClientAccountNote);
router.get('/client-numbers', listAllClientNumbers);
router.get('/client-accounts/:clientAccountId/users', listScopedUsers);
router.post('/client-accounts/:clientAccountId/users', createScopedUser);
router.post('/client-accounts/:clientAccountId/users/:userId/assign', assignScopedUser);
router.put('/client-accounts/:clientAccountId/users/:userId', updateScopedUser);
router.delete('/client-accounts/:clientAccountId/users/:userId', removeScopedUser);
router.get('/client-accounts/:clientAccountId/numbers', listClientNumbers);
router.post('/client-accounts/:clientAccountId/numbers', createClientNumber);
router.put('/client-accounts/:clientAccountId/numbers/:numberId', updateClientNumber);
router.delete('/client-accounts/:clientAccountId/numbers/:numberId', deleteClientNumber);
router.put('/client-numbers/:numberId', updateClientNumberById);
router.patch('/client-numbers/:numberId/archive', archiveClientNumberById);

router.get('/porting-requests', listPortingRequests);
router.post('/porting-requests/portability-check', checkStandalonePhoneNumberPortability);
router.post('/porting-requests', createPortingRequest);
router.get('/porting-requests/:id/readiness', getPortingRequestReadiness);
router.get('/porting-requests/:id', getPortingRequest);
router.put('/porting-requests/:id', updatePortingRequest);
router.patch('/porting-requests/:id/status', updatePortingRequestStatus);
router.post('/porting-requests/:id/portability-check', checkPortingRequestPortability);
router.post('/porting-requests/:id/documents', handlePortingDocumentUpload, uploadPortingDocument);
router.post('/porting-requests/:id/documents/:documentId/twilio-upload', uploadPortingDocumentToTwilio);
router.patch('/porting-requests/:id/archive', archivePortingRequest);
router.post('/porting-requests/:id/activate', activatePortingNumbers);

module.exports = router;
