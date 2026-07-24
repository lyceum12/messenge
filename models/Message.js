const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  roomId: { type: String, required: true },
  sender: { type: String, required: true },   // имя отправителя
  type: { type: String, enum: ['text', 'file'], default: 'text' },
  content: { type: String },                  // текст или URL файла
  fileMeta: { type: Object },                 // { name, size, mimeType }
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Message', MessageSchema);
