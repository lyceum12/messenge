// Парсим параметры URL для инвайта
const params = new URLSearchParams(window.location.search);
const roomId = params.get('join');
const token = params.get('token');

let socket;
let sessionId = null;
let username = '';
let currentRoomId = '';

const loginScreen = document.getElementById('login-screen');
const chatScreen = document.getElementById('chat-screen');
const inviteInfo = document.getElementById('invite-info');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');
const errorMsg = document.getElementById('error-msg');
const roomNameSpan = document.getElementById('room-name');
const messageArea = document.getElementById('message-area');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const fileInput = document.getElementById('file-input');
const emojiBtn = document.getElementById('emoji-btn');
const logoutBtn = document.getElementById('logout-btn');

// Проверяем инвайт при загрузке
if (roomId && token) {
  fetch(`/api/verify-invite/${roomId}?token=${token}`)
    .then(res => res.json())
    .then(data => {
      if (data.valid) {
        inviteInfo.innerText = `Приглашение в комнату "${data.roomName}"`;
        // Сохраняем данные для входа
        window.__inviteData = { roomId, token, roomName: data.roomName };
      } else {
        errorMsg.innerText = 'Ссылка недействительна';
      }
    })
    .catch(() => errorMsg.innerText = 'Ошибка проверки ссылки');
} else {
  // Если нет параметров – показываем форму создания комнаты
  inviteInfo.innerHTML = `
    <div>
      <h3>Создать новую комнату</h3>
      <input type="text" id="new-room-name" placeholder="Название комнаты">
      <button id="create-room-btn">Создать</button>
    </div>
  `;
  document.getElementById('create-room-btn')?.addEventListener('click', () => {
    const name = document.getElementById('new-room-name').value.trim();
    if (!name) return alert('Введите название');
    const ownerId = 'owner_' + Date.now(); // простой ID
    fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName: name, ownerId })
    })
    .then(res => res.json())
    .then(data => {
      alert(`Комната создана! Ссылка-приглашение:\n${data.inviteLink}`);
      // Можно автоматически войти как владелец
      window.location.href = data.inviteLink; // перезагрузим с параметрами
    })
    .catch(err => alert('Ошибка: ' + err.message));
  });
}

// Обработчик входа по инвайту
joinBtn.addEventListener('click', async () => {
  const name = usernameInput.value.trim();
  if (!name) return errorMsg.innerText = 'Введите имя';
  const invite = window.__inviteData;
  if (!invite) return errorMsg.innerText = 'Нет активного приглашения';

  try {
    const res = await fetch('/api/join-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: invite.roomId,
        token: invite.token,
        username: name
      })
    });
    const data = await res.json();
    if (res.ok) {
      sessionId = data.sessionId;
      username = name;
      currentRoomId = invite.roomId;
      // Подключаем сокет
      connectSocket(invite.roomId, sessionId, username);
      loginScreen.style.display = 'none';
      chatScreen.style.display = 'flex';
      roomNameSpan.innerText = `Комната: ${data.roomName}`;
      errorMsg.innerText = '';
    } else {
      errorMsg.innerText = data.error || 'Ошибка входа';
    }
  } catch (err) {
    errorMsg.innerText = 'Ошибка сети';
  }
});

function connectSocket(roomId, sessId, user) {
  socket = io(); // подключаемся к тому же хосту
  socket.on('connect', () => {
    socket.emit('join', { roomId, sessionId: sessId, username: user });
  });

  socket.on('joined', (data) => {
    // Показываем историю
    messageArea.innerHTML = '';
    data.messages.forEach(msg => renderMessage(msg, user));
  });

  socket.on('new-message', (msg) => {
    renderMessage(msg, user);
    messageArea.scrollTop = messageArea.scrollHeight;
  });

  socket.on('user-joined', (name) => {
    addSystemMessage(`${name} присоединился`);
  });

  socket.on('error', (err) => alert(err));
}

// Отправка текста
sendBtn.addEventListener('click', sendText);
textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });

function sendText() {
  const text = textInput.value.trim();
  if (!text || !socket) return;
  socket.emit('text-message', { roomId: currentRoomId, text });
  textInput.value = '';
}

// Отправка файла
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (res.ok) {
      // Отправляем через сокет ссылку на файл
      socket.emit('file-message', {
        roomId: currentRoomId,
        fileUrl: data.url,
        fileName: data.name,
        fileSize: data.size,
        mimeType: data.mimeType
      });
    } else {
      alert('Ошибка загрузки файла');
    }
  } catch (err) {
    alert('Ошибка загрузки');
  }
  fileInput.value = ''; // сбросить
});

// Кнопка смайликов (вставляет 😊 в поле ввода)
emojiBtn.addEventListener('click', () => {
  textInput.value += '😊';
  textInput.focus();
});

// Выход
logoutBtn.addEventListener('click', () => {
  if (socket) socket.disconnect();
  location.reload();
});

// Функция отрисовки сообщения
function renderMessage(msg, currentUser) {
  const div = document.createElement('div');
  div.className = 'message ' + (msg.sender === currentUser ? 'sent' : 'received');
  const senderSpan = document.createElement('div');
  senderSpan.className = 'sender';
  senderSpan.innerText = msg.sender;
  const contentDiv = document.createElement('div');

  if (msg.type === 'text') {
    contentDiv.innerText = msg.content;
  } else if (msg.type === 'file') {
    const fileUrl = msg.content;
    const meta = msg.fileMeta || {};
    if (meta.mimeType && meta.mimeType.startsWith('image/')) {
      contentDiv.innerHTML = `<img src="${fileUrl}" style="max-width:200px; max-height:200px;">`;
    } else if (meta.mimeType && meta.mimeType.startsWith('video/')) {
      contentDiv.innerHTML = `<video controls src="${fileUrl}" style="max-width:100%; max-height:300px;"></video>`;
    } else {
      contentDiv.innerHTML = `<a href="${fileUrl}" target="_blank">📎 ${meta.name || 'Файл'}</a>`;
    }
  }
  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.innerText = new Date(msg.timestamp).toLocaleTimeString();
  div.appendChild(senderSpan);
  div.appendChild(contentDiv);
  div.appendChild(timeSpan);
  messageArea.appendChild(div);
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.style.textAlign = 'center';
  div.style.color = '#888';
  div.style.fontSize = '0.9rem';
  div.innerText = text;
  messageArea.appendChild(div);
}
