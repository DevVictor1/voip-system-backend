const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    clientAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientAccount',
      default: null,
    },
    conversationId: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['internal_dm', 'team', 'customer'],
      default: 'internal_dm',
    },
    title: {
      type: String,
      default: '',
      trim: true,
    },
    participants: {
      type: [String],
      default: [],
    },
    teamId: {
      type: String,
      default: '',
      trim: true,
    },
    createdBy: {
      type: String,
      default: '',
      trim: true,
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
    lastMessagePreview: {
      type: String,
      default: '',
      trim: true,
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

conversationSchema.index(
  { clientAccountId: 1, type: 1, lastMessageAt: -1 },
  { partialFilterExpression: { clientAccountId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Conversation', conversationSchema);
