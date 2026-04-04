const mongoose = require('mongoose');

const callSchema = new mongoose.Schema(
  {
    callSid: { type: String, required: true, unique: true },

    from: String,
    to: String,
    status: String,
    duration: String,
    direction: String,

    // 🎧 NEW FIELD
    recordingSid: String,
    recordingUrl: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Call', callSchema);