const mongoose = require('mongoose');

const portingNumberSchema = new mongoose.Schema(
  {
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
  },
  { timestamps: true }
);

module.exports = mongoose.model('PortingNumber', portingNumberSchema);
