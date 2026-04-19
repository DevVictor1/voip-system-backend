const express = require('express');
const router = express.Router();
const multer = require('multer');

const {
  importContacts,
  getContacts,
  deleteContact,
  clearContacts,
  assignContact,
  updateAssignmentStatus,
} = require('../controllers/contactController');

// 📁 FILE UPLOAD CONFIG
const upload = multer({ dest: 'uploads/' });

// 📥 IMPORT
router.post('/import', upload.single('file'), importContacts);

// 📚 GET (WITH ROLE FILTER)
router.get('/', getContacts);

// 👤 ASSIGN
router.put('/:id/assign', assignContact);

// 🔄 LIFECYCLE
router.put('/:id/assignment-status', updateAssignmentStatus);

// 🧹 CLEAR
router.delete('/clear', clearContacts);

// 🗑 DELETE 
router.delete('/:id', deleteContact);

module.exports = router;
