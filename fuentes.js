// Manejo de fuentes de entrada: páginas web, YouTube, TikTok/Instagram (vía yt-dlp)
const axios = require('axios');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
// yt-dlp vía youtube-dl-exec (binario en node_modules, siempre en ruta).
// Su yt-dlp es un zipapp de python: python3 se instala por apt (ver nixpacks.toml).
const ytdlp = require('youtube-dl-exec');
const FFMPEG_BIN = require('ffmpeg-static');

const TEMP_DIR = path.join(__dirname, 'temp-videos');

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

module.exports = { esYoutube, esVideoSocial, esUrl, extraerTextoWeb, descargarAudio, descargarVideo, TEMP_DIR };
