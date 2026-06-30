const mongoose = require('mongoose');

const PORTING_REQUEST_STATUSES = [
  'draft',
  'review',
  'submitted',
  'scheduled',
  'porting',
  'completed',
  'rejected',
  'cancelled',
];

const portingPhoneNumberSchema = new mongoose.Schema(
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

const portingAddressSchema = new mongoose.Schema(
  {
    street: {
      type: String,
      default: '',
      trim: true,
    },
    city: {
      type: String,
      default: '',
      trim: true,
    },
    state: {
      type: String,
      default: '',
      trim: true,
    },
    postalCode: {
      type: String,
      default: '',
      trim: true,
    },
    country: {
      type: String,
      default: 'US',
      trim: true,
    },
  },
  { _id: false }
);

const authorizedSignerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: '',
      trim: true,
    },
    title: {
      type: String,
      default: '',
      trim: true,
    },
    email: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { _id: false }
);

const portingDocumentSchema = new mongoose.Schema(
  {
    documentType: {
      type: String,
      enum: ['loa', 'bill', 'csr', 'other'],
      default: 'other',
      trim: true,
    },
    fileName: {
      type: String,
      required: true,
      trim: true,
    },
    fileType: {
      type: String,
      required: true,
      trim: true,
    },
    fileSize: {
      type: Number,
      required: true,
      min: 1,
    },
    fileUrl: {
      type: String,
      required: true,
      trim: true,
    },
    storagePath: {
      type: String,
      required: true,
      trim: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    uploadedByName: {
      type: String,
      default: '',
      trim: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  }
);

const portingStatusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: PORTING_REQUEST_STATUSES,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    actorName: {
      type: String,
      default: '',
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }
);

const portingRequestSchema = new mongoose.Schema(
  {
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
    phoneNumbers: {
      type: [portingPhoneNumberSchema],
      default: [],
    },
    currentCarrier: {
      type: String,
      default: 'RingCentral',
      trim: true,
    },
    billingTelephoneNumber: {
      type: String,
      default: '',
      trim: true,
    },
    accountNumber: {
      type: String,
      default: '',
      trim: true,
    },
    pinOrPasscode: {
      type: String,
      default: '',
      trim: true,
    },
    serviceAddress: {
      type: portingAddressSchema,
      default: () => ({}),
    },
    authorizedSigner: {
      type: authorizedSignerSchema,
      default: () => ({}),
    },
    desiredPortDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: PORTING_REQUEST_STATUSES,
      default: 'draft',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    documents: {
      type: [portingDocumentSchema],
      default: [],
    },
    statusHistory: {
      type: [portingStatusHistorySchema],
      default: [],
    },
    twilioPortOrderId: {
      type: String,
      default: '',
      trim: true,
    },
    activatedAt: {
      type: Date,
      default: null,
    },
    activatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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

portingRequestSchema.index({ clientAccountId: 1, status: 1 });
portingRequestSchema.index(
  { resellerId: 1 },
  { partialFilterExpression: { resellerId: { $type: 'objectId' } } }
);
portingRequestSchema.index({ archivedAt: 1 });

module.exports = mongoose.model('PortingRequest', portingRequestSchema);
module.exports.PORTING_REQUEST_STATUSES = PORTING_REQUEST_STATUSES;
