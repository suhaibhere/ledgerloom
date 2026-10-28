'use strict';

const MODEL_CHOICES = Object.freeze({
  lite: 'gemini-3.5-flash-lite',
  flash: 'gemini-3.8-flash'
});
const DEFAULT_MODEL = MODEL_CHOICES.lite;

function configured() { return Boolean(String(process.env.GEMINI_API_KEY || '').trim()); }

async function generateChat({ message, history = [], spendingSummary = null, modelChoice }) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error("AI chat isn't configured yet. The site owner needs to add GEMINI_API_KEY in Render."), { status: 503 });

  const configuredModel = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const model = MODEL_CHOICES[modelChoice] || (Object.values(MODEL_CHOICES).includes(configuredModel) ? configuredModel : null);
  if (!model) throw Object.assign(new Error('Choose a supported AI model.'), { status: 400 });
  const instructions = [
    'You are LedgerLoom, a friendly, general-purpose chatbot. Answer ordinary questions naturally across topics; do not force every conversation toward personal finance.',
    'Be clear, useful, and conversational. If you do not know something, say so. Do not claim to browse the web or access live information.',
    'When a spending summary is supplied, use it only as context for questions about that user’s finances. It contains aggregates, not a complete bank balance. Never invent financial figures or pretend to see individual transactions.',
    'For financial questions, offer general educational information and practical budgeting ideas, not investment, tax, legal, or professional financial advice. Do not make guarantees.'
  ].join(' ');
  const context = spendingSummary ? `\n\nThe user explicitly opted to include this aggregate spending summary for this message only:\n${JSON.stringify(spendingSummary)}` : '';
  const contents = history.slice(-10).map(item => ({ role: item.role, parts: [{ text: item.text }] }));
  contents.push({ role: 'user', parts: [{ text: `${message}${context}` }] });

  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: instructions }] }, contents, generationConfig: { maxOutputTokens: 700 } }),
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw Object.assign(new Error('Gemini could not be reached right now. Please try again.'), { status: 502 });
  }
  if (!response.ok) {
    if (response.status === 429) throw Object.assign(new Error('Gemini is temporarily busy or the free-tier limit was reached. Try again later.'), { status: 429 });
    throw Object.assign(new Error('Gemini could not answer right now. Check the server configuration and try again.'), { status: 502 });
  }
  let data;
  try { data = await response.json(); } catch { throw Object.assign(new Error('Gemini returned an unreadable response. Please try again.'), { status: 502 }); }
  const answer = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
  if (!answer) throw Object.assign(new Error('Gemini did not return an answer. Please try rephrasing.'), { status: 502 });
  return { answer, provider: 'gemini' };
}

module.exports = { configured, generateChat, MODEL_CHOICES };
