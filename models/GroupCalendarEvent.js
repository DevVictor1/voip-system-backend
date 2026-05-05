const mongoose = require('mongoose');

const groupCalendarEventSchema = new mongoose.Schema(
  {
    teamId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    startAt: {
      type: Date,
      required: true,
      index: true,
    },
    endAt: {
      type: Date,
      required: true,
    },
    createdBy: {
      type: String,
      required: true,
      trim: true,
    },
    isPinned: {
      type: Boolean,
      default: false,
      index: true,
    },
    pinnedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

groupCalendarEventSchema.index({ teamId: 1, startAt: 1, createdAt: 1 });
groupCalendarEventSchema.index({ teamId: 1, isPinned: 1, pinnedAt: 1, startAt: 1 });

module.exports = mongoose.model('GroupCalendarEvent', groupCalendarEventSchema);
