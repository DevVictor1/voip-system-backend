const mongoose = require('mongoose');

const callSchema = new mongoose.Schema(
  {
    clientAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientAccount',
      default: null,
    },
    callSid: { type: String, required: true, unique: true },

    from: String,
    to: String,
    status: String,
    duration: String,
    direction: String,
    parentCallSid: {
      type: String,
      default: null,
      trim: true,
    },
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
    attemptedAgentIds: {
      type: [String],
      default: [],
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastAttemptedAgentId: {
      type: String,
      default: null,
      trim: true,
    },
    queueCandidates: {
      type: [String],
      default: [],
    },
    fallbackCandidates: {
      type: [String],
      default: [],
    },

    // ðŸŽ§ NEW FIELD
    recordingSid: String,
    recordingUrl: String,
  },
  { timestamps: true }
);

callSchema.index(
  { clientAccountId: 1, createdAt: -1 },
  { partialFilterExpression: { clientAccountId: { $type: 'objectId' } } }
);
callSchema.index({ createdAt: -1 });
callSchema.index({ status: 1 });

module.exports = mongoose.model('Call', callSchema);
