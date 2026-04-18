const mongoose = require('mongoose');
const TEAM_DEPARTMENTS = ['tech', 'support', 'sales'];

const teamSchema = new mongoose.Schema(
  {
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
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Team', teamSchema);
