const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Binarios estáticos de npm: no dependen del PATH del sistema (en Railway/Nixpacks
// ffmpeg/ffprobe no llegan al runtime → spawn ENOENT). Se llaman por ruta absoluta.
const FFMPEG_BIN = require('ffmpeg-static');
const FFPROBE_BIN = require('ffprobe-static').path;

const TEMP_DIR = path.join(__dirname, 'temp-videos');
const USAGE_FILE = path.join(__dirname, 'usage.json');

// Velocidad de lectura estimada (caracteres por segundo) para la duración base de cada clip
const CHARS_POR_SEGUNDO = 17;
const DURACION_MIN = 1.5;
const DURACION_MAX = 4;
// Segundos a descartar al inicio de cada video fuente
const RECORTE_INICIAL = 1;

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

// ---- Registro de uso de videos (para no repetir hasta agotar la carpeta) ----
function cargarUso() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function guardarUso(uso) {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(uso, null, 2));
}

// ---- Selección de videos por carpeta de famoso ----
// carpetasVideos: { nombreCarpeta: [{id, name}, ...] }
// Devuelve para cada fragmento el video asignado, evitando repetir hasta usar todos.
function asignarVideos(fragments, carpetasVideos) {
  const uso = cargarUso();
  const asignaciones = [];

  for (const frag of fragments) {
    const nombre = frag.famoso;
    const videos = carpetasVideos[nombre] || [];
    if (videos.length === 0) {
      asignaciones.push(null);
      continue;
    }

    if (!uso[nombre]) uso[nombre] = [];
    let disponibles = videos.filter(v => !uso[nombre].includes(v.id));

    // Si se agotaron todos los videos de la carpeta, reiniciar el ciclo
    if (disponibles.length === 0) {
      uso[nombre] = [];
      disponibles = videos;
    }

    const elegido = disponibles[Math.floor(Math.random() * disponibles.length)];
    uso[nombre].push(elegido.id);
    asignaciones.push(elegido);
  }

  guardarUso(uso);
  return asignaciones;
}

// Duración base de un fragmento según sus caracteres
function duracionFragmento(texto) {
  const dur = texto.length / CHARS_POR_SEGUNDO;
  return Math.min(DURACION_MAX, Math.max(DURACION_MIN, dur));
}

// ---- Montaje ----
// fragments: [{famoso, texto}], archivos: [ruta local del video por fragmento]
// audioPath: locución. Devuelve ruta del video final.
async function montarVideo(fragments, archivos, audioPath, jobId) {
  const segmentos = [];

  // 1. Crear cada segmento: recortar inicio, duración base, formato vertical 1080x1920
  for (let i = 0; i < fragments.length; i++) {
    if (!archivos[i]) continue;
    const dur = duracionFragmento(fragments[i].texto);
    const segPath = path.join(TEMP_DIR, `${jobId}_seg${i}.mp4`);

    await ffmpeg([
      '-ss', String(RECORTE_INICIAL),
      '-i', archivos[i],
      '-t', dur.toFixed(2),
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30',
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      segPath,
    ]);
    segmentos.push(segPath);
  }

  if (segmentos.length === 0) {
    throw new Error('Ningún fragmento tiene video asignado');
  }

  // 2. Concatenar segmentos
  const listaPath = path.join(TEMP_DIR, `${jobId}_lista.txt`);
  fs.writeFileSync(listaPath, segmentos.map(s => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
  const basePath = path.join(TEMP_DIR, `${jobId}_base.mp4`);
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listaPath, '-c', 'copy', basePath]);

  // 3. Ajustar velocidad del video para empatar con la duración de la locución
  const durVideo = await obtenerDuracion(basePath);
  const durAudio = await obtenerDuracion(audioPath);
  const factor = durAudio / durVideo; // <1 acelera, >1 desacelera

  const finalPath = path.join(TEMP_DIR, `${jobId}_final.mp4`);
  await ffmpeg([
    '-i', basePath,
    '-i', audioPath,
    '-filter:v', `setpts=PTS*${factor.toFixed(5)}`,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
    finalPath,
  ]);

  // Limpiar intermedios
  [...segmentos, listaPath, basePath].forEach(f => {
    try { fs.unlinkSync(f); } catch {}
  });

  const durFinal = await obtenerDuracion(finalPath);
  return { finalPath, duracion: Math.round(durFinal), factorVelocidad: (1 / factor).toFixed(2) };
}

