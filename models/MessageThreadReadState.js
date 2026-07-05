const mongoose = require('mongoose');

const messageThreadReadStateSchema = new mongoose.Schema(
  {
    clientAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientAccount',
      default: null,
    },
    parentMessageId: {
      type: String,
      required: true,
      index: true,
    },
    conversationId: {
      type: String,
      required: true,
      index: true,
    },
    conversationType: {
      type: String,
      required: true,
      enum: ['internal_dm', 'team'],
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    lastSeenCommentId: {
      type: String,
      default: '',
    },
    lastSeenCommentAt: {
      type: Date,
      default: null,
    },
    lastOpenedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

messageThreadReadStateSchema.index({ parentMessageId: 1, userId: 1 }, { unique: true });
messageThreadReadStateSchema.index({ userId: 1, conversationId: 1 });
messageThreadReadStateSchema.index(
  { clientAccountId: 1, userId: 1, conversationId: 1 },
  { partialFilterExpression: { clientAccountId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('MessageThreadReadState', messageThreadReadStateSchema);
