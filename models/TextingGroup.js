const mongoose = require('mongoose');

const textingGroupSchema = new mongoose.Schema(
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
      index: true,
    },
    members: {
      type: [String],
      default: [],
    },
    assignedNumber: {
      type: String,
      default: '',
      trim: true,
      index: true,
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

module.exports = mongoose.model('TextingGroup', textingGroupSchema);
