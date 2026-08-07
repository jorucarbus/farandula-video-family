const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Binarios estáticos de npm: no dependen del PATH del sistema (en Railway/Nixpacks
// ffmpeg/ffprobe no llegan al runtime → spawn ENOENT). Se llaman por ruta absoluta.
const FFMPEG_BIN = require('ffmpeg-static');
const FFPROBE_BIN = require('ffprobe-static').path;

const TEMP_DIR = path.join(__dirname, 'temp-videos');


// Límite duro por llamada: si ffmpeg se cuelga (bug de filtros, buffer infinito),
// se mata solo y el error sube en vez de dejar el render congelado para siempre
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG_BIN, ['-y', ...args], { maxBuffer: 1024 * 1024 * 50, timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        const motivo = err.killed ? `timeout de ${FFMPEG_TIMEOUT_MS / 60000} min alcanzado (proceso matado)` : (stderr || '').slice(-500);
        return reject(new Error(`ffmpeg: ${motivo}`));
      }
      resolve(stdout);
    });
  });
}

// ---- Encoder: NVENC (GPU NVIDIA) si está disponible, si no libx264 (CPU) ----
let ENCODER_DETECTADO = null;

async function detectarEncoder() {
  if (ENCODER_DETECTADO) return ENCODER_DETECTADO;
  try {
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:size=256x256:duration=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-']);
    ENCODER_DETECTADO = 'h264_nvenc';
    console.log('  ⚡ Encoder: NVENC (GPU)');
  } catch {
    ENCODER_DETECTADO = 'libx264';
    console.log('  🖥️ Encoder: libx264 (CPU)');
  }
  return ENCODER_DETECTADO;
}

function argsEncoder(encoder) {
  return encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
}

function ffprobe(args) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE_BIN, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffprobe: ${stderr.slice(-300)}`));
      resolve(stdout.trim());
    });
  });
}

// Duración real de un archivo de audio/video en segundos
async function obtenerDuracion(filePath) {
  const out = await ffprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return parseFloat(out);
}


// ---- Efectos por clip: zoom (Ken Burns, activo toda la duración) + espejo (hflip) ----
// Presets (mismos para zoom y espejo): 'todos' | 'alternado' | 'intercalado' | 'ninguno'
const FPS_EFECTOS = 30;

function decidirEfecto(preset, index) {
  switch (preset) {
    case 'todos': return { activo: true, direccion: 'in' };
    case 'alternado': return { activo: index % 2 === 0, direccion: 'in' };
    // 'intercalado' solo tiene sentido direccional en zoom (in/out); en espejo equivale a alternado.
    case 'intercalado': return { activo: true, direccion: index % 2 === 0 ? 'in' : 'out' };
    default: return { activo: false, direccion: 'in' };
  }
}

// Zoom lineal durante TODA la duración del clip: 'in' 100%→(100+pct)%, 'out' al revés.
// zoompan con d=1 procesa cada frame del video una sola vez (no lo congela como Ken Burns de imagen fija).
function filtroZoom(direccion, pct, duracionClip) {
  const frames = Math.max(2, Math.round(duracionClip * FPS_EFECTOS));
  const factor = Math.max(0, pct) / 100;
  const expr = direccion === 'out'
    ? `(1+${factor})-on/${frames}*${factor}`
    : `1+on/${frames}*${factor}`;
  // d DEBE ser un entero de frames. d=1 = 1 frame de salida por frame de entrada
  // (zoom suave sobre el video). d=decimal (ej. d=2.456) rompe con -22 "Invalid
  // argument" en ffmpeg estricto (Railway); d=frames congela el clip (imagen fija).
  return `zoompan=z='${expr}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=${FPS_EFECTOS}`;
}

