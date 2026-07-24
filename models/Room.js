const mongoose = require('mongoose');

const RoomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  ownerId: { type: String, required: true },   // sessionId владельца
  inviteToken: { type: String, unique: true, required: true },
  members: [{ type: String }]                  // sessionId участников
}, { timestamps: true });

module.exports = mongoose.model('Room', RoomSchema);