// ---- Montaje HYPERFRAMES: transiciones xfade + SFX en los cambios de párrafo ----
// plan: [{videoId, offset, duracion, parrafoIdx}], tecnico: {numParrafo: {transicion, sfx}}
// sfxDir: carpeta local con subcarpetas whoosh/impacto/pop/riser (nombres de categoría = SFX)
const DUR_TRANSICION = 0.3;  // duración de una transición visible
const DUR_CORTE = 0.05;      // "corte": xfade imperceptible (uniformiza la cadena)

function elegirSfx(sfxDir, categoria) {
  // Las categorías del guion técnico mapean a subcarpetas de recursos/sfx
  const carpetaPorCategoria = { whoosh: 'transicion', impacto: 'impacto', pop: 'pop', riser: 'suspenso' };
  const sub = carpetaPorCategoria[categoria];
  if (!sub) return null;
  try {
    const dir = path.join(sfxDir, sub);
    const archivos = fs.readdirSync(dir).filter(f => /\.(mp3|wav|ogg)$/i.test(f));
    if (!archivos.length) return null;
    return path.join(dir, archivos[Math.floor(Math.random() * archivos.length)]);
  } catch {
    return null;
  }
}

// Escapar una ruta de Windows para usarla dentro de un filtro de FFmpeg
function rutaFiltro(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// extras: { subsPath, fuentesDir, emojis: [{png, inicio, dur}] }
async function montarVideoHyper(plan, tecnico, archivos, audioPath, jobId, sfxDir, extras = {}) {
  const clips = plan.filter(c => c && archivos[c.videoId]);
  if (clips.length === 0) throw new Error('Ningún clip del plan tiene video asignado');
  const enc = argsEncoder(await detectarEncoder());

  // Transición de cada frontera: entre clip i y i+1 hay transición visible solo si
  // el clip i+1 inicia un párrafo nuevo con transición definida en el guion técnico
  const fronteras = []; // por clip i: {dur, sfx} de la transición hacia el siguiente
  for (let i = 0; i < clips.length - 1; i++) {
    const cambiaParrafo = clips[i + 1].parrafoIdx !== clips[i].parrafoIdx;
    const corte = cambiaParrafo ? tecnico[clips[i + 1].parrafoIdx + 1] : null; // tecnico usa numeración 1-based
    if (corte && corte.transicion !== 'corte') {
      fronteras.push({ transicion: corte.transicion, dur: DUR_TRANSICION, sfx: corte.sfx });
    } else {
      fronteras.push({ transicion: 'fade', dur: DUR_CORTE, sfx: corte?.sfx || 'ninguno' });
    }
  }

  // 1. Cortar segmentos. Cada clip se alarga la duración de SU transición de salida
  //    (el xfade consume ese excedente) + 0.5s de margen contra el redondeo a frames
  //    (xfade ignora lo que sobre después de la transición; el corte final es -t durAudio).
  //    tpad garantiza la longitud aunque el video fuente se quede corto.
  const segmentos = [];
  for (let i = 0; i < clips.length; i++) {
    const extra = i < fronteras.length ? fronteras[i].dur : 0;
    const total = clips[i].duracion + extra + 0.5;
    const segPath = path.join(TEMP_DIR, `${jobId}_seg${i}.mp4`);
    await ffmpeg([
      '-ss', clips[i].offset.toFixed(2),
      '-i', archivos[clips[i].videoId],
      '-vf', `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,tpad=stop_mode=clone:stop_duration=2`,
      '-t', total.toFixed(3),
      '-an',
      ...enc,
      segPath,
    ]);
    segmentos.push(segPath);
  }

  // 2. Cadena de xfade: offset de cada transición = suma de duraciones originales
  const inputs = [];
  segmentos.forEach(s => inputs.push('-i', s));
  inputs.push('-i', audioPath);
  const idxAudio = segmentos.length;

  const filtros = [];
  let etiqueta = '[0:v]';
  let acumulado = clips[0].duracion;
  for (let i = 1; i < segmentos.length; i++) {
    const f = fronteras[i - 1];
    const salida = i === segmentos.length - 1 ? '[vfinal]' : `[vx${i}]`;
    // offset = suma de duraciones ORIGINALES hasta el clip anterior: el excedente (tail)
    // de cada segmento es lo que consume la transición, así el total = duración del audio
    filtros.push(`${etiqueta}[${i}:v]xfade=transition=${f.transicion}:duration=${f.dur}:offset=${acumulado.toFixed(3)}${salida}`);
    etiqueta = salida;
    acumulado += clips[i].duracion;
  }
  if (segmentos.length === 1) {
    filtros.push('[0:v]null[vfinal]');
  }

  // Subtítulos ASS (tipografías desde recursos/fuentes)
  let etiquetaVideo = '[vfinal]';
  if (extras.subsPath) {
    const fdir = extras.fuentesDir ? `:fontsdir='${rutaFiltro(extras.fuentesDir)}'` : '';
    filtros.push(`${etiquetaVideo}ass='${rutaFiltro(extras.subsPath)}'${fdir}[vsubs]`);
    etiquetaVideo = '[vsubs]';
  }

  // 3. SFX: sonido en cada frontera con efecto, mezclado con la locución
  const entradasSfx = [];
  let tiempo = 0;
  for (let i = 0; i < fronteras.length; i++) {
    tiempo += clips[i].duracion;
    const f = fronteras[i];
    if (f.sfx === 'ninguno' || !sfxDir) continue;
    const archivo = elegirSfx(sfxDir, f.sfx);
    if (!archivo) continue;
    const delayMs = Math.max(0, Math.round((tiempo - 0.15) * 1000));
    entradasSfx.push({ archivo, delayMs });
  }

  let mapaAudio = `${idxAudio}:a`;
  if (entradasSfx.length > 0) {
    const etiquetasSfx = [];
    entradasSfx.forEach((s, k) => {
      const idx = idxAudio + 1 + k;
      inputs.push('-i', s.archivo);
      filtros.push(`[${idx}:a]adelay=${s.delayMs}|${s.delayMs},volume=0.45[sfx${k}]`);
      etiquetasSfx.push(`[sfx${k}]`);
    });
    filtros.push(`[${idxAudio}:a]${etiquetasSfx.join('')}amix=inputs=${entradasSfx.length + 1}:duration=first:normalize=0[afinal]`);
    mapaAudio = null;
  }

  // Overlays de emoji (PNG de Twemoji): loop continuo + enable en la ventana del párrafo
  // (con fades en tiempo absoluto; NO usar setpts desplazado: hace que overlay bufferee
  // todos los frames previos en RAM y ffmpeg se cuelga)
  const emojis = (extras.emojis || []).filter(e => e && e.png);
  emojis.forEach((e, k) => {
    const idx = idxAudio + 1 + entradasSfx.length + k;
    // Stream FINITO (-t hasta que desaparece el emoji): un loop infinito hace que
    // ffmpeg bufferee frames sin límite y se cuelgue con GB de RAM
    inputs.push('-loop', '1', '-framerate', '30', '-t', (e.inicio + e.dur + 0.1).toFixed(2), '-i', e.png);
    const ini = e.inicio.toFixed(2);
    const fin = (e.inicio + e.dur).toFixed(2);
    const fadeOut = (e.inicio + e.dur - 0.25).toFixed(2);
    filtros.push(
      `[${idx}:v]scale=230:230,format=rgba,fade=t=in:st=${ini}:d=0.25:alpha=1,fade=t=out:st=${fadeOut}:d=0.25:alpha=1[em${k}]`
    );
    const salida = `[vem${k}]`;
    filtros.push(`${etiquetaVideo}[em${k}]overlay=(W-w)/2:480:enable='between(t,${ini},${fin})':eof_action=pass${salida}`);
    etiquetaVideo = salida;
  });

  // 4. Render final: duración exacta de la locución
  const durAudio = await obtenerDuracion(audioPath);
  const finalPath = path.join(TEMP_DIR, `${jobId}_final.mp4`);
  if (process.env.DEBUG_FFMPEG) {
    console.log('DEBUG filter_complex:\n' + filtros.join(';\n'));
    console.log('DEBUG inputs:', JSON.stringify(inputs));
  }
  await ffmpeg([
    ...inputs,
    '-filter_complex', filtros.join(';'),
    '-map', etiquetaVideo,
    '-map', mapaAudio ? mapaAudio : '[afinal]',
    '-t', durAudio.toFixed(3),
    ...enc,
    '-c:a', 'aac', '-b:a', '192k',
    finalPath,
  ]);

  segmentos.forEach(f => { try { fs.unlinkSync(f); } catch {} });

  return {
    finalPath,
    duracion: Math.round(durAudio),
    clips: segmentos.length,
    transiciones: fronteras.filter(f => f.dur === DUR_TRANSICION).length,
    sfx: entradasSfx.length,
  };
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
  asignarVideos,
  montarVideo,
  montarVideoPlan,
  montarVideoHyper,
  obtenerDuracion,
  duracionFragmento,
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
