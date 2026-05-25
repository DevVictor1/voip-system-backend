const mongoose = require('mongoose');

const RESELLER_STATUSES = ['active', 'inactive', 'pending'];

const resellerAdminNoteSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    authorName: {
      type: String,
      default: '',
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }
);

const resellerActivityLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    actorName: {
      type: String,
      default: '',
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const resellerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
    },
    contactEmail: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    contactPhone: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: RESELLER_STATUSES,
      default: 'pending',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    adminNotes: {
      type: [resellerAdminNoteSchema],
      default: [],
    },
    activityLog: {
      type: [resellerActivityLogSchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Reseller', resellerSchema);
