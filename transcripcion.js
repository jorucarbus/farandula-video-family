// Fuente de tiempos para family: el repo principal saca el timing por palabra de la alineación
// de ElevenLabs (viene gratis con el audio, ver tiempos.js de ese repo). Acá el audio lo sube el
// usuario ya grabado — no hay alineación de ningún proveedor de TTS. Este módulo la consigue por
// otro camino: transcribir el MP3 con Whisper (OpenAI), que devuelve timestamps por palabra.
//
// Puerta abierta que el propio tiempos.js del repo principal dejó anotada (2026-08-08): "sirve
// además para farandula-video-family, donde el audio lo sube el usuario y no hay timestamps de
// ningún proveedor" — este módulo es esa pieza.
const fs = require('fs');
const path = require('path');

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';

// Nunca lanza: si falta la key, si Whisper falla, o si no devuelve palabras, devuelve null —
// quien llama cae al reparto por % de caracteres (mismo criterio de robustez que el repo
// principal usa cuando ElevenLabs no da alineación).
async function transcribirConTimestamps(audioPath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('  ⚠️ Falta OPENAI_API_KEY: subtítulos van a salir sin timing real (reparto por % de caracteres)');
    return null;
  }
  try {
    const buffer = fs.readFileSync(audioPath);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), path.basename(audioPath));
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    // Español fijo: el catálogo de voces/audios de este proyecto es siempre en español, forzarlo
    // evita que Whisper gaste tiempo detectando idioma y reduce falsos positivos de mezcla de
    // idioma en nombres propios.
    form.append('language', 'es');
    form.append('timestamp_granularities[]', 'word');

    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const detalle = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${detalle.slice(0, 300)}`);
    }
    const data = await res.json();
    if (!Array.isArray(data.words) || data.words.length === 0) {
      console.warn('  ⚠️ Whisper no devolvió timestamps por palabra, subtítulos sin timing real');
      return null;
    }
    console.log(`  🎙️ Whisper transcribió ${data.words.length} palabras con timing real`);
    return data.words.map(w => ({ texto: w.word, inicio: w.start, fin: w.end }));
  } catch (e) {
    console.warn(`  ⚠️ Transcripción con Whisper falló (${e.message}), subtítulos sin timing real`);
    return null;
  }
}

module.exports = { transcribirConTimestamps };
