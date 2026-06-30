const mongoose = require('mongoose');

const portingNumberSchema = new mongoose.Schema(
  {
    clientAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientAccount',
      default: null,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },
    label: {
      type: String,
      default: '',
      trim: true,
    },
    provider: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'pending', 'porting', 'completed', 'failed'],
      default: 'pending',
    },
    capabilities: {
      type: String,
      enum: ['voice', 'messaging', 'voice + messaging'],
      default: 'voice',
    },
    assignedTo: {
      type: String,
      default: '',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    requestedPortDate: {
      type: Date,
      default: null,
    },
    completedDate: {
      type: Date,
      default: null,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

portingNumberSchema.index(
  { clientAccountId: 1, phoneNumber: 1 },
  { partialFilterExpression: { clientAccountId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('PortingNumber', portingNumberSchema);
