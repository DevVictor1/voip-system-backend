require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const callRoutes = require('./routes/callRoutes');
const smsRoutes = require('./routes/smsRoutes');
const contactRoutes = require('./routes/contactRoutes');
const tokenRoutes = require('./routes/tokenRoutes');
const voiceRoutes = require('./routes/voiceRoutes');

const app = express();

// ✅ HARD CORS FIX (WORKS 100%)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

// 🔥🔥 NUCLEAR DEBUG LOGGER (ADD THIS)
app.use((req, res, next) => {
  console.log("👉 Incoming Request:", req.method, req.url);
  next();
});

// ✅ MIDDLEWARE
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ ROUTES
app.use('/api/calls', callRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api', tokenRoutes);
app.use('/api/voice', voiceRoutes);

// ✅ TEST ROUTE
app.get('/', (req, res) => {
  res.send('VoIP Backend Running...');
});

// ✅ CREATE HTTP SERVER
const server = http.createServer(app);

// ✅ SOCKET.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
});

global.io = io;

io.on('connection', (socket) => {
  console.log('⚡ Connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('❌ Disconnected:', socket.id);
  });
});

// ✅ PORT
const PORT = process.env.PORT || 5000;

// ✅ START SERVER
const startServer = async () => {
  try {
    await connectDB();
    console.log("✅ DB connected");
  } catch (err) {
    console.log("⚠️ DB failed, but continuing...");
  }

  server.listen(PORT, () => {
    console.log(`🚀 Server running on ${PORT}`);
  });
};

startServer();