require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

const gemini = require('./gemini');
const video = require('./video');
const seleccion = require('./seleccion');
const auth = require('./auth');
const db = require('./db');
const cleanupCron = require('./cleanupCron');

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const TEMP_DIR = path.join(__dirname, 'temp-videos');
const INSUMOS_DIR = path.join(__dirname, 'temp-insumos');

// Ensure directories exist
[TEMP_DIR, INSUMOS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public', {
  setHeaders: (res, ruta) => {
    if (/\.(html|css|js)$/i.test(ruta)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Upload config for audio files
const audioUpload = multer({
  dest: TEMP_DIR,
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'audio/mpeg') {
      return cb(new Error('Only MP3 files allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ==================== AUTH ROUTES ====================
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await auth.signup(email, password);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await auth.login(email, password);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/me', auth.requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.userId);
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== JOB ROUTES ====================

// Job storage (in-memory for now, could migrate to DB)
const jobs = new Map();

// Audio tokens (store for retrieval later)
const audiosPendientes = new Map();

app.post('/api/read', auth.requireAuth, async (req, res) => {
  try {
    const { type, content, sesgo } = req.body;

    // Create job
    const jobId = crypto.randomBytes(8).toString('hex');
    const job = {
      jobId,
      userId: req.user.userId,
      paso: 'lectura',
      tipo: type,
      contenido: content,
      sesgo,
      cronica: null,
      guion: null,
      fragmentos: null,
      audioPath: null,
      audioToken: null,
      canal: null,
      createdAt: new Date().toISOString(),
    };

    // Process lectura con Gemini
    const result = await gemini.procesarLectura(type, content, sesgo);
    job.cronica = result.cronica;
    job.canal = result.canal || 'General';

    // Save job
    jobs.set(jobId, job);

    // Add to history
    await db.addJobToHistory(req.user.userId, jobId, job.canal, null, null, 'lectura_ok');

    res.json({
      jobId,
      cronica: job.cronica,
      canal: job.canal,
    });
  } catch (error) {
    console.error('Error en /api/read:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/generate-script', auth.requireAuth, async (req, res) => {
  try {
    const { jobId, cronica, angulo } = req.body;
    const job = jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    // Generate guion
    const guion = await gemini.generarGuion(cronica, angulo);
    job.guion = guion;
    job.paso = 'guion';

    jobs.set(jobId, job);
    res.json({ jobId, guion });
  } catch (error) {
    console.error('Error en /api/generate-script:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/fragment', auth.requireAuth, async (req, res) => {
  try {
    const { jobId, guion } = req.body;
    const job = jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    // Fragment script
    const fragmentos = await gemini.fragmentarGuionParrafos(guion, ['Protagonista']);
    job.fragmentos = fragmentos;
    job.paso = 'fragmentos';

    jobs.set(jobId, job);
    res.json({ jobId, fragmentos });
  } catch (error) {
    console.error('Error en /api/fragment:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// ==================== AUDIO UPLOAD ====================
app.post('/api/upload-audio', auth.requireAuth, audioUpload.single('audioFile'), async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!req.file) throw new Error('No audio file provided');

    const job = jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    // Get duration using ffprobe
    const ffprobe = require('ffprobe-static');
    const ffprobeCmd = `"${ffprobe.path}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1:noprint_filename=1 "${req.file.path}"`;

    let duracion = 0;
    try {
      const { stdout } = await exec(ffprobeCmd);
      duracion = parseFloat(stdout.trim());
      if (!duracion || duracion <= 0) {
        throw new Error('Invalid audio duration');
      }
    } catch (e) {
      fs.unlinkSync(req.file.path);
      throw new Error('Could not determine audio duration');
    }

    // Store audio
    const audioToken = crypto.randomBytes(16).toString('hex');
    const audioPath = path.join(TEMP_DIR, `audio_${audioToken}.mp3`);
    fs.renameSync(req.file.path, audioPath);

    audiosPendientes.set(audioToken, {
      path: audioPath,
      duracion,
      modelo: 'uploaded',
    });

    job.audioPath = audioPath;
    job.audioToken = audioToken;
    job.duracion = duracion;
    job.paso = 'audio';

    jobs.set(jobId, job);

    res.json({
      audioToken,
      audioUrl: `/api/audio/${audioToken}`,
      duracion,
      modelo: 'uploaded',
    });
  } catch (error) {
    console.error('Error en /api/upload-audio:', error.message);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(400).json({ error: error.message });
  }
});

// Serve audio
app.get('/api/audio/:token', (req, res) => {
  const token = req.params.token;
  const audio = audiosPendientes.get(token);

  if (!audio || !fs.existsSync(audio.path)) {
    return res.status(404).json({ error: 'Audio not found' });
  }

  res.sendFile(audio.path);
});

// ==================== VIDEO GENERATION ====================
app.post('/api/generate-video', auth.requireAuth, async (req, res) => {
  try {
    const { jobId, audioToken, efectos = {} } = req.body;
    const job = jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    const audio = audiosPendientes.get(audioToken);
    if (!audio) throw new Error('Audio not found - regenerate or upload again');

    // Get clips (simulated, no real video download)
    const mockClips = job.fragmentos.map((f, i) => ({
      id: `clip_${i}`,
      path: null, // In real scenario, download from videos
    }));

    // Generate video
    // For now, this is a placeholder - real implementation would:
    // 1. Download clips
    // 2. Compose with audio
    // 3. Apply effects

    const videoName = `video_${job.jobId}_${Date.now()}.mp4`;
    const videoPath = path.join(TEMP_DIR, videoName);

    // Create dummy video file (in real implementation, use video.montarVideoPlan)
    fs.writeFileSync(videoPath, 'mock video content');

    // Prepare download
    job.videoPath = videoPath;
    job.videoName = videoName;
    job.paso = 'video';
    jobs.set(jobId, job);

    // Update history
    await db.updateJobHistory(req.user.userId, jobId, {
      status: 'video_ok',
      duracion: audio.duracion,
      video_name: videoName,
    });

    // Return download link
    res.json({
      downloadUrl: `/api/download-video/${jobId}`,
      videoName,
    });
  } catch (error) {
    console.error('Error en /api/generate-video:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/download-video/:jobId', auth.requireAuth, (req, res) => {
  try {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job || !job.videoPath || !fs.existsSync(job.videoPath)) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.download(job.videoPath, job.videoName);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== HISTORY ====================
app.get('/api/history', auth.requireAuth, async (req, res) => {
  try {
    const history = await db.getJobHistory(req.user.userId);
    res.json({ history });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== SERVER STARTUP ====================
async function startup() {
  try {
    // Test DB connection
    const connected = await db.testConnection();
    if (!connected) {
      throw new Error('Database connection failed');
    }

    // Initialize DB schema
    await db.initializeDatabase();

    // Start cleanup cron
    cleanupCron.start();

    // Start server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📁 Temp directory: ${TEMP_DIR}`);
      console.log(`📦 Insumos directory: ${INSUMOS_DIR}`);
    });
  } catch (error) {
    console.error('❌ Startup error:', error.message);
    process.exit(1);
  }
}

startup();

module.exports = app;
