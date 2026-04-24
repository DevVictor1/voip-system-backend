const mongoose = require('mongoose');

const CONTACT_ASSIGNMENT_STATUSES = ['open', 'resolved', 'closed'];

const contactSchema = new mongoose.Schema(
{
  firstName: String,
  lastName: String,

  // Multiple numbers
  phones: [
    {
      label: String,
      number: String,
    }
  ],

  dba: String,
  mid: String,
  notes: {
    type: String,
    default: '',
  },
  textingGroupId: {
    type: String,
    default: null,
    trim: true,
  },
  textingGroupName: {
    type: String,
    default: null,
    trim: true,
  },

  // Shared inbox assignment identity
  assignedTo: {
    type: String,
    default: null,
  },

  // Shared inbox availability flag
  isUnassigned: {
    type: Boolean,
    default: true,
  },
  assignmentStatus: {
    type: String,
    enum: CONTACT_ASSIGNMENT_STATUSES,
    default: 'open',
    trim: true,
  }
},
{ timestamps: true }
);

contactSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.assignmentStatus = ret.assignmentStatus || 'open';
    return ret;
  },
});

module.exports = mongoose.model('Contact', contactSchema);
