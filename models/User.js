const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { USER_ROLES } = require('../utils/accessControl');

const USER_DEPARTMENTS = ['tech', 'support', 'sales'];
const USER_ASSIGNMENT_STATUSES = ['available', 'busy', 'offline'];
const USER_AVAILABILITY_STATUSES = ['online', 'busy', 'meeting', 'break', 'offline'];
const SALT_ROUNDS = 10;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    firstName: {
      type: String,
      default: '',
      trim: true,
    },
    lastName: {
      type: String,
      default: '',
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: USER_ROLES,
      required: true,
    },
    clientAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientAccount',
      default: null,
    },
    agentId: {
      type: String,
      default: null,
      trim: true,
    },
    extension: {
      type: String,
      default: '',
      trim: true,
    },
    didNumber: {
      type: String,
      default: '',
      trim: true,
    },
    callerId: {
      type: String,
      default: '',
      trim: true,
    },
    department: {
      type: String,
      enum: USER_DEPARTMENTS,
      default: null,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: USER_ASSIGNMENT_STATUSES,
      default: 'offline',
      trim: true,
    },
    availabilityStatus: {
      type: String,
      enum: USER_AVAILABILITY_STATUSES,
      default: 'online',
      trim: true,
    },
    maxActiveChats: {
      type: Number,
      default: 5,
      min: 0,
    },
    currentActiveChats: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxConcurrentCalls: {
      type: Number,
      default: 1,
      min: 0,
    },
    avatarUrl: {
      type: String,
      default: '',
      trim: true,
    },
    isAssignable: {
      type: Boolean,
      default: true,
    },
    favoritePersonalChatIds: {
      type: [String],
      default: [],
    },
    favoriteTeamChatIds: {
      type: [String],
      default: [],
    },
    mutedTeamChatIds: {
      type: [String],
      default: [],
    },
    chatNotificationSoundEnabled: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

userSchema.index(
  { clientAccountId: 1 },
  { partialFilterExpression: { clientAccountId: { $type: 'objectId' } } }
);

userSchema.index(
  { agentId: 1 },
  {
    unique: true,
    partialFilterExpression: { agentId: { $type: 'string' } },
  }
);

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) {
    return;
  }

  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
});

userSchema.methods.comparePassword = function comparePassword(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toSafeObject = function toSafeObject() {
    return {
      id: this._id,
      name: this.name,
      firstName: this.firstName || '',
      lastName: this.lastName || '',
      email: this.email,
      role: this.role,
      clientAccountId: this.clientAccountId ? String(this.clientAccountId) : null,
      agentId: this.agentId,
      extension: this.extension || '',
      didNumber: this.didNumber || '',
      callerId: this.callerId || '',
      department: this.department,
      isActive: this.isActive,
      status: this.status || 'offline',
      availabilityStatus: this.availabilityStatus || 'online',
      maxActiveChats: Number.isFinite(this.maxActiveChats) ? this.maxActiveChats : 5,
      currentActiveChats: Number.isFinite(this.currentActiveChats) ? this.currentActiveChats : 0,
      maxConcurrentCalls: Number.isFinite(this.maxConcurrentCalls) ? this.maxConcurrentCalls : 1,
      avatarUrl: this.avatarUrl || '',
      isAssignable: typeof this.isAssignable === 'boolean' ? this.isAssignable : true,
      favoritePersonalChatIds: Array.isArray(this.favoritePersonalChatIds) ? this.favoritePersonalChatIds : [],
      favoriteTeamChatIds: Array.isArray(this.favoriteTeamChatIds) ? this.favoriteTeamChatIds : [],
      mutedTeamChatIds: Array.isArray(this.mutedTeamChatIds) ? this.mutedTeamChatIds : [],
      chatNotificationSoundEnabled: typeof this.chatNotificationSoundEnabled === 'boolean'
        ? this.chatNotificationSoundEnabled
        : true,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
};

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
