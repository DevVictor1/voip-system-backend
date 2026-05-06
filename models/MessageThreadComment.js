const mongoose = require('mongoose');

const messageThreadCommentSchema = new mongoose.Schema(
  {
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
    participants: {
      type: [String],
      default: [],
    },
    teamId: {
      type: String,
      default: null,
    },
    teamName: {
      type: String,
      default: null,
    },
    senderId: {
      type: String,
      required: true,
      index: true,
    },
    senderName: {
      type: String,
      default: '',
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    reactions: {
      type: [
        new mongoose.Schema(
          {
            emoji: {
              type: String,
              default: '',
            },
            userId: {
              type: String,
              default: '',
            },
            userName: {
              type: String,
              default: '',
            },
            createdAt: {
              type: Date,
              default: Date.now,
            },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

messageThreadCommentSchema.index({ parentMessageId: 1, createdAt: 1 });

module.exports = mongoose.model('MessageThreadComment', messageThreadCommentSchema);