// ---- Montaje v2: por plan de clips (tiempos por porcentaje, sin ajuste de velocidad) ----
// plan: [{videoId, offset, duracion}], archivos: {videoId: ruta local}
// efectos: { zoom: preset, zoomPct: number, espejo: preset }
// La suma de duraciones = duración del audio, así que el video calza por construcción.
async function montarVideoPlan(plan, archivos, audioPath, jobId, efectos = {}) {
  const enc = argsEncoder(await detectarEncoder());
  const segmentos = [];
  const zoomPreset = efectos.zoom || 'ninguno';
  const espejoPreset = efectos.espejo || 'ninguno';
  const zoomPct = Number.isFinite(efectos.zoomPct) ? efectos.zoomPct : 20;

  for (let i = 0; i < plan.length; i++) {
    const clip = plan[i];
    if (!clip || !archivos[clip.videoId]) continue;
    const segPath = path.join(TEMP_DIR, `${jobId}_seg${i}.mp4`);

    const base = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30';
    const filtros = [base];
    const zoomInfo = decidirEfecto(zoomPreset, i);
    if (zoomInfo.activo) filtros.push(filtroZoom(zoomInfo.direccion, zoomPct, clip.duracion));
    if (decidirEfecto(espejoPreset, i).activo) filtros.push('hflip');

    const argsSegmento = (vf) => [
      '-ss', clip.offset.toFixed(2),
      '-i', archivos[clip.videoId],
      '-t', clip.duracion.toFixed(3),
      '-vf', vf,
      '-an',
      ...enc,
      segPath,
    ];

    try {
      await ffmpeg(argsSegmento(filtros.join(',')));
    } catch (e) {
      // Si el clip con efectos falla (ej. zoompan rechazado por ffmpeg estricto),
      // no abortar todo el render: reintentar ESE segmento sin efectos (plano).
      if (filtros.length > 1) {
        console.warn(`  ⚠️ Segmento ${i} falló con efectos, reintentando plano: ${e.message}`);
        await ffmpeg(argsSegmento(base));
      } else {
        throw e;
      }
    }
    segmentos.push(segPath);
  }

  if (segmentos.length === 0) {
    throw new Error('Ningún clip del plan tiene video asignado');
  }

  // Concatenar
  const listaPath = path.join(TEMP_DIR, `${jobId}_lista.txt`);
  fs.writeFileSync(listaPath, segmentos.map(s => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
  const basePath = path.join(TEMP_DIR, `${jobId}_base.mp4`);
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listaPath, '-c', 'copy', basePath]);

  // Mux con la locución: si el video quedó una pizca corto (redondeos), se congela
  // el último frame hasta 2s; el corte final es exactamente la duración del audio.
  const durAudio = await obtenerDuracion(audioPath);
  const finalPath = path.join(TEMP_DIR, `${jobId}_final.mp4`);
  await ffmpeg([
    '-i', basePath,
    '-i', audioPath,
    '-filter:v', 'tpad=stop_mode=clone:stop_duration=2',
    '-map', '0:v', '-map', '1:a',
    '-t', durAudio.toFixed(3),
    ...enc,
    '-c:a', 'aac', '-b:a', '192k',
    finalPath,
  ]);

  [...segmentos, listaPath, basePath].forEach(f => {
    try { fs.unlinkSync(f); } catch {}
  });

  return { finalPath, duracion: Math.round(durAudio), clips: segmentos.length };
}

// Limpiar archivos temporales de un job. NO toca los clips fuente cacheados (src_*.mp4):
// ese caché es compartido entre jobs a propósito, y borrarlo aquí corría la carrera de que
// un job terminando/fallando eliminara el clip que OTRO job concurrente acababa de descargar
// y estaba por leer con ffmpeg.
function limpiarTemporales(jobId) {
  try {
    for (const f of fs.readdirSync(TEMP_DIR)) {
      if (f.startsWith(jobId)) {
        try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
      }
    }
  } catch {}
}

module.exports = {
  montarVideoPlan,
  obtenerDuracion,
  limpiarTemporales,
  TEMP_DIR,
  // Reusados por exportar.js (corte de insumos individuales) para no duplicar
  // la detección de encoder ni los efectos de zoom/espejo.
  ffmpeg,
  detectarEncoder,
  argsEncoder,
  decidirEfecto,
  filtroZoom,
};
