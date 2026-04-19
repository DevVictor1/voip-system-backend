const mongoose = require('mongoose');

const callSchema = new mongoose.Schema(
  {
    callSid: { type: String, required: true, unique: true },

    from: String,
    to: String,
    status: String,
    duration: String,
    direction: String,
    assignedAgentId: {
      type: String,
      default: null,
      trim: true,
    },
    assignedDepartment: {
      type: String,
      default: null,
      trim: true,
    },
    fallbackUsed: {
      type: Boolean,
      default: false,
    },

    // ðŸŽ§ NEW FIELD
    recordingSid: String,
    recordingUrl: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Call', callSchema);
