const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { authenticate } = require('../middleware/authMiddleware');

const {
  getTeams,
  getConversationRecord,
  startDirectConversation,
  createTeamConversation,
  getTeamDetails,
  getTeamCalendarEvents,
  updateTeamCalendarTimezone,
  createTeamCalendarEvent,
  updateTeamCalendarEvent,
  deleteTeamCalendarEvent,
  toggleTeamCalendarEventPin,
  updateTeamDetails,
  leaveTeamConversation,
  deleteTeamConversation,
  getConversations,
   getThread,
   uploadInternalAttachment,
   uploadInternalAttachments,
   downloadInternalAttachment,
   sendMessage,
   markConversationRead,
   editMessage,
   softDeleteMessage,
   togglePinMessage,
   toggleMessageReaction,
    getConversationNotes,
    createConversationNote,
    updateConversationNote,
    deleteConversationNote,
    getMessageThreadComments,
    markMessageThreadCommentsRead,
    createMessageThreadComment,
    } = require('../controllers/messageController');

const router = express.Router();
const INTERNAL_ATTACHMENT_DIR = path.join(process.cwd(), 'uploads', 'internal-chat');
const ALLOWED_INTERNAL_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
]);
const ALLOWED_INTERNAL_ATTACHMENT_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.csv',
]);
const MAX_INTERNAL_ATTACHMENT_FILES = 10;

const cleanupUploadedFiles = (files = []) => {
  files.forEach((file) => {
    if (!file?.path) return;
    fs.promises.unlink(file.path).catch(() => {});
  });
};

const isAllowedInternalAttachment = (file) => {
  const mimetype = String(file?.mimetype || '').trim().toLowerCase();
  const extension = path.extname(file?.originalname || '').toLowerCase();
  return ALLOWED_INTERNAL_ATTACHMENT_TYPES.has(mimetype)
    && ALLOWED_INTERNAL_ATTACHMENT_EXTENSIONS.has(extension);
};

const internalAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      fs.mkdirSync(INTERNAL_ATTACHMENT_DIR, { recursive: true });
      callback(null, INTERNAL_ATTACHMENT_DIR);
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
    if (!isAllowedInternalAttachment(file)) {
      callback(new Error('Unsupported file type'));
      return;
    }

    callback(null, true);
  },
});

const handleInternalAttachmentUpload = (req, res, next) => {
  internalAttachmentUpload.single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'File must be 10 MB or smaller' });
      return;
    }

    res.status(400).json({ error: error.message || 'Upload failed' });
  });
};

const handleInternalAttachmentsUpload = (req, res, next) => {
  internalAttachmentUpload.array('files', MAX_INTERNAL_ATTACHMENT_FILES)(req, res, (error) => {
    if (!error) {
      if (!Array.isArray(req.files) || req.files.length === 0) {
        res.status(400).json({ error: 'No files uploaded' });
        return;
      }

      next();
      return;
    }

    cleanupUploadedFiles(req.files);

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'Each file must be 10 MB or smaller' });
        return;
      }

      if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).json({ error: `You can upload up to ${MAX_INTERNAL_ATTACHMENT_FILES} files at once` });
        return;
      }
    }

    res.status(400).json({ error: error.message || 'Upload failed' });
  });
};

router.get('/teams', authenticate, getTeams);
router.get('/conversation/:conversationId', authenticate, getConversationRecord);
router.post('/direct/start', startDirectConversation);
router.post('/team', createTeamConversation);
router.get('/team/:conversationId/details', authenticate, getTeamDetails);
router.get('/team/:conversationId/calendar', getTeamCalendarEvents);
router.patch('/team/:conversationId/calendar/timezone', updateTeamCalendarTimezone);
router.post('/team/:conversationId/calendar', createTeamCalendarEvent);
router.put('/team/:conversationId/calendar/:eventId', updateTeamCalendarEvent);
router.patch('/team/:conversationId/calendar/:eventId/pin', toggleTeamCalendarEventPin);
router.delete('/team/:conversationId/calendar/:eventId', deleteTeamCalendarEvent);
router.put('/team/:conversationId/details', updateTeamDetails);
router.post('/team/:conversationId/leave', leaveTeamConversation);
router.delete('/team/:conversationId', deleteTeamConversation);
router.get('/conversations', authenticate, getConversations);
router.get('/thread/:conversationId', authenticate, getThread);
router.post('/upload', authenticate, handleInternalAttachmentUpload, uploadInternalAttachment);
router.post('/uploads', authenticate, handleInternalAttachmentsUpload, uploadInternalAttachments);
router.get('/message/:messageId/attachment', authenticate, downloadInternalAttachment);
router.get('/message/:messageId/attachment/:attachmentIndex', authenticate, downloadInternalAttachment);
router.post('/send', sendMessage);
router.put('/read/:conversationId', markConversationRead);
router.put('/message/:messageId', editMessage);
router.delete('/message/:messageId', softDeleteMessage);
router.put('/message/:messageId/pin', togglePinMessage);
router.put('/message/:messageId/reaction', toggleMessageReaction);
router.get('/conversation/:conversationId/notes', getConversationNotes);
router.post('/conversation/:conversationId/notes', createConversationNote);
router.put('/conversation/:conversationId/notes/:noteId', updateConversationNote);
router.delete('/conversation/:conversationId/notes/:noteId', deleteConversationNote);
router.get('/message/:messageId/comments', getMessageThreadComments);
router.put('/message/:messageId/comments/read', markMessageThreadCommentsRead);
router.post('/message/:messageId/comments', createMessageThreadComment);

module.exports = router;
