const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    clientAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientAccount',
      default: null,
    },
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
    mentionedUserIds: {
      type: [String],
      default: [],
    },
    mentionedUsernames: {
      type: [String],
      default: [],
    },
    source: {
      type: String,
      default: 'sms',
    },
    media: {
      type: [String],
      default: [],
    },
    attachment: {
      type: new mongoose.Schema(
        {
          fileName: {
            type: String,
            default: '',
          },
          fileType: {
            type: String,
            default: '',
          },
          fileSize: {
            type: Number,
            default: 0,
          },
          fileUrl: {
            type: String,
            default: '',
          },
          storagePath: {
            type: String,
            default: '',
          },
        },
        { _id: false }
      ),
      default: null,
    },
    linkPreview: {
      type: new mongoose.Schema(
        {
          url: {
            type: String,
            default: '',
          },
          domain: {
            type: String,
            default: '',
          },
          title: {
            type: String,
            default: '',
          },
          description: {
            type: String,
            default: '',
          },
          siteName: {
            type: String,
            default: '',
          },
          image: {
            type: String,
            default: '',
          },
        },
        { _id: false }
      ),
      default: null,
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
    commentCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    latestThreadCommentId: {
      type: String,
      default: '',
    },
    latestThreadCommentAt: {
      type: Date,
      default: null,
      index: true,
    },
    latestThreadCommentSenderId: {
      type: String,
      default: '',
    },
    latestThreadCommentSenderName: {
      type: String,
      default: '',
    },
    latestThreadCommentSnippet: {
      type: String,
      default: '',
    },
    forwardedFromMessageId: {
      type: String,
      default: null,
    },
    replyTo: {
      type: new mongoose.Schema(
        {
          messageId: {
            type: String,
            default: null,
          },
          senderName: {
            type: String,
            default: '',
          },
          body: {
            type: String,
            default: '',
          },
        },
        { _id: false }
      ),
      default: null,
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

messageSchema.index(
  { clientAccountId: 1, conversationId: 1, createdAt: -1 },
  { partialFilterExpression: { clientAccountId: { $type: 'objectId' } } }
);
messageSchema.index({ direction: 1, status: 1 });
messageSchema.index({ direction: 1, to: 1, from: 1 });

module.exports = mongoose.model('Message', messageSchema);
