const Database = require('better-sqlite3');
const path = require('path');

let db;

function init() {
  db = new Database(path.join(__dirname, 'dnd-bot.db'));
  // Пример создания таблиц
  db.prepare(`CREATE TABLE IF NOT EXISTS game_state (
    chat_id TEXT PRIMARY KEY,
    state TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

function saveState(chatId, state) {
  db.prepare('INSERT OR REPLACE INTO game_state (chat_id, state) VALUES (?, ?)')
    .run(chatId, JSON.stringify(state));
}

function loadState(chatId) {
  const row = db.prepare('SELECT state FROM game_state WHERE chat_id = ?').get(chatId);
  return row ? JSON.parse(row.state) : null;
}

module.exports = { init, saveState, loadState };
