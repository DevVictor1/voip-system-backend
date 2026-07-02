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
    pinOrPasscode: {
      type: String,
      default: '',
      trim: true,
    },
    portabilityStatus: {
      type: String,
      default: '',
      trim: true,
    },
    portabilityCheckedAt: {
      type: Date,
      default: null,
    },
    portable: {
      type: Boolean,
      default: null,
    },
    notPortableReason: {
      type: String,
      default: '',
      trim: true,
    },
    notPortableReasonCode: {
      type: String,
      default: '',
      trim: true,
    },
    numberType: {
      type: String,
      default: '',
      trim: true,
    },
    country: {
      type: String,
      default: '',
      trim: true,
    },
    pinAndAccountNumberRequired: {
      type: Boolean,
      default: null,
    },
    twilioPortInPhoneNumberSid: {
      type: String,
      default: '',
      trim: true,
    },
    twilioIncomingPhoneNumberSid: {
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
    street2: {
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
    twilioDocumentSid: {
      type: String,
      default: '',
      trim: true,
    },
    twilioDocumentType: {
      type: String,
      default: '',
      trim: true,
    },
    twilioUploadedAt: {
      type: Date,
      default: null,
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

const portingWebhookEventSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      default: '',
      trim: true,
    },
    portInRequestSid: {
      type: String,
      default: '',
      trim: true,
    },
    portInPhoneNumberSid: {
      type: String,
      default: '',
      trim: true,
    },
    phoneNumber: {
      type: String,
      default: '',
      trim: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
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
    customerType: {
      type: String,
      enum: ['', 'Business', 'Individual'],
      default: '',
      trim: true,
    },
    customerName: {
      type: String,
      default: '',
      trim: true,
    },
    notificationEmails: {
      type: [String],
      default: [],
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
    targetPortInTimeRangeStart: {
      type: String,
      default: '',
      trim: true,
    },
    targetPortInTimeRangeEnd: {
      type: String,
      default: '',
      trim: true,
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
    twilioPortInRequestSid: {
      type: String,
      default: '',
      trim: true,
    },
    webhookEvents: {
      type: [portingWebhookEventSchema],
      default: [],
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
