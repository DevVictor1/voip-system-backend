const express = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/authMiddleware');
const { resolveAccountContext } = require('../middleware/accountContextMiddleware');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

const {
  receiveSMS,
  sendSMS,
  getConversations,
  getTextingGroups,
  getTextingGroupConversations,
  getTextingGroupMessages,
  getMessages,
  markAsRead,
  markTextingGroupRead,
  clearMessages,
  smsStatusCallback,
  uploadMedia,
} = require('../controllers/smsController');

// Twilio calls these directly, so they must remain public.
router.post('/webhook', receiveSMS);
router.post('/incoming-sms', receiveSMS);
router.post('/status', smsStatusCallback);

// App-facing SMS/MMS routes require authenticated server-side identity.
router.use(authenticate, resolveAccountContext);

router.post('/send', sendSMS);
router.post('/upload', upload.single('file'), uploadMedia);

router.get('/conversations', getConversations);
router.get('/texting-groups', getTextingGroups);
router.get('/texting-groups/:groupId/conversations', getTextingGroupConversations);

router.get('/messages/:phone', getMessages);
router.get('/texting-groups/:groupId/messages/:phone', getTextingGroupMessages);

router.put('/read/:phone', markAsRead);
router.put('/texting-groups/:groupId/read/:phone', markTextingGroupRead);

router.delete('/clear', clearMessages);

module.exports = router;
