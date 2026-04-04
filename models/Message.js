const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    sid: String, // 🔥 Twilio Message SID

    from: String,
    to: String,
    body: String,
    direction: String,

    read: {
      type: Boolean,
      default: false,
    },

    // 📊 DELIVERY STATUS
    status: {
      type: String,
      default: 'queued', // queued | sent | delivered | undelivered | failed
    },

    // ❗ ERROR CODE (NEW)
    errorCode: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Message', messageSchema);