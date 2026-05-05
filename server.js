require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const connectDB = require('./config/db');
const callRoutes = require('./routes/callRoutes');
const smsRoutes = require('./routes/smsRoutes');
const messageRoutes = require('./routes/messageRoutes');
const contactRoutes = require('./routes/contactRoutes');
const voiceRoutes = require('./routes/voiceRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const numberRoutes = require('./routes/numberRoutes');
const authRoutes = require('./routes/authRoutes');

const app = express();

// ✅ HARD CORS FIX
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

// 🔥 DEBUG LOGGER
app.use((req, res, next) => {
  console.log("👉 Incoming Request:", req.method, req.url);
  next();
});

// ✅ MIDDLEWARE
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use('/uploads', express.static('uploads'));

// ✅ ROUTES
app.use('/api/calls', callRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/numbers', numberRoutes);
app.use('/api/auth', authRoutes);

// 🔥 RECORDING PROXY
app.get('/api/recordings/:sid', async (req, res) => {
  try {
    const { sid } = req.params;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`;

    const response = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    response.data.pipe(res);

  } catch (err) {
    console.error('❌ Recording fetch error:', err.message);
    res.status(500).send('Failed to fetch recording');
  }
});

// ✅ TEST ROUTE
app.get('/', (req, res) => {
  res.send('VoIP Backend Running...');
});

const server = http.createServer(app);

// ==========================
// 🔥 SOCKET.IO (UPDATED)
// ==========================
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
});

global.io = io;

// 🔥 STORE USERS
const users = {};
global.connectedUsers = users;
const connectedUserSockets = {};
global.connectedUserSockets = connectedUserSockets;
const agentStatus = {};
global.agentStatus = agentStatus;
const agentVoiceReady = {};
global.agentVoiceReady = agentVoiceReady;

io.on('connection', (socket) => {
  console.log('⚡ Connected:', socket.id);

  // ✅ REGISTER USER
  socket.on('registerUser', (payload) => {
    const userId = typeof payload === 'string' ? payload : payload?.userId;
    const status = payload?.status;
    const voiceReady = payload?.voiceReady;
    const availabilityStatus = payload?.availabilityStatus;

    if (!userId) {
      console.log('⚠️ registerUser skipped: missing userId');
      return;
    }

    if (!connectedUserSockets[userId]) {
      connectedUserSockets[userId] = new Set();
    }

    connectedUserSockets[userId].add(socket.id);
    users[userId] = socket.id;
    agentStatus[userId] = status || agentStatus[userId] || 'online';
    agentVoiceReady[userId] = typeof voiceReady === 'boolean'
      ? voiceReady
      : Boolean(agentVoiceReady[userId]);
    socket.data.userId = userId;
    socket.data.registeredUserId = userId;
    console.log(
      `✅ Registered ${userId} → ${socket.id} | status=${agentStatus[userId]} | voiceReady=${agentVoiceReady[userId]}`
    );

    io.emit('agentStatus', { userId, status: agentStatus[userId] });
    if (availabilityStatus) {
      io.emit('agentAvailabilityStatus', { userId, availabilityStatus });
    }
  });

  socket.on('agentStatus', (data) => {
    const { userId, status } = data || {};
    if (!userId || !status) return;
    agentStatus[userId] = status;
    console.log(`📶 Agent marked ${status}: ${userId}`);
    io.emit('agentStatus', { userId, status });
  });

  socket.on('voiceReady', (data) => {
    const { userId, voiceReady, deviceStatus } = data || {};
    if (!userId) return;

    agentVoiceReady[userId] = Boolean(voiceReady);
    console.log(
      `🎙️ Voice presence ${userId} → ready=${agentVoiceReady[userId]} | deviceStatus=${deviceStatus || 'unknown'}`
    );
  });

  socket.on('getAgentsStatus', () => {
    const statusMap = { ...agentStatus };
    for (const userId in users) {
      if (!statusMap[userId]) statusMap[userId] = 'online';
    }
    socket.emit('agentsStatus', statusMap);
  });

  socket.on('disconnect', () => {
    console.log('❌ Disconnected:', socket.id);

    const disconnectedUserId = socket.data?.registeredUserId || socket.data?.userId;

    if (disconnectedUserId) {
      const socketSet = connectedUserSockets[disconnectedUserId];
      if (socketSet) {
        socketSet.delete(socket.id);
      }

      if (socketSet && socketSet.size > 0) {
        users[disconnectedUserId] = Array.from(socketSet)[0];
      } else {
        delete connectedUserSockets[disconnectedUserId];
        delete users[disconnectedUserId];
        agentStatus[disconnectedUserId] = 'offline';
        agentVoiceReady[disconnectedUserId] = false;
        io.emit('agentStatus', { userId: disconnectedUserId, status: 'offline' });
        console.log(`📴 Agent disconnected ${disconnectedUserId} | voiceReady=false`);
      }
    }
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
