const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const USER_ROLES = ['admin', 'agent'];
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
    agentId: {
      type: String,
      default: null,
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
    isAssignable: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
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
      email: this.email,
      role: this.role,
      agentId: this.agentId,
      department: this.department,
      isActive: this.isActive,
      status: this.status || 'offline',
      availabilityStatus: this.availabilityStatus || 'online',
      maxActiveChats: Number.isFinite(this.maxActiveChats) ? this.maxActiveChats : 5,
      currentActiveChats: Number.isFinite(this.currentActiveChats) ? this.currentActiveChats : 0,
      maxConcurrentCalls: Number.isFinite(this.maxConcurrentCalls) ? this.maxConcurrentCalls : 1,
      isAssignable: typeof this.isAssignable === 'boolean' ? this.isAssignable : true,
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
