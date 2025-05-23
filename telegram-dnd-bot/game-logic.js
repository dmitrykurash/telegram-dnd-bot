const deepseek = require('./deepseek');
const fs = require('fs');
const path = require('path');

const THEMES_DIR = path.join(__dirname, 'themes');
let activeVotes = {};
let deadPlayers = {};

function getAllThemes() {
  return fs.readdirSync(THEMES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, f)));
      return { id: f.replace('.json', ''), ...data };
    });
}

function startThemeVoting(bot, chatId, db, logger) {
  const themes = getAllThemes();
  const inlineKeyboard = themes.map((t, idx) => [{ text: t.name, callback_data: `vote_theme_${idx}` }]);
  activeVotes[chatId] = { votes: {}, started: Date.now(), themes };
  bot.sendMessage(chatId, 'Выберите тему для нового приключения! Голосуйте кнопками ниже. Если никто не проголосует за 30 минут — я выберу сам.', {
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
  setTimeout(() => finishVoting(bot, chatId, db, logger), 30 * 60 * 1000);
}

function handleVote(bot, query, db, logger) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  if (!activeVotes[chatId]) return;
  const idx = parseInt(query.data.replace('vote_theme_', ''));
  activeVotes[chatId].votes[userId] = idx;
  bot.answerCallbackQuery({ callback_query_id: query.id, text: `Голос учтён: ${activeVotes[chatId].themes[idx].name}` });
}

function finishVoting(bot, chatId, db, logger) {
  const vote = activeVotes[chatId];
  if (!vote) return;
  const counts = {};
  Object.values(vote.votes).forEach(idx => { counts[idx] = (counts[idx] || 0) + 1; });
  let max = 0, leaders = [];
  for (const idx in counts) {
    if (counts[idx] > max) { max = counts[idx]; leaders = [idx]; }
    else if (counts[idx] === max) { leaders.push(idx); }
  }
  let chosenIdx;
  if (leaders.length === 0) {
    chosenIdx = Math.floor(Math.random() * vote.themes.length);
    logger.info('Никто не проголосовал, тема выбрана случайно');
  } else if (leaders.length > 1) {
    chosenIdx = parseInt(leaders[Math.floor(Math.random() * leaders.length)]);
    logger.info('Ничья, тема выбрана случайно из лидеров');
  } else {
    chosenIdx = parseInt(leaders[0]);
  }
  const theme = vote.themes[chosenIdx];
  db.saveState(chatId, { theme: theme.id, history: [], step: 0 });
  bot.sendMessage(chatId, `Тема выбрана: <b>${theme.name}</b>\n\n${theme.intro}`, { parse_mode: 'HTML' });
  startFirstStep(bot, chatId, db, logger);
  delete activeVotes[chatId];
}

async function startFirstStep(bot, chatId, db, logger) {
  const state = db.loadState(chatId);
  if (!state || !state.theme) return;
  const themes = getAllThemes();
  const theme = themes.find(t => t.id === state.theme);
  const prompt = `Ты — ведущий D&D с чёрным юмором. Начни приключение во вселенной: ${theme.name}. Используй сарказм, чёрный юмор, немного пошлости, вовлеки игроков, придумай первую ситуацию, требующую решения. Не забывай: ты язвительный, но не оскорбительный.`;
  const intro = await deepseek.askDeepSeek([
    { role: 'system', content: prompt }
  ]);
  state.history.push({ type: 'situation', text: intro });
  state.step = 1;
  db.saveState(chatId, state);
  bot.sendMessage(chatId, `${intro}`, {
    reply_markup: { inline_keyboard: [[{ text: 'Следующий шаг', callback_data: 'next_step' }]] }
  });
}

function extractMentions(text) {
  const regex = /@([a-zA-Z0-9_]+)/g;
  let match, result = [];
  while ((match = regex.exec(text)) !== null) {
    result.push(match[1]);
  }
  return result;
}

function handlePlayerMessage(bot, msg, db, logger) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = db.loadState(chatId);
  if (!state || !state.theme || !state.step) return;
  if (deadPlayers[chatId] && deadPlayers[chatId][userId] && deadPlayers[chatId][userId] > state.step) {
    bot.sendMessage(chatId, `@${msg.from.username || msg.from.first_name}, ты пока вне игры! Жди воскрешения.`);
    return;
  }
  const mentions = extractMentions(msg.text || '');
  state.history.push({ type: 'action', user: userId, username: msg.from.username, text: msg.text, mentions });
  db.saveState(chatId, state);
  logger.info(`Ответ игрока ${msg.from.username}: ${msg.text}`);
}

function init(bot, db, logger) {
  bot.on('callback_query', (query) => {
    if (query.data.startsWith('vote_theme_')) {
      handleVote(bot, query, db, logger);
    } else if (query.data === 'next_step') {
      nextStep(bot, query.message.chat.id, db, logger);
      bot.answerCallbackQuery({ callback_query_id: query.id, text: 'Следующий шаг!' });
    }
  });
  bot.on('message', (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
      handlePlayerMessage(bot, msg, db, logger);
    }
  });
}

async function nextStep(bot, chatId, db, logger) {
  const state = db.loadState(chatId);
  if (!state || !state.theme) return;
  const themes = getAllThemes();
  const theme = themes.find(t => t.id === state.theme);
  let lastSituation = state.history.filter(e => e.type === 'situation').slice(-1)[0]?.text || '';
  let lastActions = state.history.filter(e => e.type === 'action').map(e => e.text).join('\n');
  const users = [...new Set(state.history.filter(e => e.type === 'action').map(e => e.user))];
  let killUser = null;
  if (users.length > 0 && Math.random() < 0.4) {
    const alive = users.filter(u => !deadPlayers[chatId] || !deadPlayers[chatId][u] || deadPlayers[chatId][u] <= state.step);
    if (alive.length > 0) {
      killUser = alive[Math.floor(Math.random() * alive.length)];
      deadPlayers[chatId] = deadPlayers[chatId] || {};
      deadPlayers[chatId][killUser] = state.step + 2;
    }
  }
  if (deadPlayers[chatId]) {
    for (const [uid, until] of Object.entries(deadPlayers[chatId])) {
      if (until <= state.step) delete deadPlayers[chatId][uid];
    }
  }
  let killMsg = '';
  if (killUser) {
    const killed = state.history.find(e => e.user === killUser)?.username || 'один из игроков';
    killMsg = `\nP.S. ${killed} временно выбывает из игры! Но не переживай, тебя скоро воскресит чёрный юмор.`;
  }
  const prompt = `Ты — ведущий D&D с чёрным юмором. Продолжи приключение во вселенной: ${theme.name}. Последняя ситуация: ${lastSituation}\nОтветы игроков: ${lastActions}${killMsg}\nСделай новый поворот, добавь юмора, язвительности, можешь "убить" кого-то на 1-2 хода, но потом вернуть. Не забывай вовлекать всех участников.`;
  const next = await deepseek.askDeepSeek([
    { role: 'system', content: prompt }
  ]);
  state.history.push({ type: 'situation', text: next });
  state.step++;
  db.saveState(chatId, state);
  bot.sendMessage(chatId, `${next}`, {
    reply_markup: { inline_keyboard: [[{ text: 'Следующий шаг', callback_data: 'next_step' }]] }
  });
}

module.exports = { init, startThemeVoting };
