const cron = require('node-cron');
const moment = require('moment-timezone');

function init(bot, db, logger) {
  // Утреннее сообщение
  cron.schedule('0 10 * * *', () => {
    // ... отправка утреннего сообщения
  }, { timezone: process.env.TIMEZONE });

  // Вечернее сообщение
  cron.schedule('0 23 * * *', () => {
    // ... отправка вечернего сообщения
  }, { timezone: process.env.TIMEZONE });
}

module.exports = { init };
