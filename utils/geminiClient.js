// utils/geminiClient.js
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

// AI Studio에서 받은 키 사용 (Vertex AI 안 씀)
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  // apiVersion: 'v1', // 기본이 v1beta지만, 필요하면 명시도 가능
});

// 사용할 모델명. 모델이 막히거나 교체될 때 .env 만 고치면 되도록 한 곳에 모은다.
// (gemini-2.0-flash 는 무료 티어 쿼터가 0이라 429가 난다)
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// 필요하면 여기서 공용 헬퍼도 만들 수 있음
module.exports = { ai, GEMINI_MODEL };