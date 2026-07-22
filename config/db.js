const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 30,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      waitQueueTimeoutMS: 5000,
      maxIdleTimeMS: 30000,
    });

    console.log('MongoDB Connected');
  } catch (error) {
    console.error('MongoDB Error:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
