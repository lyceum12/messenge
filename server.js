const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const Database = require('better-sqlite3');

// ---------- Инициализация SQLite ----------
const db = new Database('database.sqlite');

// Создаём таблицы, если их нет
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ownerId TEXT NOT NULL,
    inviteToken TEXT UNIQUE NOT NULL,
    members TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomId TEXT NOT NULL,
    sender TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    content TEXT,
    fileMeta TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (roomId) REFERENCES rooms(id)
  );
`);

// Вспомогательные функции для работы с БД
function getRoom(id) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
}

function getRoomByToken(token) {
  return db.prepare('SELECT * FROM rooms WHERE inviteToken = ?').get(token);
}

function createRoom(id, name, ownerId, token) {
  const stmt = db.prepare('INSERT INTO rooms (id, name, ownerId, inviteToken, members) VALUES (?, ?, ?, ?, ?)');
  stmt.run(id, name, ownerId, token, JSON.stringify([ownerId]));
}

function addMember(roomId, sessionId) {
  const room = getRoom(roomId);
  if (!room) return;
  const members = JSON.parse(room.members);
  if (!members.includes(sessionId)) {
    members.push(sessionId);
    db.prepare('UPDATE rooms SET members = ? WHERE id = ?').run(JSON.stringify(members), roomId);
  }
}

function getMessages(roomId, limit = 100) {
  const stmt = db.prepare('SELECT * FROM messages WHERE roomId = ? ORDER BY timestamp ASC LIMIT ?');
  return stmt.all(roomId, limit);
}

function saveMessage(roomId, sender, type, content, fileMeta = null) {
  const stmt = db.prepare(
    'INSERT INTO messages (roomId, sender, type, content, fileMeta, timestamp) VALUES (?, ?, ?, ?, ?, datetime("now"))'
  );
  const info = stmt.run(roomId, sender, type, content, fileMeta ? JSON.stringify(fileMeta) : null);
  // Возвращаем сохранённое сообщение с timestamp
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  return row;
}

// ---------- Express ----------
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// REST API
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size,
    mimeType: req.file.mimetype
  });
});

// Создание комнаты
app.post('/api/rooms', (req, res) => {
  const { roomName, ownerId } = req.body;
  if (!roomName || !ownerId) {
    return res.status(400).json({ error: 'Необходимо имя комнаты и ID владельца' });
  }
  const roomId = uuidv4();
  const token = uuidv4();
  createRoom(roomId, roomName, ownerId, token);
  const inviteLink = `${req.protocol}://${req.get('host')}?join=${roomId}&token=${token}`;
  res.json({ roomId, inviteLink });
});

// Проверка инвайт-токена
app.get('/api/verify-invite/:roomId', (req, res) => {
  const { roomId } = req.params;
  const { token } = req.query;
  const room = getRoom(roomId);
  if (!room || room.inviteToken !== token) {
    return res.status(403).json({ error: 'Недействительная ссылка' });
  }
  res.json({ valid: true, roomName: room.name });
});

// Присоединение к комнате
app.post('/api/join-room', (req, res) => {
  const { roomId, token, username } = req.body;
  const room = getRoom(roomId);
  if (!room || room.inviteToken !== token) {
    return res.status(403).json({ error: 'Недействительная ссылка' });
  }
  const sessionId = uuidv4();
  addMember(roomId, sessionId);
  res.json({ sessionId, roomName: room.name });
});

// История сообщений
app.get('/api/messages/:roomId', (req, res) => {
  const { roomId } = req.params;
  const messages = getMessages(roomId);
  res.json(messages);
});

// ---------- WebSocket ----------
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('join', ({ roomId, sessionId, username }) => {
    const room = getRoom(roomId);
    if (!room) {
      socket.emit('error', 'Комната не найдена');
      return;
    }
    const members = JSON.parse(room.members);
    if (!members.includes(sessionId)) {
      socket.emit('error', 'Доступ запрещён');
      return;
    }
    socket.join(roomId);
    socket.data = { roomId, sessionId, username };
    const messages = getMessages(roomId);
    socket.emit('joined', { roomName: room.name, messages });
    socket.to(roomId).emit('user-joined', username);
  });

  socket.on('text-message', ({ roomId, text }) => {
    const { username } = socket.data;
    if (!username) return;
    const msg = saveMessage(roomId, username, 'text', text);
    io.to(roomId).emit('new-message', {
      sender: username,
      type: 'text',
      content: text,
      timestamp: msg.timestamp
    });
  });

  socket.on('file-message', ({ roomId, fileUrl, fileName, fileSize, mimeType }) => {
    const { username } = socket.data;
    if (!username) return;
    const msg = saveMessage(roomId, username, 'file', fileUrl, { name: fileName, size: fileSize, mimeType });
    io.to(roomId).emit('new-message', {
      sender: username,
      type: 'file',
      content: fileUrl,
      fileMeta: { name: fileName, size: fileSize, mimeType },
      timestamp: msg.timestamp
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
