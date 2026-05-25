const mongoose = require('mongoose');

const CLIENT_ACCOUNT_STATUSES = ['active', 'inactive', 'suspended', 'pending'];
const CLIENT_NUMBER_TYPES = ['voice', 'sms', 'voice+sms'];
const CLIENT_NUMBER_STATUSES = ['active', 'pending', 'porting', 'inactive'];

const clientNumberMetadataSchema = new mongoose.Schema(
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
    type: {
      type: String,
      enum: CLIENT_NUMBER_TYPES,
      default: 'voice',
      trim: true,
    },
    status: {
      type: String,
      enum: CLIENT_NUMBER_STATUSES,
      default: 'pending',
      trim: true,
    },
    assignedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedDepartment: {
      type: String,
      default: '',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { _id: false }
);

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
    assignedNumberRecords: {
      type: [clientNumberMetadataSchema],
      default: [],
    },
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ClientAccount', clientAccountSchema);
