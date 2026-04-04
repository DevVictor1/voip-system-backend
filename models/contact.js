const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
{
  firstName: String,
  lastName: String,

  // 🔥 MULTIPLE NUMBERS
  phones: [
    {
      label: String,
      number: String,
    }
  ],

  dba: String,
  mid: String,

  // 🔥 NEW (SAFE ADD)
  assignedTo: {
    type: String, // later will be userId
    default: null,
  },

  // 🔥 NEW (FOR SHARED INBOX)
  isUnassigned: {
    type: Boolean,
    default: true,
  }
},
{ timestamps: true }
);

module.exports = mongoose.model('Contact', contactSchema);