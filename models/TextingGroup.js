const mongoose = require('mongoose');

const textingGroupSchema = new mongoose.Schema(
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

textingGroupSchema.index(
  { clientAccountId: 1, slug: 1 },
  { partialFilterExpression: { clientAccountId: { $type: 'objectId' } } }
);
textingGroupSchema.index(
  { clientAccountId: 1, assignedNumber: 1 },
  { partialFilterExpression: { clientAccountId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('TextingGroup', textingGroupSchema);
