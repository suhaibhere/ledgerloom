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
    console.warn(`Gemini API request failed with HTTP ${response.status} for model ${model}.`);
    if (response.status === 400) throw Object.assign(new Error('Gemini rejected this model or request. Try Gemini Flash-Lite, or check that the selected model is available to your API key.'), { status: 502 });
    if (response.status === 401) throw Object.assign(new Error('Gemini rejected the API key. Check GEMINI_API_KEY in Render and make sure it is current.'), { status: 502 });
    if (response.status === 403) throw Object.assign(new Error('Gemini denied this request. Check the API key restrictions, project access, and model availability in Google AI Studio.'), { status: 502 });
    if (response.status === 404) throw Object.assign(new Error('The selected Gemini model is not available for this API key. Choose another model.'), { status: 502 });
    if (response.status === 429) throw Object.assign(new Error('Gemini rate limit or quota reached. Wait and try again, or check your Google AI Studio usage limits.'), { status: 429 });
    if (response.status >= 500) throw Object.assign(new Error('Google Gemini is having a temporary service problem. Please try again shortly.'), { status: 502 });
    throw Object.assign(new Error(`Gemini request failed (HTTP ${response.status}). Check the selected model and API key settings.`), { status: 502 });
  }
  let data;
  try { data = await response.json(); } catch { throw Object.assign(new Error('Gemini returned an unreadable response. Please try again.'), { status: 502 }); }
  const answer = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
  if (!answer) {
    const reason = String(data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'unknown').replace(/[^A-Z_]/g, '').slice(0, 40);
    console.warn(`Gemini returned no text candidate (reason: ${reason}).`);
    throw Object.assign(new Error('Gemini could not produce a reply for that message. Try rephrasing it or sending a shorter message.'), { status: 502 });
  }
  return { answer, provider: 'gemini' };
}

module.exports = { configured, generateChat, MODEL_CHOICES };
