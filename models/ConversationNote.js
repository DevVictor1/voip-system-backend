const mongoose = require('mongoose');

const conversationNoteSchema = new mongoose.Schema(
  {
    clientAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientAccount',
      default: null,
    },
    conversationId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    conversationType: {
      type: String,
      required: true,
      enum: ['internal_dm', 'team'],
      index: true,
    },
    authorId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    authorName: {
      type: String,
      default: '',
      trim: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { timestamps: true }
);

conversationNoteSchema.index({ conversationType: 1, conversationId: 1, updatedAt: -1 });
conversationNoteSchema.index(
  { clientAccountId: 1, conversationType: 1, conversationId: 1, updatedAt: -1 },
  { partialFilterExpression: { clientAccountId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('ConversationNote', conversationNoteSchema);
