// Manejo de fuentes de entrada: páginas web, YouTube, TikTok/Instagram (vía yt-dlp)
const axios = require('axios');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
// yt-dlp vía youtube-dl-exec (binario en node_modules, siempre en ruta).
// Su yt-dlp es un zipapp de python: python3 se instala por apt (ver nixpacks.toml).
const ytdlpModule = require('youtube-dl-exec');
const FFMPEG_BIN = require('ffmpeg-static');

const TEMP_DIR = path.join(__dirname, 'temp-videos');

// Invocación DIRECTA de yt-dlp con execFile (sin shell) — no usar `ytdlpModule(url, flags)`
// para nada nuevo. Bug real descubierto probando la Fase 4 (2026-08-08): si la ruta del
// proyecto tiene un espacio (como esta máquina, "D:\claude pro apps\..."), youtube-dl-exec
// activa `shell:true` para poder citar el binario — pero en ese modo Node NO escapa el resto de
// los argumentos (DEP0190), así que cualquier flag con espacios (p. ej. `--output` apuntando a
// esta misma carpeta) se corta en el primer espacio. yt-dlp recibía literalmente
// `--output D:\claude` y el resto de la ruta como "argumentos" sueltos, y fallaba con
// "Fixed output name but more than one file to download: D:\claude".
// No pasaba en producción (Railway no tiene espacios en su path) — por eso nadie lo vio: rompía
// SOLO la lectura de video/audio local en Windows, en silencio. `execFile` sin shell no tiene
// este problema: Windows arma el proceso con cada argumento por separado, con o sin espacios.
const YTDLP_BIN = ytdlpModule.constants.YOUTUBE_DL_PATH;

function flagsAArgs(flags) {
  const out = [];
  for (const [clave, valor] of Object.entries(flags)) {
    if (valor === false || valor == null) continue;
    const flag = '--' + clave.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    if (valor === true) out.push(flag);
    else out.push(flag, String(valor));
  }
  return out;
}

function ytdlpUnaVez(bin, url, flags, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [url, ...flagsAArgs(flags)];
    execFile(bin, args, { maxBuffer: 100 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr, stdout }));
      resolve({ stdout, stderr });
    });
  });
}

// yt-dlp puede colgarse SIN dar ningún error cuando la red social del otro lado no responde
// (el anti-bot se queda esperando en vez de rechazar) — un execFile sin timeout se queda
// esperando indefinidamente hasta que algo externo (el gateway de Railway) corta la conexión a
// los ~5 minutos con un 502 sin ninguna pista de la causa real. Portado del repo principal
// (farandula-video-generator, 2026-08-13): 3 intentos de 40s cada uno con una pausa de 2s entre
// intentos, así "colgado 5 min sin pista" se convierte en "falla clara en menos de 2 min".
const YTDLP_TIMEOUT_MS = 40000;
const YTDLP_INTENTOS = 3;

// Bug abierto de yt-dlp con TikTok (yt-dlp/yt-dlp#17403 y #17407, agosto 2026): el "challenge"
// anti-bot que TikTok exige resolver cambió y ninguna versión reciente de yt-dlp sabe resolverlo
// todavía — falla con "Unexpected response from webpage request". La única versión que sigue
// funcionando es la anterior al cambio (2026.03.17). En vez de downgradear el binario principal
// (más nuevo = mejor para YouTube y el resto), se descarga esa versión vieja UNA sola vez
// (on-demand, cacheada en TEMP_DIR) y se usa solo como último recurso, solo contra tiktok.com,
// solo cuando el normal falla con la firma exacta de este bug. El día que yt-dlp lo arregle río
// arriba, el binario normal vuelve a ganar solo, sin tocar código.
const YTDLP_LEGACY_VERSION = '2026.03.17';
const YTDLP_LEGACY_PATH = path.join(TEMP_DIR, process.platform === 'win32' ? 'yt-dlp-legacy.exe' : 'yt-dlp-legacy');

async function asegurarYtdlpLegacy() {
  if (fs.existsSync(YTDLP_LEGACY_PATH)) return YTDLP_LEGACY_PATH;
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const nombreAsset = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_LEGACY_VERSION}/${nombreAsset}`;
  console.log(`  ⬇️ Descargando yt-dlp ${YTDLP_LEGACY_VERSION} (fallback del bug de TikTok, una sola vez)...`);
  const respuesta = await axios.get(url, { responseType: 'stream', timeout: 30000, maxRedirects: 5 });
  await new Promise((resolve, reject) => {
    const destino = fs.createWriteStream(YTDLP_LEGACY_PATH);
    respuesta.data.pipe(destino);
    destino.on('finish', resolve);
    destino.on('error', reject);
  });
  if (process.platform !== 'win32') fs.chmodSync(YTDLP_LEGACY_PATH, 0o755);
  return YTDLP_LEGACY_PATH;
}

function esErrorChallengeTiktok(e) {
  return /Unexpected response from webpage request/i.test(`${e?.stderr || ''} ${e?.message || ''}`);
}

async function ytdlp(url, flags = {}) {
  let ultimoError;
  for (let intento = 1; intento <= YTDLP_INTENTOS; intento++) {
    try {
      return await ytdlpUnaVez(YTDLP_BIN, url, flags, YTDLP_TIMEOUT_MS);
    } catch (e) {
      ultimoError = e;
      const esTimeout = e.killed === true || e.signal === 'SIGTERM';
      console.warn(`  ⚠️ yt-dlp intento ${intento}/${YTDLP_INTENTOS} falló${esTimeout ? ' (sin respuesta, timeout)' : ''}: ${String(e.message).split('\n')[0]}`);
      if (intento < YTDLP_INTENTOS) await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (/tiktok\.com/i.test(url) && esErrorChallengeTiktok(ultimoError)) {
    try {
      const binLegacy = await asegurarYtdlpLegacy();
      console.warn(`  🩹 yt-dlp normal no puede con TikTok ahora mismo (bug conocido, yt-dlp/yt-dlp#17403) — reintentando con ${YTDLP_LEGACY_VERSION}...`);
      return await ytdlpUnaVez(binLegacy, url, flags, YTDLP_TIMEOUT_MS);
    } catch (e2) {
      console.warn(`  ⚠️ yt-dlp legacy también falló: ${String(e2.message).split('\n')[0]}`);
    }
  }

  throw ultimoError;
}

