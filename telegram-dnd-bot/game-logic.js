const deepseek = require('./deepseek');
const { ASLAN_SYSTEM_PROMPT } = require('./deepseek');
const moment = require('moment-timezone');

// Новая структура состояния для синдиката
let gameState = {};

function getDefaultState() {
  return {
    day: 1,
    money: 10000,
    reputation: 5,
    problems: [],
    allies: {},
    enemies: {},
    history: [],
    active_situation: {
      message_id: null,
      text: '',
      responses: [],
      deadline: null
    },
    personal_dialogs: {} // user_id: [{from, text, timestamp}]
  };
}

function saveState(chatId, state, db) {
  gameState[chatId] = state;
  db.saveState(chatId, state);
}

async function loadState(chatId, db) {
  if (gameState[chatId]) return gameState[chatId];
  const state = await db.loadState(chatId);
  if (state) gameState[chatId] = state;
  return state || getDefaultState();
}

// Создание новой ситуации (утро/вечер)
async function createSituation(bot, chatId, db, logger, timeOfDay) {
  const state = await loadState(chatId, db);
  // Контекст для генерации
  const context = {
    day: state.day,
    recent_events: state.history.slice(-5),
    ongoing_problems: state.problems,
    relationships: {
      allies: state.allies,
      enemies: state.enemies
    }
  };
  const prompt = `Создай новую ситуацию для дня ${state.day} (${timeOfDay}).\nУчти недавние события: ${JSON.stringify(context.recent_events)}\nТекущие проблемы: ${JSON.stringify(context.ongoing_problems)}\nСитуация должна логично вытекать из предыдущих решений. НЕ давай варианты ответов, только опиши ситуацию.`;
  const situationText = await deepseek.askDeepSeek([
    { role: 'user', content: prompt }
  ]);
  const msg = await bot.sendMessage(chatId, situationText);
  state.active_situation = {
    message_id: msg.message_id,
    text: situationText,
    responses: [],
    deadline: moment().add(2, 'hours').toISOString()
  };
  saveState(chatId, state, db);
}

// Сбор ответов игроков через реплай
async function handleMessage(bot, message, db, logger) {
  if (message.reply_to_message && message.reply_to_message.from && message.reply_to_message.from.id === (await bot.getMe()).id) {
    const chatId = message.chat.id;
    const state = await loadState(chatId, db);
    if (!state.active_situation || state.active_situation.message_id !== message.reply_to_message.message_id) return;
    // Сохраняем ответ
    state.active_situation.responses.push({
      player_name: message.from.first_name,
      user_id: message.from.id,
      response: message.text
    });
    saveState(chatId, state, db);
    bot.replyTo(message, `Э, ${message.from.first_name}, понял тэбя, брат! Интэрэсная идея... 🤔`);
  }
}

// Новый обработчик персональных обращений к Аслану
async function handlePersonalMention(bot, message, db, logger) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const state = await loadState(chatId, db);
  state.personal_dialogs[userId] = state.personal_dialogs[userId] || [];
  // Добавляем сообщение пользователя в историю диалога
  state.personal_dialogs[userId].push({
    from: 'user',
    text: message.text,
    timestamp: Date.now()
  });
  // Формируем контекст последних 5 сообщений диалога
  const dialogHistory = state.personal_dialogs[userId].slice(-5).map(d => (d.from === 'user' ? `Пользователь: ${d.text}` : `Аслан: ${d.text}`)).join('\n');
  // Генерируем ответ
  const prompt = `Ты — Аслан "Схема". Пользователь обратился к тебе лично. Вот последние сообщения диалога:\n${dialogHistory}\n\nОтветь коротко, с юмором, в своём стиле. Если вопрос касается денег, схем, синдиката или сюжета — обязательно запомни это для будущих событий.`;
  const reply = await deepseek.askDeepSeek([
    { role: 'user', content: prompt }
  ]);
  // Добавляем ответ Аслана в историю диалога
  state.personal_dialogs[userId].push({
    from: 'aslan',
    text: reply,
    timestamp: Date.now()
  });
  saveState(chatId, state, db);
  await bot.sendMessage(chatId, `@${message.from.username || message.from.first_name}, ${reply}`);
  // Если вопрос явно связан с сюжетом — добавляем в историю синдиката
  if (/деньг|синдикат|схем|проблем|сюжет|истори|дело|братва|враг|союзник|план/i.test(message.text)) {
    state.history.push({
      day: state.day,
      event: `[Личный диалог с @${message.from.username || message.from.first_name}]: ${message.text} => ${reply}`,
      player_decisions: [],
      consequences: null,
      timestamp: Date.now()
    });
    saveState(chatId, state, db);
  }
}

// Обработка ситуации после сбора ответов
async function processSituationResults(bot, chatId, db, logger) {
  const state = await loadState(chatId, db);
  const responses = state.active_situation.responses;
  const context = {
    history: state.history.slice(-10),
    current_state: {
      money: state.money,
      reputation: state.reputation,
      problems: state.problems
    },
    player_responses: responses,
    character: 'Аслан Схема'
  };
  const prompt = `Ты Аслан Схема. Вот текущая ситуация синдиката:\n${JSON.stringify(context)}\n\nИгроки предложили следующее:\n${responses.map(r => r.player_name + ': ' + r.response).join('\n')}\n\nСоздай развитие событий, учитывая ВСЕ предложения игроков. Помни предыдущие события и решения. Ответь с акцентом и юмором.`;
  const resultText = await deepseek.askDeepSeek([
    { role: 'user', content: prompt }
  ]);
  // Обновляем историю
  state.history.push({
    day: state.day,
    event: resultText,
    player_decisions: responses,
    consequences: null,
    timestamp: moment().toISOString()
  });
  // Сброс активной ситуации, переход к следующему дню
  state.day += 1;
  state.active_situation = {
    message_id: null,
    text: '',
    responses: [],
    deadline: null
  };
  saveState(chatId, state, db);
  await bot.sendMessage(chatId, resultText);
}

// Команды истории и отношений
async function showHistory(bot, message, db) {
  const state = await loadState(message.chat.id, db);
  const history = state.history.slice(-10).map(e => `День ${e.day}: ${e.event}`).join('\n');
  await bot.sendMessage(message.chat.id, history || 'История пока пуста, брат.');
}

async function showRelationships(bot, message, db) {
  const state = await loadState(message.chat.id, db);
  const allies = Object.keys(state.allies).length ? Object.keys(state.allies).join(', ') : 'нет союзников';
  const enemies = Object.keys(state.enemies).length ? Object.keys(state.enemies).join(', ') : 'нет врагов';
  await bot.sendMessage(message.chat.id, `Союзники: ${allies}\nВраги: ${enemies}`);
}

module.exports = {
  getDefaultState,
  createSituation,
  handleMessage,
  handlePersonalMention,
  processSituationResults,
  showHistory,
  showRelationships,
  gameState
};
