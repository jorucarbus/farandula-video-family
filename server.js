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

const audioUpload = multer({
  dest: TEMP_DIR,
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'audio/mpeg' && file.mimetype !== 'audio/mp3') {
      return cb(new Error('Solo se aceptan archivos MP3'));
    }
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 },
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

// Todo lo demás bajo /api requiere sesión
app.use('/api', (req, res, next) => {
  if (['/signup', '/login'].includes(req.path)) return next();
  return auth.requireAuth(req, res, next);
});

// ==================== ESTADO EN MEMORIA ====================
const jobs = new Map();           // jobId -> job
const audiosPendientes = new Map(); // audioToken -> {path, duracion}

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

    let job = jobIdExistente ? jobs.get(jobIdExistente) : null;
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
    jobs.set(job.jobId, job);

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
    const job = jobs.get(jobId);
    if (!job || job.userId !== req.user.userId) return res.status(404).json({ error: 'Job no encontrado' });
    if (!job.fuentes || job.fuentes.length === 0) {
      return res.status(400).json({ error: 'Este job no tiene fuentes cacheadas — hay que releer la fuente' });
    }

    const sesgoElegido = ['favor', 'contra', 'neutral'].includes(sesgo) ? sesgo : 'neutral';
    const result = await gemini.sintetizarCronica(job.fuentes.map(f => f.acta), sesgoElegido);
    Object.assign(job, { sesgo: sesgoElegido, ...result });
    jobs.set(jobId, job);

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
    const job = jobs.get(jobId);
    if (!job) throw new Error('Job no encontrado');

    const script = await gemini.generarGuion(cronica || job.cronica, angle, angleContent);
    job.guion = script;
    job.paso = 'guion';

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
    const job = jobs.get(jobId);
    if (!job) throw new Error('Job no encontrado');

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

    const job = jobs.get(jobId);
    if (!job) {
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
      throw new Error('No se pudo leer la duración del audio (¿es un MP3 válido?)');
    }

    const audioToken = crypto.randomBytes(16).toString('hex');
    const audioPath = path.join(TEMP_DIR, `audio_${audioToken}.mp3`);
    fs.renameSync(req.file.path, audioPath);

    audiosPendientes.set(audioToken, { path: audioPath, duracion });

    job.audioToken = audioToken;
    job.duracion = duracion;
    job.paso = 'audio';

    res.json({
      audioToken,
      audioUrl: `/api/audio/${audioToken}`,
      duracion,
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
async function prepararClips(job) {
  const famosos = [...new Set(job.fragments.map(f => f.famoso))];
  const inventario = {};
  for (const famoso of famosos) {
    const folderId = job.carpetasMap[famoso];
    if (!folderId) { inventario[famoso] = []; continue; }
    inventario[famoso] = await drive.listarVideos(folderId);
  }

  const plan = seleccion.planificarClips(job.fragments, job.duracion, inventario);

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
    const job = jobs.get(jobId);
    if (!job) throw new Error('Job no encontrado');
    if (!job.fragments || !job.fragments.length) throw new Error('No hay fragmentos asignados');
    const audio = audiosPendientes.get(job.audioToken);
    if (!audio) throw new Error('No hay audio aprobado - sube un audio primero');

    const { plan, archivos } = await prepararClips(job);

    const resultado = await video.montarVideoPlan(plan, archivos, audio.path, jobId, {
      zoom: efectos.zoom || 'ninguno',
      zoomPct: Number(efectos.zoomPct) || 20,
      espejo: efectos.espejo || 'ninguno',
    });

    const videoName = `${job.nombreCorto || 'video'}_${Date.now()}.mp4`.replace(/[^\w.\-]/g, '_');
    const finalDest = path.join(TEMP_DIR, videoName);
    fs.renameSync(resultado.finalPath, finalDest);

    job.videoPath = finalDest;
    job.videoName = videoName;
    job.paso = 'completado';

    video.limpiarTemporales(jobId);

    await db.updateJobHistory(req.user.userId, jobId, {
      status: 'video_ok',
      duracion: resultado.duracion,
      video_name: videoName,
    });

    res.json({
      downloadUrl: `/api/download-video/${jobId}`,
      videoName,
      duracion: resultado.duracion,
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
    const job = jobs.get(jobId);
    if (!job) throw new Error('Job no encontrado');
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

    let n = 1;
    for (let i = 0; i < plan.length; i++) {
      const clip = plan[i];
      if (!clip || !archivos[clip.videoId]) continue;
      const numero = String(n).padStart(2, '0');
      const outPath = path.join(clipsDir, `${numero}.mp4`);

      const base = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30';
      const filtros = [base];
      const zoomInfo = video.decidirEfecto(zoomPreset, i);
      if (zoomInfo.activo) filtros.push(video.filtroZoom(zoomInfo.direccion, zoomPct, clip.duracion));
      if (video.decidirEfecto(espejoPreset, i).activo) filtros.push('hflip');

      await video.ffmpeg([
        '-ss', clip.offset.toFixed(2),
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
