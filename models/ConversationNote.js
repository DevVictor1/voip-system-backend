const mongoose = require('mongoose');

const conversationNoteSchema = new mongoose.Schema(
  {
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

module.exports = mongoose.model('ConversationNote', conversationNoteSchema);
