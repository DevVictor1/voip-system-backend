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
  },
  { timestamps: true }
);

groupCalendarEventSchema.index({ teamId: 1, startAt: 1, createdAt: 1 });

module.exports = mongoose.model('GroupCalendarEvent', groupCalendarEventSchema);
