const mongoose = require('mongoose');

const CLIENT_PHONE_NUMBER_STATUSES = ['active', 'pending', 'porting', 'inactive', 'archived'];

const clientPhoneNumberSchema = new mongoose.Schema(
  {
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },
    clientAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientAccount',
      required: true,
    },
    resellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Reseller',
      default: null,
    },
    label: {
      type: String,
      default: '',
      trim: true,
    },
    capabilities: {
      voice: {
        type: Boolean,
        default: true,
      },
      sms: {
        type: Boolean,
        default: false,
      },
      mms: {
        type: Boolean,
        default: false,
      },
    },
    status: {
      type: String,
      enum: CLIENT_PHONE_NUMBER_STATUSES,
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
    route: {
      type: String,
      default: '',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    source: {
      type: String,
      enum: ['portal', 'legacy_metadata', 'twilio_future'],
      default: 'portal',
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

clientPhoneNumberSchema.index({ phoneNumber: 1 });
clientPhoneNumberSchema.index({ clientAccountId: 1, phoneNumber: 1 });
clientPhoneNumberSchema.index(
  { resellerId: 1 },
  { partialFilterExpression: { resellerId: { $type: 'objectId' } } }
);
clientPhoneNumberSchema.index({ archivedAt: 1 });

module.exports = mongoose.model('ClientPhoneNumber', clientPhoneNumberSchema);