function esYoutube(url) {
  return /(?:youtube\.com|youtu\.be)\//i.test(url);
}

// Redes cuyo video hay que descargar con yt-dlp (Gemini no puede leerlas directo)
function esVideoSocial(url) {
  return /(?:tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com)\//i.test(url);
}

function esUrl(texto) {
  return /^https?:\/\//i.test(texto.trim());
}

// Extraer el texto legible de una página web (noticia)
async function extraerTextoWeb(url) {
  const res = await axios.get(url, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    maxContentLength: 10 * 1024 * 1024,
  });
  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  const texto = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (texto.length < 200) {
    throw new Error('La página no devolvió texto suficiente (puede requerir JavaScript). Pega el texto de la noticia directamente.');
  }
  return texto.slice(0, 30000);
}

// Transcripción de YouTube vía subtítulos (manuales o autogenerados) — la fuente MÁS barata
// posible: es texto puro, cero tokens de audio/video en Gemini. Se intenta SIEMPRE primero para
// YouTube antes de tocar audio o video (pedido explícito del usuario, Fase 4 del plan maestro).
// Devuelve null si el video no tiene subtítulos disponibles (no es un error: es una señal de
// "cae al siguiente escalón", igual que el resto de la cadena de fallback del proyecto).
function limpiarVtt(vtt) {
  return vtt
    .split('\n')
    .filter(linea =>
      linea.trim() &&
      !linea.startsWith('WEBVTT') &&
      !linea.startsWith('Kind:') &&
      !linea.startsWith('Language:') &&
      !/^\d+$/.test(linea.trim()) &&                          // números de cue sueltos
      !/-->/.test(linea) &&                                    // líneas de timestamp
      !/^NOTE\b/.test(linea)
    )
    .map(linea => linea.replace(/<[^>]+>/g, ''))               // tags <c>, <00:00:01.234> inline
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function obtenerTranscripcionYoutube(url) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const base = `sub_${Date.now()}`;
  const plantilla = path.join(TEMP_DIR, `${base}.%(ext)s`);

  try {
    await ytdlp(url, {
      skipDownload: true,
      writeSub: true,
      writeAutoSub: true,
      subLang: 'es,es-419,es-ES,en,en-US',
      subFormat: 'vtt',
      output: plantilla,
    });
  } catch (e) {
    // yt-dlp puede salir con error si NO hay subtítulos en ningún idioma pedido — no es fatal,
    // es la señal de caer al siguiente escalón (audio).
    return null;
  }

  const archivo = fs.readdirSync(TEMP_DIR).find(f => f.startsWith(base) && f.endsWith('.vtt'));
  if (!archivo) return null;

  const ruta = path.join(TEMP_DIR, archivo);
  try {
    const texto = limpiarVtt(fs.readFileSync(ruta, 'utf8'));
    return texto.length > 100 ? texto : null; // demasiado corto: no es fiable
  } finally {
    try { fs.unlinkSync(ruta); } catch {}
  }
}

// Descargar el audio de un video social con yt-dlp (TikTok, Instagram, etc.)
async function descargarAudio(url) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const base = `fuente_${Date.now()}`;
  const plantilla = path.join(TEMP_DIR, `${base}.%(ext)s`);
  const esperado = path.join(TEMP_DIR, `${base}.mp3`);

  await ytdlp(url, {
    extractAudio: true,
    audioFormat: 'mp3',
    noPlaylist: true,
    forceOverwrites: true,
    output: plantilla,
    ffmpegLocation: FFMPEG_BIN,
  });

  if (!fs.existsSync(esperado)) {
    throw new Error('yt-dlp terminó pero no se encontró el MP3 descargado');
  }
  return esperado;
}

// Descargar el VIDEO completo (imagen + audio) de una red social para que Gemini lo "vea".
// A diferencia de descargarAudio, conserva lo visual (gestos, caras, texto en pantalla).
async function descargarVideo(url) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const base = `fuente_${Date.now()}`;
  const plantilla = path.join(TEMP_DIR, `${base}.%(ext)s`);

  await ytdlp(url, {
    output: plantilla,
    // Preferir un MP4 ya combinado; si no, el mejor disponible (yt-dlp mezcla con ffmpeg)
    format: 'best[ext=mp4]/mp4/best',
    mergeOutputFormat: 'mp4',
    noPlaylist: true,
    forceOverwrites: true,
    ffmpegLocation: FFMPEG_BIN,
  });

  // yt-dlp elige la extensión final; localizar el archivo real que quedó
  const archivo = fs.readdirSync(TEMP_DIR).find(f => f.startsWith(base));
  if (!archivo) {
    throw new Error('yt-dlp terminó pero no se encontró el video descargado');
  }
  return path.join(TEMP_DIR, archivo);
}

module.exports = { esYoutube, esVideoSocial, esUrl, extraerTextoWeb, obtenerTranscripcionYoutube, descargarAudio, descargarVideo, TEMP_DIR };
