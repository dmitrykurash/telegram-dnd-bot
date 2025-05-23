const sqlite3 = require('sqlite3').verbose();
const path = require('path');
let db;

function init() {
  db = new sqlite3.Database(path.join(__dirname, 'dnd-bot.db'));
  db.run(`CREATE TABLE IF NOT EXISTS game_state (
    chat_id TEXT PRIMARY KEY,
    state TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

function saveState(chatId, state) {
  db.run(
    'INSERT OR REPLACE INTO game_state (chat_id, state) VALUES (?, ?)',
    [chatId, JSON.stringify(state)]
  );
}

function loadState(chatId) {
  return new Promise((resolve) => {
    db.get('SELECT state FROM game_state WHERE chat_id = ?', [chatId], (err, row) => {
      if (row) resolve(JSON.parse(row.state));
      else resolve(null);
    });
  });
}

module.exports = { init, saveState, loadState };
