const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    sid: String, // ðŸ”¥ Twilio Message SID

    from: String,
    to: String,
    fromFull: String,
    toFull: String,
    body: String,
    direction: String,
    conversationType: {
      type: String,
      default: 'customer',
      enum: ['customer', 'internal_dm', 'team'],
    },
    conversationId: {
      type: String,
      default: '',
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
    textingGroupId: {
      type: String,
      default: null,
      index: true,
    },
    textingGroupName: {
      type: String,
      default: null,
    },
    senderId: {
      type: String,
      default: null,
    },
    senderName: {
      type: String,
      default: null,
    },
    source: {
      type: String,
      default: 'sms',
    },
    media: {
      type: [String],
      default: [],
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    editedAt: {
      type: Date,
      default: null,
    },
    originalText: {
      type: String,
      default: null,
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
    pinnedAt: {
      type: Date,
      default: null,
    },
    pinnedBy: {
      type: String,
      default: null,
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

    read: {
      type: Boolean,
      default: false,
    },
    readBy: {
      type: [String],
      default: [],
    },

    // ðŸ“Š DELIVERY STATUS
    status: {
      type: String,
      default: 'queued', // queued | sent | delivered | undelivered | failed
    },

    // â— ERROR CODE (NEW)
    errorCode: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Message', messageSchema);
