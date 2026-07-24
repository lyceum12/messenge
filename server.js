require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const Room = require('./models/Room');
const Message = require('./models/Message');
const uploadRoutes = require('./routes/upload');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' }
});

// Подключение к MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error(err));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));          // статика для клиента
app.use('/uploads', express.static('uploads')); // доступ к загруженным файлам
app.use('/api/upload', uploadRoutes);

// --------------------- REST API ---------------------

// 1. Создание комнаты (главный пользователь)
app.post('/api/rooms', async (req, res) => {
  const { roomName, ownerId } = req.body;
  if (!roomName || !ownerId) {
    return res.status(400).json({ error: 'Необходимо имя комнаты и ID владельца' });
  }
  const token = uuidv4();
  const room = new Room({
    name: roomName,
    ownerId,
    inviteToken: token,
    members: [ownerId]
  });
  await room.save();
  const inviteLink = `${req.protocol}://${req.get('host')}?join=${room._id}&token=${token}`;
  res.json({ roomId: room._id, inviteLink });
});

// 2. Проверка инвайт-токена (для входа)
app.get('/api/verify-invite/:roomId', async (req, res) => {
  const { roomId } = req.params;
  const { token } = req.query;
  const room = await Room.findById(roomId);
  if (!room || room.inviteToken !== token) {
    return res.status(403).json({ error: 'Недействительная ссылка' });
  }
  res.json({ valid: true, roomName: room.name });
});

// 3. Присоединение к комнате (добавление участника)
app.post('/api/join-room', async (req, res) => {
  const { roomId, token, username } = req.body;
  const room = await Room.findById(roomId);
  if (!room || room.inviteToken !== token) {
    return res.status(403).json({ error: 'Недействительная ссылка' });
  }
  // Генерируем временный sessionId
  const sessionId = uuidv4();
  if (!room.members.includes(sessionId)) {
    room.members.push(sessionId);
    await room.save();
  }
  res.json({ sessionId, roomName: room.name });
});

// 4. Получение истории сообщений комнаты
app.get('/api/messages/:roomId', async (req, res) => {
  const { roomId } = req.params;
  const messages = await Message.find({ roomId }).sort({ timestamp: 1 }).limit(100);
  res.json(messages);
});

// --------------------- WebSocket (Socket.IO) ---------------------

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Присоединение к комнате чата
  socket.on('join', async ({ roomId, sessionId, username }) => {
    // Проверяем, что сессия есть в участниках
    const room = await Room.findById(roomId);
    if (!room || !room.members.includes(sessionId)) {
      socket.emit('error', 'Доступ запрещён');
      return;
    }
    socket.join(roomId);
    socket.data = { roomId, sessionId, username };
    // Отправляем приветствие
    socket.emit('joined', { roomName: room.name, messages: await Message.find({ roomId }).sort({ timestamp: 1 }).limit(100) });
    // Оповещаем остальных
    socket.to(roomId).emit('user-joined', username);
  });

  // Обработка текстового сообщения
  socket.on('text-message', async (data) => {
    const { roomId, text } = data;
    const { username } = socket.data;
    if (!username) return;
    const message = new Message({
      roomId,
      sender: username,
      type: 'text',
      content: text
    });
    await message.save();
    io.to(roomId).emit('new-message', {
      sender: username,
      type: 'text',
      content: text,
      timestamp: message.timestamp
    });
  });

  // Обработка файлового сообщения (URL уже загружен через REST)
  socket.on('file-message', async (data) => {
    const { roomId, fileUrl, fileName, fileSize, mimeType } = data;
    const { username } = socket.data;
    if (!username) return;
    const message = new Message({
      roomId,
      sender: username,
      type: 'file',
      content: fileUrl,
      fileMeta: { name: fileName, size: fileSize, mimeType }
    });
    await message.save();
    io.to(roomId).emit('new-message', {
      sender: username,
      type: 'file',
      content: fileUrl,
      fileMeta: { name: fileName, size: fileSize, mimeType },
      timestamp: message.timestamp
    });
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Можно оповестить комнату, но для простоты опустим
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
