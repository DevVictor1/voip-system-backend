const mongoose = require('mongoose');

const CLIENT_ACCOUNT_STATUSES = ['active', 'inactive', 'suspended', 'pending'];

const clientAccountSchema = new mongoose.Schema(
  {
    resellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Reseller',
      default: null,
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
    },
    accountStatus: {
      type: String,
      enum: CLIENT_ACCOUNT_STATUSES,
      default: 'pending',
      trim: true,
    },
    plan: {
      type: String,
      default: '',
      trim: true,
    },
    seatLimit: {
      type: Number,
      default: 0,
      min: 0,
    },
    assignedNumbers: {
      type: [String],
      default: [],
    },
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ClientAccount', clientAccountSchema);
