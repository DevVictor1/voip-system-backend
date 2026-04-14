require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const connectDB = require('./config/db');
const callRoutes = require('./routes/callRoutes');
const smsRoutes = require('./routes/smsRoutes');
const contactRoutes = require('./routes/contactRoutes');
const voiceRoutes = require('./routes/voiceRoutes');

const app = express();

// ✅ HARD CORS FIX
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ ROUTES
app.use('/api/calls', callRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/voice', voiceRoutes);

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
const agentStatus = {};
global.agentStatus = agentStatus;

io.on('connection', (socket) => {
  console.log('⚡ Connected:', socket.id);

  // ✅ REGISTER USER
  socket.on('registerUser', (userId) => {
    users[userId] = socket.id;
    agentStatus[userId] = 'online';
    console.log(`✅ Registered ${userId} → ${socket.id}`);
  });

  socket.on('agentStatus', (data) => {
    const { userId, status } = data || {};
    if (!userId || !status) return;
    agentStatus[userId] = status;
    console.log(`📶 Status ${userId} → ${status}`);
    io.emit('agentStatus', { userId, status });
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

    for (const userId in users) {
      if (users[userId] === socket.id) {
        delete users[userId];
        agentStatus[userId] = 'offline';
        io.emit('agentStatus', { userId, status: 'offline' });
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
