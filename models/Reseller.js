const mongoose = require('mongoose');

const RESELLER_STATUSES = ['active', 'inactive', 'pending'];

const resellerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
    },
    contactEmail: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    contactPhone: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: RESELLER_STATUSES,
      default: 'pending',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Reseller', resellerSchema);
