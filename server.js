require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const archiver = require('archiver');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const ffprobeStatic = require('ffprobe-static');

const gemini = require('./gemini');
const video = require('./video');
const seleccion = require('./seleccion');
const fuentes = require('./fuentes');
const drive = require('./drive');
const auth = require('./auth');
const db = require('./db');
const cleanupCron = require('./cleanupCron');
const portada = require('./portada');
const subtitulos = require('./subtitulos');
const transcripcion = require('./transcripcion');
const tiempos = require('./tiempos');

const app = express();
const PORT = process.env.PORT || 3000;

const TEMP_DIR = path.join(__dirname, 'temp-videos');
const INSUMOS_DIR = path.join(__dirname, 'temp-insumos');

[TEMP_DIR, INSUMOS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public', {
  setHeaders: (res, ruta) => {
    if (/\.(html|css|js)$/i.test(ruta)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Formatos de audio aceptados para la locucion que sube el usuario. Antes solo MP3, pero la
// gente graba con lo que tenga a mano (la grabadora de Windows da .m4a, Audacity exporta .wav,
// un celular Android puede dar .ogg) y no tiene por que convertir a mano. Lo que NO sea mp3 se
// transcodifica a mp3 al recibirlo (ver mas abajo): el resto del pipeline ya asume un .mp3 real
// -- el archivo se guarda como `audio_<token>.mp3` pase lo que pase, asi que aceptar otro
// formato sin convertirlo dejaba un archivo con extension mentirosa.
const AUDIO_MIMES_OK = /^audio\/(mpeg|mp3|wav|x-wav|wave|x-pn-wav|mp4|m4a|x-m4a|aac|ogg|opus|webm|flac|x-flac)$/;

const audioUpload = multer({
  dest: TEMP_DIR,
  fileFilter: (req, file, cb) => {
    if (!AUDIO_MIMES_OK.test(file.mimetype)) {
      return cb(new Error(`Formato de audio no soportado (${file.mimetype}). Acepta MP3, WAV, M4A, AAC, OGG o FLAC.`));
    }
    cb(null, true);
  },
  // 150MB: un WAV sin comprimir pesa ~10x lo que el mismo audio en MP3 (un minuto de WAV
  // 44.1kHz estereo son ~10MB), asi que el tope viejo de 50MB dejaba fuera locuciones normales.
  limits: { fileSize: 150 * 1024 * 1024 },
});

// ==================== HEALTH ====================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ==================== AUTH ====================
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    res.json(await auth.signup(email, password));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    res.json(await auth.login(email, password));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/me', auth.requireAuth, async (req, res) => {
  try {
    res.json({ user: await db.getUserById(req.user.userId) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Todo lo demás bajo /api requiere sesión — EXCEPTO las rutas que sirven un archivo para un
// <audio>/<video>/<img src="...">: esos tags no pueden mandar el header Authorization, así que
// se protegen con el mismo criterio que ya usa farandula-video-generator (repo hermano): un
// token/jobId aleatorio de `crypto.randomBytes` (16 hex = 64 bits) hace de "contraseña" en la URL
// en vez del Bearer. No es un hueco nuevo: `/api/download-video/:jobId` y `/api/audio/:token` YA
// dependían de esto para funcionar en el navegador — antes de este cambio el middleware de abajo
// los bloqueaba con 401 en silencio (bug preexistente: <audio src="..."> nunca sonaba porque el
// fetch del navegador no llevaba el Bearer). `/api/fuente/:clave` es una excepción aparte: sirve
// un .ttf público del catálogo, sin datos de ningún usuario.
const RUTAS_PUBLICAS_MEDIA = [/^\/audio\//, /^\/download-video\//, /^\/fuente\//, /^\/cartel\//, /^\/video-preview\//, /^\/portada-file\//];
app.use('/api', (req, res, next) => {
  if (['/signup', '/login'].includes(req.path)) return next();
  if (RUTAS_PUBLICAS_MEDIA.some(re => re.test(req.path))) return next();
  return auth.requireAuth(req, res, next);
});

// ==================== ESTADO EN MEMORIA ====================
const jobs = new Map();           // jobId -> job (cache caliente; la verdad durable vive en Postgres)
const audiosPendientes = new Map(); // audioToken -> {path, duracion}

// El Map de arriba se vacia en CADA reinicio del contenedor (deploy, crash, sleep de Railway),
// y eso le daba al usuario "Job no encontrado" a mitad del flujo, obligandolo a empezar de cero
// (reportado 2026-08-21). Estas dos funciones lo respaldan en Postgres -- que esta app ya tiene
// para el login/historial, asi que no hace falta infraestructura nueva.
//
// OJO con lo que NO recupera: los ARCHIVOS (la locucion subida, el video renderizado, el cartel)
// viven en el disco efimero y se pierden igual. Tras un reinicio, fuente/guion/fragmentos/
// asignaciones vuelven intactos, pero hay que volver a subir el audio.
async function obtenerJob(jobId) {
  if (!jobId) return null;
  const enMemoria = jobs.get(jobId);
  if (enMemoria) return enMemoria;
  const guardado = await db.cargarJobState(jobId);
  if (!guardado) return null;
  jobs.set(jobId, guardado);
  console.log(`  ♻️  Job ${jobId} recuperado desde la base (el contenedor se reinicio)`);
  return guardado;
}

// Guarda el estado del job. Fire-and-forget: si Postgres falla, el flujo sigue igual.
function persistirJob(job) {
  if (!job) return;
  jobs.set(job.jobId, job);
  db.guardarJobState(job).catch(() => {});
}

// Guarda en disco el PNG del cartel que mandó el navegador (data URL "data:image/png;base64,...").
// Portado de farandula-video-generator: el cartel se dibuja UNA vez en el navegador (canvas) y
// este archivo es la ÚNICA versión — se superpone tal cual en el frame 0 del video y, después, en
// el JPG de portada. Devuelve null si no vino cartel (el usuario no quiso) o si el dato no tiene
// la forma esperada; el video sale igual, sin cartel.
function guardarCartelPNG(dataUrl, jobId) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) {
    if (dataUrl.trim()) console.warn(`⚠️ [${jobId}] El cartel recibido no es un PNG en data URL, el video sale sin cartel`);
    return null;
  }
  try {
    const ruta = path.join(video.TEMP_DIR, `cartel_${jobId}.png`);
    fs.writeFileSync(ruta, Buffer.from(m[1], 'base64'));
    return ruta;
  } catch (e) {
    console.warn(`⚠️ [${jobId}] No se pudo guardar el cartel, el video sale sin él: ${e.message}`);
    return null;
  }
}

// Catálogo de tipografías — COMPARTIDO entre subtítulos y cartel de portada (mismo criterio que
// el repo principal: un solo catálogo en subtitulos.js, la UI lo pide en vez de mantener una
// lista duplicada).
app.get('/api/fuentes-subtitulos', (req, res) => {
  const fuentesLista = Object.entries(subtitulos.FUENTES).map(([clave, f]) => ({ clave, familia: f.familia, factorAncho: f.factorAncho }));
  res.json({ fuentes: fuentesLista, default: subtitulos.FUENTE_DEFAULT });
});

// Archivo .ttf de una tipografía del catálogo — el navegador lo carga con la API FontFace para
// dibujar el cartel con la MISMA tipografía que después se hornea en el video (ver
// public/app.js: asegurarFuenteCargada). Público: FontFace.load() no puede mandar headers.
app.get('/api/fuente/:clave', async (req, res) => {
  const fuente = subtitulos.FUENTES[req.params.clave];
  if (!fuente) return res.status(404).json({ error: 'Tipografía desconocida' });
  try {
    const dir = await subtitulos.obtenerCarpetaFuentes(req.params.clave);
    const ruta = dir && path.join(dir, fuente.archivo);
    if (!ruta || !fs.existsSync(ruta)) {
      return res.status(503).json({ error: `No se pudo obtener la tipografía "${fuente.familia}"` });
    }
    res.type('font/ttf');
    res.sendFile(ruta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PNG del cartel que el navegador dibujó en el Paso 6 y el server quemó en el frame 0 — se sirve
// para que la UI lo muestre encima del fotograma elegido en el paso "elegir portada".
app.get('/api/cartel/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.cartelPath || !fs.existsSync(job.cartelPath)) {
    return res.status(404).json({ error: 'Cartel no disponible' });
  }
  res.sendFile(job.cartelPath);
});

// Video ya generado, para reproducirlo/scrubearlo en la UI (a diferencia de /download-video, que
// fuerza la descarga con Content-Disposition: attachment).
app.get('/api/video-preview/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.videoPath || !fs.existsSync(job.videoPath)) {
    return res.status(404).json({ error: 'Video no disponible' });
  }
  res.sendFile(job.videoPath);
});

// Portada (miniatura): fotograma elegido por el usuario + EL MISMO PNG de cartel superpuesto —
// el cartel se diseña UNA sola vez en el Paso 6 y se reusa tal cual acá (nunca se re-edita), para
// que el JPG y el frame 0 del video sean idénticos. Se genera a partir de job.videoPath (el video
// final ya guardado, no un preview aparte — family no tiene el problema de "el preview se limpió"
// del repo principal porque el video final se queda en disco mientras el job exista).
app.post('/api/portada', async (req, res) => {
  const { jobId, timestamp } = req.body;
  const job = jobs.get(jobId);
  if (!job?.videoPath || !fs.existsSync(job.videoPath)) {
    return res.status(404).json({ error: 'El video ya no está disponible, genéralo de nuevo' });
  }
  if (!job.cartelPath || !fs.existsSync(job.cartelPath)) {
    return res.status(400).json({ error: 'No se diseñó un cartel en el Paso 6, no hay nada que superponer' });
  }
  try {
    const token = crypto.randomBytes(16).toString('hex');
    const ruta = await portada.generarPortada(job.videoPath, Number(timestamp) || 0, job.cartelPath, token);
    job.portadaPath = ruta;
    res.json({ portadaUrl: `/api/portada-file/${jobId}` });
  } catch (e) {
    console.error('Error generando portada:', e.message);
    res.status(500).json({ error: `No se pudo generar la portada: ${e.message}` });
  }
});

app.get('/api/portada-file/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.portadaPath || !fs.existsSync(job.portadaPath)) {
    return res.status(404).json({ error: 'Portada no disponible' });
  }
  res.sendFile(job.portadaPath);
});

function crearJobDir(jobId) {
  const dir = path.join(INSUMOS_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Decide CÓMO leer una fuente y devuelve su acta ya extraída (Fase 4 del plan maestro:
// multifuente + solo audio). El orden de intentos SIEMPRE prioriza lo más barato — de los
// videos no importa nada visual, así que "ver" el video queda como último recurso si todo lo
// demás falla, nunca como default. Cada escalón que falla cae al siguiente en vez de abortar.
async function extraerActaDeFuente(type, content) {
  if (type !== 'link' && type !== 'video') {
    const acta = await gemini.extraerActa(type, content);
    return { acta, tipoReal: type };
  }

  if (fuentes.esYoutube(content)) {
    // 1) Transcripción: texto puro, cero tokens de audio/video en Gemini.
    try {
      const transcripcion = await fuentes.obtenerTranscripcionYoutube(content);
      if (transcripcion) {
        console.log('  📄 Transcripción de YouTube obtenida (sin tocar audio ni video)');
        const acta = await gemini.extraerActa('transcripcion', transcripcion);
        return { acta, tipoReal: 'youtube-transcripcion' };
      }
    } catch (e) {
      console.warn(`  ⚠️ Transcripción de YouTube falló (${e.message}); probando audio...`);
    }

    // 2) Audio solo: ~1/8 del costo de mandar el video completo.
    try {
      const audioPath = await fuentes.descargarAudio(content);
      try {
        const acta = await gemini.extraerActa('audio', audioPath);
        return { acta, tipoReal: 'youtube-audio' };
      } finally {
        try { fs.unlinkSync(audioPath); } catch {}
      }
    } catch (e) {
      console.warn(`  ⚠️ Audio de YouTube falló (${e.message}); probando lectura directa...`);
    }

    // 3) Gemini lee la URL directo (sin yt-dlp) — más caro, pero robusto.
    try {
      const acta = await gemini.extraerActa('youtube', content);
      return { acta, tipoReal: 'youtube-directo' };
    } catch (e) {
      console.warn(`  ⚠️ Lectura directa falló (${e.message}); último recurso: descargar el video...`);
    }

    // 4) Último recurso: video completo.
    const videoPath = await fuentes.descargarVideo(content);
    try {
      const acta = await gemini.extraerActa('video', videoPath);
      return { acta, tipoReal: 'youtube-video' };
    } finally {
      try { fs.unlinkSync(videoPath); } catch {}
    }
  }

  if (fuentes.esVideoSocial(content) || type === 'video') {
    try {
      const audioPath = await fuentes.descargarAudio(content);
      try {
        const acta = await gemini.extraerActa('audio', audioPath);
        return { acta, tipoReal: 'social-audio' };
      } finally {
        try { fs.unlinkSync(audioPath); } catch {}
      }
    } catch (e) {
      console.warn(`  ⚠️ Audio-only falló (${e.message}); descargando video completo...`);
      const videoPath = await fuentes.descargarVideo(content);
      try {
        const acta = await gemini.extraerActa('video', videoPath);
        return { acta, tipoReal: 'social-video' };
      } finally {
        try { fs.unlinkSync(videoPath); } catch {}
      }
    }
  }

  const texto = await fuentes.extraerTextoWeb(content);
  const acta = await gemini.extraerActa('web', texto);
  return { acta, tipoReal: 'web' };
}

// ==================== PASO 1: LECTURA (multifuente, hasta 3) ====================
app.post('/api/read', async (req, res) => {
  try {
    const { type, content, sesgo, jobId: jobIdExistente } = req.body;
    if (!type || !content) throw new Error('Faltan type o content');

    let job = jobIdExistente ? await obtenerJob(jobIdExistente) : null;
    if (jobIdExistente && (!job || job.userId !== req.user.userId)) {
      return res.status(404).json({ error: 'Job no encontrado' });
    }

    const fuentesActuales = job?.fuentes || [];
    const MAX_FUENTES = 3;
    if (fuentesActuales.length >= MAX_FUENTES) {
      return res.status(400).json({ error: `Ya hay ${MAX_FUENTES} fuentes (máximo). Quita una para agregar otra.` });
    }

    const sesgoElegido = ['favor', 'contra', 'neutral'].includes(sesgo) ? sesgo : (job?.sesgo || 'neutral');
    const contenido = content.trim();

    const { acta, tipoReal } = await extraerActaDeFuente(type, contenido);
    const nuevaFuente = { type, content: contenido, tipoReal, acta };
    const todasLasFuentes = [...fuentesActuales, nuevaFuente];

    const result = await gemini.sintetizarCronica(todasLasFuentes.map(f => f.acta), sesgoElegido);

    if (!job) {
      const jobId = crypto.randomBytes(8).toString('hex');
      job = {
        jobId,
        userId: req.user.userId,
        paso: 'lectura',
        sesgo: sesgoElegido,
        fuentes: todasLasFuentes,
        guion: null,
        fragments: null,
        carpetas: null,
        audioToken: null,
        duracion: null,
      };
      crearJobDir(jobId);
      await db.addJobToHistory(req.user.userId, jobId, null, null, null, 'lectura');
    }
    Object.assign(job, { sesgo: sesgoElegido, fuentes: todasLasFuentes, ...result });
    persistirJob(job);

    res.json({
      jobId: job.jobId,
      numFuentes: todasLasFuentes.length,
      maxFuentes: MAX_FUENTES,
      fuenteResumen: acta.fuenteResumen,
      tipoReal,
      cronica: result.cronica,
      titulo: result.titulo,
      descripcion: result.descripcion,
      protagonista: result.protagonista,
      secundario: result.secundario,
      accion: result.accion,
      nombreCorto: result.nombreCorto,
    });
  } catch (error) {
    console.error('Error en /api/read:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Re-sintetizar con OTRO sesgo, sin re-descargar ni re-procesar ninguna fuente — las actas ya
// cacheadas en el job son sesgo-independientes (Fase 4 del plan maestro).
app.post('/api/resintetizar', async (req, res) => {
  try {
    const { jobId, sesgo } = req.body;
    if (!jobId) return res.status(400).json({ error: 'Falta jobId' });
    const job = await obtenerJob(jobId);
    if (!job || job.userId !== req.user.userId) return res.status(404).json({ error: 'Job no encontrado' });
    if (!job.fuentes || job.fuentes.length === 0) {
      return res.status(400).json({ error: 'Este job no tiene fuentes cacheadas — hay que releer la fuente' });
    }

    const sesgoElegido = ['favor', 'contra', 'neutral'].includes(sesgo) ? sesgo : 'neutral';
    const result = await gemini.sintetizarCronica(job.fuentes.map(f => f.acta), sesgoElegido);
    Object.assign(job, { sesgo: sesgoElegido, ...result });
    persistirJob(job);

    res.json({
      jobId,
      cronica: result.cronica,
      titulo: result.titulo,
      descripcion: result.descripcion,
      protagonista: result.protagonista,
      secundario: result.secundario,
      accion: result.accion,
      nombreCorto: result.nombreCorto,
    });
  } catch (error) {
    console.error('Error en /api/resintetizar:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// ==================== PASO 2: GUION ====================
app.post('/api/generate-script', async (req, res) => {
  try {
    const { jobId, cronica, angle, angleContent } = req.body;
    const job = await obtenerJob(jobId);
    if (!job || job.userId !== req.user.userId) throw new Error('Job no encontrado');

    const script = await gemini.generarGuion(cronica || job.cronica, angle, angleContent);
    job.guion = script;
    job.paso = 'guion';
    persistirJob(job);

    const palabras = script.split(/\s+/).filter(Boolean).length;
    res.json({ jobId, script, palabras });
  } catch (error) {
    console.error('Error en /api/generate-script:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// ==================== PASO 3: FRAGMENTAR (carpetas = celebridades en Drive) ====================
app.post('/api/fragment', async (req, res) => {
  try {
    const { jobId, script } = req.body;
    const job = await obtenerJob(jobId);
    if (!job || job.userId !== req.user.userId) throw new Error('Job no encontrado');

    const carpetasMap = await drive.obtenerCarpetasFamosos();
    const nombresCarpetas = Object.keys(carpetasMap);
    if (nombresCarpetas.length === 0) {
      throw new Error('No hay carpetas de famosos disponibles en Drive');
    }

    const fragments = await gemini.fragmentarGuionParrafos(script || job.guion, nombresCarpetas);

    job.fragments = fragments;
    job.carpetas = nombresCarpetas;
    job.carpetasMap = carpetasMap;
    job.guion = script || job.guion;
    job.paso = 'fragmentos';
    persistirJob(job);

    // Si los fragmentos no reconstruyen el guion, los tiempos de TODOS los clips quedan
    // corridos. No aborta (el video igual sale) pero el usuario tiene que enterarse.
    const avisoReconstruccion = fragments.verificacion && !fragments.verificacion.ok
      ? fragments.verificacion.mensaje
      : null;

    res.json({
      jobId,
      fragments,
      carpetas: nombresCarpetas,
      protagonistaSinCarpeta: job.protagonista && !nombresCarpetas.includes(job.protagonista),
      protagonista: job.protagonista,
      avisoReconstruccion,
    });
  } catch (error) {
    console.error('Error en /api/fragment:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// ==================== PASO 4 (antes ElevenLabs): SUBIR AUDIO ====================
app.post('/api/upload-audio', audioUpload.single('audioFile'), async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!req.file) throw new Error('No se recibió archivo de audio');

    const job = await obtenerJob(jobId);
    if (!job || job.userId !== req.user.userId) {
      fs.unlinkSync(req.file.path);
      throw new Error('Job no encontrado');
    }

    const ffprobeCmd = `"${ffprobeStatic.path}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${req.file.path}"`;
    let duracion = 0;
    try {
      const { stdout } = await exec(ffprobeCmd);
      duracion = parseFloat(stdout.trim());
      if (!duracion || duracion <= 0) throw new Error('Duración inválida');
    } catch (e) {
      fs.unlinkSync(req.file.path);
      throw new Error('No se pudo leer la duración del audio: el archivo parece dañado o no es un audio válido');
    }

    const audioToken = crypto.randomBytes(16).toString('hex');
    const audioPath = path.join(TEMP_DIR, `audio_${audioToken}.mp3`);
    const esMp3 = req.file.mimetype === 'audio/mpeg' || req.file.mimetype === 'audio/mp3';
    if (esMp3) {
      fs.renameSync(req.file.path, audioPath);
    } else {
      // WAV/M4A/OGG/etc: convertir a MP3 real. El archivo se guarda como .mp3 en todos los
      // casos y todo lo que sigue (mezcla con ffmpeg, reproductor del navegador, Whisper)
      // asume eso -- renombrar sin convertir dejaba un WAV llamado .mp3. De paso baja mucho
      // el peso en el disco efimero de Railway.
      try {
        await video.ffmpeg(['-i', req.file.path, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', audioPath]);
      } catch (e) {
        try { fs.unlinkSync(req.file.path); } catch {}
        throw new Error(`No se pudo convertir el audio a MP3: ${e.message}`);
      }
      try { fs.unlinkSync(req.file.path); } catch {}
      // La duracion se midio sobre el original; re-medir sobre el convertido para que el corte
      // de clips y los subtitulos usen el numero real del archivo que de verdad se va a usar.
      try {
        const dur = await video.obtenerDuracion(audioPath);
        if (dur && dur > 0) duracion = dur;
      } catch { /* si falla, se queda con la duracion del original: difieren en milisegundos */ }
    }

    // Timing por palabra para los subtítulos (puerta abierta del repo principal, ver tiempos.js):
    // acá no hay alineación de ningún proveedor de TTS porque el audio lo sube el usuario ya
    // grabado, así que se transcribe con Whisper y se alinea palabra a palabra contra los
    // fragmentos YA asignados (Paso 3, siempre corre antes que este paso en el flujo real).
    // Nunca aborta la subida: si falta la key, si Whisper falla, o si el audio no calza con el
    // guion (el usuario ad-libbeó o se equivocó leyendo), el audio se acepta igual — los
    // subtítulos van a salir con el reparto estimado por % de caracteres en vez de timing real.
    let duracionesReales = null;
    let palabrasAlineadas = null;
    if (job.fragments && job.fragments.length) {
      try {
        const palabrasTranscritas = await transcripcion.transcribirConTimestamps(audioPath);
        const alineado = tiempos.alinearFragmentosPalabras(job.fragments, palabrasTranscritas, duracion);
        duracionesReales = alineado?.duraciones || null;
        palabrasAlineadas = alineado?.palabras || null;
      } catch (e) {
        console.warn(`  ⚠️ No se pudo alinear el audio con Whisper (${e.message}), subtítulos sin timing real`);
      }
    }

    audiosPendientes.set(audioToken, { path: audioPath, duracion, duracionesReales, palabrasAlineadas });

    job.audioToken = audioToken;
    job.duracion = duracion;
    job.paso = 'audio';
    persistirJob(job);

    res.json({
      audioToken,
      audioUrl: `/api/audio/${audioToken}`,
      duracion,
      timingReal: Boolean(palabrasAlineadas),
    });
  } catch (error) {
    console.error('Error en /api/upload-audio:', error.message);
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/audio/:token', (req, res) => {
  const audio = audiosPendientes.get(req.params.token);
  if (!audio || !fs.existsSync(audio.path)) {
    return res.status(404).json({ error: 'Audio no encontrado' });
  }
  res.sendFile(audio.path);
});

// ==================== Construye inventario + descarga clips necesarios ====================
// clipMax opcional: cuando /api/generate-video va a encadenar transiciones xfade, cada clip con
// transición activa necesita `transicionDur` segundos EXTRA de metraje fuente para la cola de
// mezcla (ver el comentario largo en video.js/renderizarConTransiciones) — sin bajar el tope acá,
// duracion+cola se pasaría del límite legal de 3s por clip. Portado del repo principal.
// duracionesReales opcional: mismo timing real (Whisper) que usan los subtítulos — sin pasarlo
// acá, el CORTE de los clips seguiría por % de caracteres mientras los subtítulos usan timing
// real, dos relojes distintos que se desincronizan entre sí (la razón de ser de esta función
// compartida en el repo principal: "misma línea de tiempo para el corte de video y para los
// subtítulos, nunca dos relojes distintos").
async function prepararClips(job, clipMax = undefined, duracionesReales = null) {
  const famosos = [...new Set(job.fragments.map(f => f.famoso))];
  const inventario = {};
  for (const famoso of famosos) {
    const folderId = job.carpetasMap[famoso];
    if (!folderId) { inventario[famoso] = []; continue; }
    inventario[famoso] = await drive.listarVideos(folderId);
  }

  const plan = seleccion.planificarClips(job.fragments, job.duracion, inventario, duracionesReales, clipMax || seleccion.CLIP_MAX);

  const archivos = {};
  for (const clip of plan) {
    if (!clip || archivos[clip.videoId]) continue;
    archivos[clip.videoId] = await drive.descargarVideo(clip.videoId, TEMP_DIR);
  }

  return { plan, archivos };
}

// ==================== PASO 5a: GENERAR VIDEO FINAL ====================
app.post('/api/generate-video', async (req, res) => {
  try {
    const { jobId, efectos = {} } = req.body;
    const job = await obtenerJob(jobId);
    if (!job || job.userId !== req.user.userId) throw new Error('Job no encontrado');
    if (!job.fragments || !job.fragments.length) throw new Error('No hay fragmentos asignados');
    const audio = audiosPendientes.get(job.audioToken);
    if (!audio) throw new Error('No hay audio aprobado - sube un audio primero');

    // Guarda contra un frontend viejo (cacheado antes de este cambio): manda `portadaTitular`
    // —el campo que se usaba cuando el cartel se diseñaba con inputs sueltos sin canvas— y no
    // `cartelPNG`. Sin esto el video saldría mudo de cartel sin ninguna pista de por qué.
    if (efectos?.portadaTitular && !efectos?.cartelPNG) {
      return res.status(400).json({
        error: 'Tenés cargada una versión vieja de la página: recargala (Ctrl/Cmd + Shift + R) y volvé a generar.',
      });
    }

    const transicionActiva = (efectos.transicion || 'ninguno') !== 'ninguno';
    const transicionDur = Math.min(0.6, Math.max(0.1, Number(efectos.transicionDur) || 0.35));
    const clipMaxEfectivo = transicionActiva ? Math.max(0.8, seleccion.CLIP_MAX - transicionDur) : undefined;
    const { plan, archivos } = await prepararClips(job, clipMaxEfectivo, audio.duracionesReales);

    // Cartel de portada (Paso 6): el navegador ya lo dibujó en un <canvas> y manda el PNG EXACTO
    // que el usuario vio — acá solo se guarda y se superpone, nunca se re-dibuja (ver portada.js).
    const cartelPath = guardarCartelPNG(efectos?.cartelPNG, jobId);

    // Subtítulos: palabra por palabra resaltada, timing real si /api/upload-audio pudo alinear
    // con Whisper (ver tiempos.js/transcripcion.js); si no, seleccion.tiemposPorFragmento() cae
    // sola al reparto por % de caracteres. Opt-out con efectos.subtitulos===false. Nunca aborta
    // el render: si algo falla generando el .ass, el video sale igual, sin subtítulos.
    let subsPath = null;
    let fuentesDir = null;
    if (efectos?.subtitulos !== false) {
      try {
        const tiemposFragmentos = seleccion.tiemposPorFragmento(job.fragments, audio.duracion, audio.duracionesReales);
        const fuenteElegida = efectos?.subtitulosFuente || subtitulos.FUENTE_DEFAULT;
        subsPath = subtitulos.generarASS(job.fragments, tiemposFragmentos, audio.palabrasAlineadas, {
          jobId,
          tempDir: TEMP_DIR,
          fuente: fuenteElegida,
          tamano: Number.isFinite(efectos?.subtitulosTamano) ? efectos.subtitulosTamano : undefined,
          marginV: Number.isFinite(efectos?.subtitulosMarginV) ? efectos.subtitulosMarginV : undefined,
        });
        fuentesDir = await subtitulos.obtenerCarpetaFuentes(fuenteElegida);
      } catch (e) {
        console.warn(`  ⚠️ [${jobId}] Subtítulos no se pudieron generar (${e.message}), el video sale sin ellos`);
        subsPath = null;
      }
    }

    const resultado = await video.montarVideoPlan(plan, archivos, audio.path, jobId, {
      zoom: efectos.zoom || 'ninguno',
      zoomPct: Number(efectos.zoomPct) || 20,
      espejo: efectos.espejo || 'ninguno',
      transicion: efectos.transicion || 'ninguno',
      transicionDur,
      transicionTipo: efectos.transicionTipo,
      cartelPath,
      subsPath,
      fuentesDir,
    });

    const videoName = `${job.nombreCorto || 'video'}_${Date.now()}.mp4`.replace(/[^\w.\-]/g, '_');
    const finalDest = path.join(TEMP_DIR, videoName);
    fs.renameSync(resultado.finalPath, finalDest);

    job.videoPath = finalDest;
    job.videoName = videoName;
    job.cartelPath = cartelPath;
    job.paso = 'completado';
    persistirJob(job);

    video.limpiarTemporales(jobId);

    await db.updateJobHistory(req.user.userId, jobId, {
      status: 'video_ok',
      duracion: resultado.duracion,
      video_name: videoName,
    });

    res.json({
      downloadUrl: `/api/download-video/${jobId}`,
      videoUrl: `/api/video-preview/${jobId}`,
      videoName,
      duracion: resultado.duracion,
      cartelUrl: cartelPath ? `/api/cartel/${jobId}` : null,
    });
  } catch (error) {
    console.error('Error en /api/generate-video:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/download-video/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.videoPath || !fs.existsSync(job.videoPath)) {
    return res.status(404).json({ error: 'Video no disponible' });
  }
  res.download(job.videoPath, job.videoName);
});

// ==================== PASO 5b: EXPORTAR INSUMOS (ZIP: clips/ + locucion.mp3) ====================
app.post('/api/exportar', async (req, res) => {
  try {
    const { jobId, efectos = {} } = req.body;
    const job = await obtenerJob(jobId);
    if (!job || job.userId !== req.user.userId) throw new Error('Job no encontrado');
    if (!job.fragments || !job.fragments.length) throw new Error('No hay fragmentos asignados');
    const audio = audiosPendientes.get(job.audioToken);
    if (!audio) throw new Error('No hay audio aprobado - sube un audio primero');

    const { plan, archivos } = await prepararClips(job);

    const jobDir = crearJobDir(jobId);
    const clipsDir = path.join(jobDir, 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });

    const enc = await video.argsEncoder(await video.detectarEncoder());
    const zoomPreset = efectos.zoom || 'ninguno';
    const espejoPreset = efectos.espejo || 'ninguno';
    const zoomPct = Number(efectos.zoomPct) || 20;

    // Mismo fix que video.js/montarVideoPlan (2026-08-16): seleccion.js planifica el offset
    // contra la metadata de Drive, que a veces no reporta duración — si offset+duración se pasa
    // del final real del archivo, `-ss`+`-t` corta en silencio un clip más corto de lo pedido,
    // sin dar error. Acá se re-verifica contra la duración REAL ya descargada.
    const duracionesReales = {};
    async function duracionRealCacheada(ruta) {
      if (!(ruta in duracionesReales)) {
        duracionesReales[ruta] = await video.obtenerDuracion(ruta).catch(() => null);
      }
      return duracionesReales[ruta];
    }

    let n = 1;
    for (let i = 0; i < plan.length; i++) {
      const clip = plan[i];
      if (!clip || !archivos[clip.videoId]) continue;
      const numero = String(n).padStart(2, '0');
      const outPath = path.join(clipsDir, `${numero}.mp4`);

      let offsetEfectivo = clip.offset;
      const durReal = await duracionRealCacheada(archivos[clip.videoId]);
      if (durReal && offsetEfectivo + clip.duracion > durReal) {
        offsetEfectivo = Math.max(0, durReal - clip.duracion);
        console.warn(`  ⚠️ Clip ${i}: offset se pasaba de la duración real (${durReal.toFixed(2)}s) — corregido a ${offsetEfectivo.toFixed(2)}s`);
      }

      const base = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30';
      const filtros = [base];
      const zoomInfo = video.decidirEfecto(zoomPreset, i);
      if (zoomInfo.activo) filtros.push(video.filtroZoom(zoomInfo.direccion, zoomPct, clip.duracion));
      if (video.decidirEfecto(espejoPreset, i).activo) filtros.push('hflip');

      await video.ffmpeg([
        '-ss', offsetEfectivo.toFixed(2),
        '-i', archivos[clip.videoId],
        '-t', clip.duracion.toFixed(3),
        '-vf', filtros.join(','),
        '-an',
        ...enc,
        outPath,
      ]);
      n++;
    }

    fs.copyFileSync(audio.path, path.join(jobDir, 'locucion.mp3'));

    // Empaquetar ZIP
    const zipName = `insumos_${job.nombreCorto || jobId}.zip`.replace(/[^\w.\-]/g, '_');
    const zipPath = path.join(TEMP_DIR, zipName);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(clipsDir, 'clips');
      archive.file(path.join(jobDir, 'locucion.mp3'), { name: 'locucion.mp3' });
      archive.finalize();
    });

    job.zipPath = zipPath;
    job.zipName = zipName;
    job.paso = 'completado';
    persistirJob(job);

    fs.rmSync(jobDir, { recursive: true, force: true });
    video.limpiarTemporales(jobId);

    await db.updateJobHistory(req.user.userId, jobId, {
      status: 'insumos_ok',
      duracion: job.duracion,
      video_name: zipName,
    });

    res.json({
      downloadUrl: `/api/download-insumos/${jobId}`,
      zipName,
      clips: n - 1,
    });
  } catch (error) {
    console.error('Error en /api/exportar:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/download-insumos/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.zipPath || !fs.existsSync(job.zipPath)) {
    return res.status(404).json({ error: 'ZIP no disponible' });
  }
  res.download(job.zipPath, job.zipName);
});

// ==================== HISTORIAL ====================
// Devuelve un job completo para retomarlo desde el historial. Antes no existía: las tarjetas del
// historial eran texto muerto (fecha + estado) sin forma de abrir nada, así que un proceso a
// medio hacer no se podía continuar -- había que rehacerlo desde el Paso 1. Ahora que el estado
// del job vive en Postgres (ver job_state), recuperarlo sí sirve.
//
// Los ARCHIVOS no se recuperan (disco efímero): por eso se devuelve `audioDisponible`, para que
// la UI sepa si puede saltar el Paso 5 o si hay que volver a subir la locución.
app.get('/api/job/:jobId', async (req, res) => {
  try {
    const job = await obtenerJob(req.params.jobId);
    if (!job || job.userId !== req.user.userId) {
      return res.status(404).json({ error: 'Proceso no encontrado' });
    }
    const audio = job.audioToken ? audiosPendientes.get(job.audioToken) : null;
    const audioDisponible = Boolean(audio && fs.existsSync(audio.path));
    res.json({ job, audioDisponible });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    res.json({ history: await db.getJobHistory(req.user.userId) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== STARTUP ====================
async function startup() {
  try {
    const connected = await db.testConnection();
    if (!connected) throw new Error('No se pudo conectar a la base de datos');
    await db.initializeDatabase();
    cleanupCron.start();
    // Los jobs guardados de mas de 3 dias ya no sirven: sus archivos los borro hace rato el
    // cron de temporales, asi que recuperarlos solo daria un job roto. Se limpian al arrancar
    // y cada 6h, para que job_state no crezca sin limite.
    db.limpiarJobStateViejos(72).catch(() => {});
    setInterval(() => db.limpiarJobStateViejos(72).catch(() => {}), 6 * 60 * 60 * 1000);

    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('❌ Startup error:', error.message);
    process.exit(1);
  }
}

startup();

module.exports = app;
