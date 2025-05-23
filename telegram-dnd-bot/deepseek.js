const axios = require('axios');
const winston = require('winston');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const API_URL = 'https://api.deepseek.com/v1/chat/completions';

async function askDeepSeek(messages) {
  try {
    const response = await axios.post(API_URL, {
      model: 'deepseek-chat',
      messages
    }, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data.choices[0].message.content;
  } catch (error) {
    winston.error('DeepSeek API error:', error);
    return 'Ошибка связи с ИИ. Даже боги иногда молчат...';
  }
}

module.exports = { askDeepSeek };
