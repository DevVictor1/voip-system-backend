const mongoose = require('mongoose');
const TEAM_DEPARTMENTS = ['tech', 'support', 'sales'];
const TEAM_CALENDAR_TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Ho_Chi_Minh'];

const teamSchema = new mongoose.Schema(
  {
    clientAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientAccount',
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    avatarUrl: {
      type: String,
      default: '',
      trim: true,
    },
    avatarStoragePath: {
      type: String,
      default: '',
      trim: true,
    },
    avatarFileName: {
      type: String,
      default: '',
      trim: true,
    },
    avatarMimeType: {
      type: String,
      default: '',
      trim: true,
    },
    avatarUpdatedAt: {
      type: Date,
      default: null,
    },
    members: {
      type: [String],
      default: [],
    },
    department: {
      type: String,
      enum: TEAM_DEPARTMENTS,
      default: null,
      trim: true,
    },
    createdBy: {
      type: String,
      default: '',
      trim: true,
    },
    calendarTimezone: {
      type: String,
      enum: TEAM_CALENDAR_TIMEZONES,
      default: 'America/New_York',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

teamSchema.index(
  { clientAccountId: 1, slug: 1 },
  { partialFilterExpression: { clientAccountId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Team', teamSchema);
