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
        // 4000 en vez de 500: un filter_complex de varias tandas es largo, y el error REAL de
        // ffmpeg (qué pad/link falla) suele venir en la cola del stderr — con 500 se cortaba
        // justo antes y solo quedaba el filtro repetido, sin la causa (visto real 2026-08-16).
        const motivo = err.killed ? `timeout de ${FFMPEG_TIMEOUT_MS / 60000} min alcanzado (proceso matado)` : (stderr || '').slice(-4000);
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

// Escapar una ruta de Windows para usarla dentro de un filtro de FFmpeg (drive letter ':'
// necesita escaparse o el parser de filtros lo confunde con un separador de opción).
function rutaFiltro(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
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

// Zoom durante TODA la duración del clip: 'in' 100%→(100+pct)%, 'out' al revés.
// zoompan con d=1 procesa cada frame del video una sola vez (no lo congela como Ken Burns de imagen fija).
//
// Fase 7: progreso con aceleración no lineal (ease-out cúbico) en vez de lineal — el cambio de
// una línea con mejor relación esfuerzo/resultado del plan. Lineal (on/frames) se sentía plano;
// arranca rápido y frena hacia el final, como un zoom hecho a mano.
// min(...,1) al final: si el clip se corta más largo que duracionClip (cola extra para una
// transición xfade, Fase 7), el zoom no se pasa del factor pedido — se sostiene en el 100%
// final durante esa cola, que es justo lo que conviene para la mezcla.
function filtroZoom(direccion, pct, duracionClip) {
  const frames = Math.max(2, Math.round(duracionClip * FPS_EFECTOS));
  const factor = Math.max(0, pct) / 100;
  const progreso = `(1-pow(1-min(on/${frames},1),3))`;
  const expr = direccion === 'out'
    ? `(1+${factor})-${progreso}*${factor}`
    : `1+${progreso}*${factor}`;
  // d DEBE ser un entero de frames. d=1 = 1 frame de salida por frame de entrada
  // (zoom suave sobre el video). d=decimal (ej. d=2.456) rompe con -22 "Invalid
  // argument" en ffmpeg estricto (Railway); d=frames congela el clip (imagen fija).
  return `zoompan=z='${expr}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=${FPS_EFECTOS}`;
}

// ---- Transiciones entre clips (Fase 7) ----
// Subconjunto curado de las transiciones `xfade` de ffmpeg (tiene 58) — las que se ven bien en
// un corte rápido vertical de farándula, sin las muy lentas/cinematográficas que no pegan con
// el ritmo. 'aleatorio' elige una distinta en cada corte (variedad sin que el usuario elija una
// por una).
const TRANSICIONES_DISPONIBLES = [
  'fade', 'fadeblack', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'circleopen', 'circleclose', 'dissolve', 'pixelize', 'radial', 'zoomin',
];

// tipo puede ser: un string fijo ('fade'), 'aleatorio' (cualquiera de las 16), o un ARRAY de
// tipos elegidos por el usuario (pedido explícito: "quiero seleccionar las transiciones que
// quiero que sean aleatorias... tal vez solo 3 o 5") — random SOLO entre esos. Un array de 1
// se comporta como fijo (random entre una opción siempre da esa opción).
function elegirTransicion(tipo) {
  if (tipo === 'aleatorio' || (Array.isArray(tipo) && tipo.length === 0)) {
    return TRANSICIONES_DISPONIBLES[Math.floor(Math.random() * TRANSICIONES_DISPONIBLES.length)];
  }
  if (Array.isArray(tipo)) {
    const validos = tipo.filter(t => TRANSICIONES_DISPONIBLES.includes(t));
    // Ninguno de los tipos del array es válido (dato corrupto): cae a la lista completa en vez
    // de romper el render.
    const pool = validos.length > 0 ? validos : TRANSICIONES_DISPONIBLES;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  return TRANSICIONES_DISPONIBLES.includes(tipo) ? tipo : 'fade';
}

// `xfade` no escala a videos con muchos clips: un filter_complex con 58 entradas encadenadas
// (probado real, 2026-08-09, a 1080x1920) llegó a más de 8GB de RAM y no terminaba en tiempo
// razonable (0.34x tiempo real) — eso es justo lo que tumbaba el render en Railway y caía en
// silencio a cortes secos, sin que el usuario supiera por qué. 10 clips en una sola cadena
// verificado real: 9.2s, sin problema. Por eso el plan se corta en TANDAS (ver renderizarPorTandas).
const TANDA_MAX = 10;

// true si el corte k (entre clip k y k+1) cae justo en el borde de una tanda — ahí NUNCA hay
// transición (cada tanda se renderiza por separado), así que ese clip no necesita la cola de
// mezcla extra.
function esLimiteDeTanda(k, tam = TANDA_MAX) {
  return (k + 1) % tam === 0;
}

// Encadena segmentos YA CORTADOS (algunos con cola extra de `duracion` segundos, ver
// montarVideoPlan) con `xfade` en los cortes activos y `concat` (sin mezcla) en los demás —
// mismo filtro_complex, una sola pasada de ffmpeg. `duracionesVisibles[i]` es la duración QUE
// VE el espectador de cada segmento (sin la cola de mezcla), no la longitud real del archivo.
//
// offset de cada xfade = suma acumulada de duracionesVisibles hasta ese corte: es el punto en
// el tiempo, dentro de la MEZCLA acumulada hasta ahí, donde arranca la cola de ese clip. Ver
// comentario largo en montarVideoPlan para la derivación completa.
async function renderizarConTransiciones(segmentos, duracionesVisibles, outPath, { preset, duracion, tipo, enc }) {
  const inputs = [];
  segmentos.forEach(s => inputs.push('-i', s));

  const filtros = [];
  // Normalizar CADA entrada (fps + formato de pixel) antes de encadenar. Sin esto, alternar
  // `xfade` y `concat` en la misma cadena (preset "alternado") falla con "match the
  // corresponding second input link xfade timebase" — encontrado probando el preset real, no
  // en la teoría: NVENC deja timebases distintas entre segmentos que `concat` no reconcilia
  // antes de entrar al siguiente `xfade`. `fps=30` fuerza el mismo timebase en todas las
  // entradas, así el orden xfade/concat que venga ya no importa.
  segmentos.forEach((_, k) => filtros.push(`[${k}:v]fps=30,format=yuv420p[n${k}]`));

  let etiqueta = '[n0]';
  let acumulado = duracionesVisibles[0];

  for (let k = 0; k < segmentos.length - 1; k++) {
    const activa = decidirEfecto(preset, k).activo;
    const siguiente = `[n${k + 1}]`;
    const salida = k === segmentos.length - 2 ? '[vout]' : `[vx${k}]`;
    // fps=30 encadenado DESPUÉS de xfade/concat, no solo antes: el timebase que cada filtro
    // deja en su salida no siempre hereda el de sus entradas (visto real: entradas ya en 1/30,
    // salida de `concat` en otro timebase, y el siguiente `xfade` la rechaza). Re-normalizar en
    // cada etapa es lo único que sostiene la cadena completa sin importar cuántas veces alterne.
    if (activa) {
      const t = elegirTransicion(tipo);
      filtros.push(`${etiqueta}${siguiente}xfade=transition=${t}:duration=${duracion.toFixed(2)}:offset=${acumulado.toFixed(3)},fps=30,format=yuv420p${salida}`);
    } else {
      filtros.push(`${etiqueta}${siguiente}concat=n=2:v=1:a=0,fps=30,format=yuv420p${salida}`);
    }
    etiqueta = salida;
    acumulado += duracionesVisibles[k + 1];
  }

  await ffmpeg([
    ...inputs,
    '-filter_complex', filtros.join(';'),
    '-map', '[vout]',
    ...enc,
    outPath,
  ]);
}

// Fase 8c: prepara la pista de música elegida para mezclarla — corta su silencio inicial (una
// sola vez, `offsetInicio` viene de la etiqueta del archivo en Drive, ver musica.js), la
// repite en loop hasta cubrir la duración del video, y le aplica la ganancia fija que pidió el
// usuario (-20dB por defecto, "todo el video igual" — SIN ducking dinámico: la voz es continua
// con pausas menores a 150ms, medido real, así que un compresor nunca llegaría a recuperarse
// entre palabras sin sonar a bombeo) más un fundido corto de entrada/salida para que no arranque
// ni corte en seco.
//
// El default pasó de -18 a -20 (2026-08-14, pedido del usuario tras escuchar el resultado): la
// voz de ElevenLabs se atenúa -3.4dB por venir saturada (ver elevenlabs.js), así que la música
// quedaba relativamente más alta de lo que se había pensado al elegir el -18 original. Ojo: esta
// ganancia es un ATENUADO DEL ARCHIVO fuente, no una medida contra la voz — el catálogo actual
// está parejo (-12.8 a -16.6 LUFS, medido) así que en la práctica alcanza, pero una pista futura
// masterizada mucho más fuerte volvería a sonar alta con este mismo número.
async function prepararMusica(localPath, offsetInicio, duracionObjetivo, jobId, gananciaDb = -20) {
  const limpio = path.join(TEMP_DIR, `${jobId}_musica_limpia.mp3`);
  const listo = path.join(TEMP_DIR, `${jobId}_musica_lista.m4a`);

  // Paso A: cortar el silencio inicial una sola vez (si offsetInicio es 0, esto es un stream
  // copy trivial). Loopear DESPUÉS de cortar evita la ambigüedad de si -stream_loop respeta
  // -ss en cada vuelta o solo en la primera — cada vuelta parte de un archivo ya limpio.
  await ffmpeg(['-ss', offsetInicio.toFixed(2), '-i', localPath, '-c:a', 'libmp3lame', '-q:a', '4', limpio]);

  const fadeOutInicio = Math.max(0, duracionObjetivo - 1);
  await ffmpeg([
    '-stream_loop', '-1', '-i', limpio,
    '-t', duracionObjetivo.toFixed(3),
    '-af', `volume=${gananciaDb}dB,afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutInicio.toFixed(3)}:d=1`,
    '-c:a', 'aac', '-b:a', '192k',
    listo,
  ]);

  try { fs.unlinkSync(limpio); } catch {}
  return listo;
}

// Encadena TODO el plan con transiciones, pero en TANDAS de TANDA_MAX clips en vez de un solo
// filter_complex gigante (ver TANDA_MAX arriba para el porqué). Cada tanda se renderiza aparte
// con sus transiciones internas; las tandas se pegan entre sí con concat plano — el clip en el
// borde de cada tanda ya se cortó SIN cola de mezcla (esLimiteDeTanda en montarVideoPlan), así
// que no hay nada que perder en esa unión.
async function renderizarPorTandas(segmentos, duracionesVisibles, outPath, opts, jobId) {
  const tandas = [];
  for (let i = 0; i < segmentos.length; i += TANDA_MAX) {
    tandas.push({ segs: segmentos.slice(i, i + TANDA_MAX), durs: duracionesVisibles.slice(i, i + TANDA_MAX) });
  }

  if (tandas.length === 1) {
    return renderizarConTransiciones(tandas[0].segs, tandas[0].durs, outPath, opts);
  }

  console.log(`  🎞️ ${segmentos.length} clips: transiciones en ${tandas.length} tandas de hasta ${TANDA_MAX}`);
  const tandaPaths = [];
  for (let t = 0; t < tandas.length; t++) {
    const tp = path.join(TEMP_DIR, `${jobId}_tanda${t}.mp4`);
    if (tandas[t].segs.length === 1) {
      // Una tanda de 1 no tiene fronteras internas que mezclar (renderizarConTransiciones
      // necesita ≥2 segmentos, su loop no arma la etiqueta [vout] con uno solo).
      fs.copyFileSync(tandas[t].segs[0], tp);
    } else {
      await renderizarConTransiciones(tandas[t].segs, tandas[t].durs, tp, opts);
    }
    tandaPaths.push(tp);
  }

  const listaPath = path.join(TEMP_DIR, `${jobId}_lista_tandas.txt`);
  fs.writeFileSync(listaPath, tandaPaths.map(s => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listaPath, '-c', 'copy', outPath]);

  [...tandaPaths, listaPath].forEach(f => { try { fs.unlinkSync(f); } catch {} });
}

// ---- Montaje v2: por plan de clips + zoom/espejo/subtítulos + transiciones (Fase 7) ----
// plan: [{videoId, offset, duracion}], archivos: {videoId: ruta local}
// efectos: { zoom, zoomPct, espejo, transicion, transicionDur, transicionTipo, subsPath, fuentesDir }
// La suma de duraciones VISIBLES = duración del audio, así que el video calza por construcción
// — las transiciones NO acortan esa suma, solo agregan metraje extra por debajo (ver más abajo).
async function montarVideoPlan(plan, archivos, audioPath, jobId, efectos = {}) {
  const enc = argsEncoder(await detectarEncoder());
  const zoomPreset = efectos.zoom || 'ninguno';
  const espejoPreset = efectos.espejo || 'ninguno';
  const zoomPct = Number.isFinite(efectos.zoomPct) ? efectos.zoomPct : 20;
  const transPreset = efectos.transicion || 'ninguno';
  // Duración de cada transición: acotada 0.1-0.6s — fuera de ese rango deja de leerse como
  // "corte con transición" (muy corta no se ve, muy larga se siente lenta para el ritmo).
  const transDur = Math.min(0.6, Math.max(0.1, Number.isFinite(efectos.transicionDur) ? efectos.transicionDur : 0.35));
  // efectos.transicionTipo puede venir como string ('fade'/'aleatorio') o como ARRAY de tipos
  // elegidos por el usuario para el "aleatorio entre estas" (ver elegirTransicion). Array vacío
  // (nada tildado en la UI) cae a 'aleatorio' — el catálogo completo, comportamiento de siempre.
  const transTipoRaw = efectos.transicionTipo;
  const transTipo = (Array.isArray(transTipoRaw) && transTipoRaw.length === 0) ? 'aleatorio' : (transTipoRaw || 'fade');

  const clipsValidos = plan
    .map((clip, i) => ({ clip, i }))
    .filter(x => x.clip && archivos[x.clip.videoId]);

  const segmentos = [];
  const duracionesVisibles = []; // duración QUE VE el espectador (sin cola de mezcla), mismo orden que segmentos

  // seleccion.js planifica el offset de cada clip contra `v.duracion` (metadata de Drive,
  // videoMediaMetadata.durationMillis) — pero Drive a veces NO la reporta (undefined), y ahí
  // seleccion.js no tiene con qué comprobar que el offset cabe. Si offset+duración se pasa del
  // final real del archivo, `-ss`+`-t` de ffmpeg NO da error: corta silenciosamente un segmento
  // más corto de lo pedido (probado real: pedís 2.65s, si el archivo se acaba en 0.3s desde el
  // offset, el segmento sale de 0.3s, exit code 0). Ese segmento corto rompe después el timeline
  // acumulado de `xfade` (el offset de la transición ya no tiene frames de este input a esa
  // altura) — visto real en producción como "matches no streams" en el xfade Y en el fallback de
  // concat plano (un segmento con muchos menos frames de los que su nombre en la lista promete
  // también lo tira abajo). Acá se re-verifica contra la duración REAL del archivo ya descargado
  // (fuente de verdad, no la metadata de Drive) y si no cabe, se corre el offset hacia atrás —
  // mismo criterio que ya usa seleccion.js para "video muy corto", solo que con datos reales.
  const duracionesReales = {};
  async function duracionRealCacheada(ruta) {
    if (!(ruta in duracionesReales)) {
      duracionesReales[ruta] = await obtenerDuracion(ruta).catch(() => null);
    }
    return duracionesReales[ruta];
  }

  for (let k = 0; k < clipsValidos.length; k++) {
    const { clip, i } = clipsValidos[k];
    const esUltimo = k === clipsValidos.length - 1;
    // Este clip empalma con el siguiente por transición → necesita `transDur` segundos EXTRA
    // de metraje fuente para la cola de mezcla (Fase 7, corrección de solapamiento). Por eso
    // server.js ya bajó CLIP_MAX a CLIP_MAX-transDur al planificar: duracion+padding nunca pasa
    // del límite legal de 3s. Ver comentario largo en renderizarConTransiciones() para el resto.
    const activaTransicion = !esUltimo && transPreset !== 'ninguno' && decidirEfecto(transPreset, k).activo && !esLimiteDeTanda(k);
    const padding = activaTransicion ? transDur : 0;
    const necesita = clip.duracion + padding;

    let offsetEfectivo = clip.offset;
    const durReal = await duracionRealCacheada(archivos[clip.videoId]);
    if (durReal && offsetEfectivo + necesita > durReal) {
      const offsetClamp = Math.max(0, durReal - necesita);
      console.warn(`  ⚠️ Clip ${i}: offset ${offsetEfectivo.toFixed(2)}s + ${necesita.toFixed(2)}s se pasa de la duración real (${durReal.toFixed(2)}s) — corrigiendo offset a ${offsetClamp.toFixed(2)}s`);
      offsetEfectivo = offsetClamp;
    }

    const segPath = path.join(TEMP_DIR, `${jobId}_seg${i}.mp4`);
    const base = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30';
    const filtros = [base];
    const zoomInfo = decidirEfecto(zoomPreset, i);
    if (zoomInfo.activo) filtros.push(filtroZoom(zoomInfo.direccion, zoomPct, clip.duracion));
    if (decidirEfecto(espejoPreset, i).activo) filtros.push('hflip');

    const argsSegmento = (vf) => [
      '-ss', offsetEfectivo.toFixed(2),
      '-i', archivos[clip.videoId],
      '-t', necesita.toFixed(3),
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
    duracionesVisibles.push(clip.duracion);
  }

  if (segmentos.length === 0) {
    throw new Error('Ningún clip del plan tiene video asignado');
  }

  const basePath = path.join(TEMP_DIR, `${jobId}_base.mp4`);
  let listaPath = null;
  const concatPlano = () => {
    listaPath = path.join(TEMP_DIR, `${jobId}_lista.txt`);
    fs.writeFileSync(listaPath, segmentos.map(s => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
    return ffmpeg(['-f', 'concat', '-safe', '0', '-i', listaPath, '-c', 'copy', basePath]);
  };

  const hayTransiciones = transPreset !== 'ninguno' && segmentos.length > 1;
  if (!hayTransiciones) {
    await concatPlano();
  } else {
    try {
      await renderizarPorTandas(segmentos, duracionesVisibles, basePath, { preset: transPreset, duracion: transDur, tipo: transTipo, enc }, jobId);
    } catch (e) {
      // Regla de robustez: si la cadena de xfade falla (tipo de transición no soportado por
      // esta build de ffmpeg, filtergraph rechazado), cae a cortes secos en vez de perder el
      // render. Nota: los segmentos con cola de mezcla ya se cortaron con esos segundos de más;
      // en este fallback el `-t durAudio` del mux final igual deja la duración final EXACTA —
      // el sobrante de metraje se recorta del final, a costa de perder un poco del último clip.
      console.warn(`  ⚠️ [${jobId}] Transiciones fallaron, reintentando con cortes secos: ${e.message}`);
      await concatPlano();
    }
  }

  // Mux con la locución: si el video quedó una pizca corto (redondeos), se congela
  // el último frame hasta 2s; el corte final es exactamente la duración del audio.
  const durAudio = await obtenerDuracion(audioPath);
  const finalPath = path.join(TEMP_DIR, `${jobId}_final.mp4`);
  const tpad = 'tpad=stop_mode=clone:stop_duration=2';
  // Subtítulos (Fase 6): filtro `ass` quemado DESPUÉS del tpad, para que también se vea sobre
  // el frame congelado si el video quedó corto. Si el filtro falla (fuente corrupta, .ass mal
  // formado), no aborta el render: reintenta el mismo mux sin subtítulos — Regla de robustez.
  const filtroSubs = efectos.subsPath
    ? `,ass='${rutaFiltro(efectos.subsPath)}'${efectos.fuentesDir ? `:fontsdir='${rutaFiltro(efectos.fuentesDir)}'` : ''}`
    : '';
  const filtroVideoSinBanner = `${tpad}${filtroSubs}`;

  // Cartel en el frame 0 (pedido del usuario: "que el letrero solo lo ponga en el primer frame,
  // sea cual sea" — para que TikTok, sin API de portada, tome ese fotograma como portada, sin
  // re-codificar el video una segunda vez). Es el PNG que el navegador dibujó y mandó: acá solo
  // se superpone, no se redibuja (ver portada.js para por qué). Entra como una ENTRADA más de
  // ffmpeg, no como valor dentro de un filtro — así no hay rutas que escapar.
  const cartelPath = efectos.cartelPath && fs.existsSync(efectos.cartelPath) ? efectos.cartelPath : null;
  if (efectos.cartelPath && !cartelPath) {
    console.warn(`  ⚠️ [${jobId}] El PNG del cartel no está en disco, el video sale sin él`);
  }

  // Fase 8c: música de fondo (opcional). Se prepara ANTES del mux para no repetir el trabajo
  // en cada reintento de fallback. Si falla la preparación, el video sale igual, sin música.
  let musicaPreparada = null;
  if (efectos.musicaPath) {
    try {
      musicaPreparada = await prepararMusica(efectos.musicaPath, efectos.musicaOffset || 0, durAudio, jobId, efectos.musicaGananciaDb ?? -20);
    } catch (e) {
      console.warn(`  ⚠️ [${jobId}] No se pudo preparar la música, el video sale sin ella: ${e.message}`);
    }
  }

  // amix con normalize=0: normalize=1 (default de ffmpeg) bajaría también la VOZ para que la
  // suma no sature — acá la voz tiene que quedar intacta, la música ya viene atenuada por su
  // propia ganancia fija.
  //
  // El cartel se superpone con `overlay` limitado a `enable='lt(n,1)'` — n es el número de
  // fotograma, así que solo pinta el PRIMERO y nunca se ve durante la reproducción. Va después
  // de los subtítulos para quedar por encima de ellos, igual que antes.
  const argsMux = (filtroV, conMusica, conCartel) => {
    const entradas = ['-i', basePath, '-i', audioPath];
    if (conMusica) entradas.push('-i', musicaPreparada);
    if (conCartel) entradas.push('-i', cartelPath);
    const idxCartel = conMusica ? 3 : 2;

    const cadenaV = conCartel
      ? `[0:v]${filtroV}[vbase];[vbase][${idxCartel}:v]overlay=0:0:enable='lt(n,1)'[vout]`
      : `[0:v]${filtroV}[vout]`;
    const filtro = conMusica
      ? `${cadenaV};[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[afinal]`
      : cadenaV;

    return [
      ...entradas,
      '-filter_complex', filtro,
      '-map', '[vout]', '-map', conMusica ? '[afinal]' : '1:a',
      '-t', durAudio.toFixed(3),
      ...enc, '-c:a', 'aac', '-b:a', '192k',
      finalPath,
    ];
  };

  // Escalones de degradación, más allá de música (arriba): cartel falla → sin cartel;
  // subtítulos fallan → sin subtítulos. Factorizados en helpers porque se llega a ellos desde
  // dos ramas (con y sin música que ya falló antes) — mismo resultado final, sin cuadruplicar
  // el cuerpo. El video siempre sale, degradado capa por capa, nunca se pierde el render
  // completo por un filtro opcional.
  const degradarDesdeCartel = async (mensaje) => {
    console.warn(`  ⚠️ [${jobId}] ${mensaje}`);
    try {
      await ffmpeg(argsMux(filtroVideoSinBanner, false, false));
    } catch (e) {
      if (efectos.subsPath) {
        console.warn(`  ⚠️ [${jobId}] Subtítulos fallaron al quemarse, reintentando sin ellos: ${e.message}`);
        await ffmpeg(argsMux(tpad, false, false));
      } else {
        throw e;
      }
    }
  };
  const degradarDesdeSubs = async (mensaje) => {
    console.warn(`  ⚠️ [${jobId}] ${mensaje}`);
    await ffmpeg(argsMux(tpad, false, false));
  };

  try {
    await ffmpeg(argsMux(filtroVideoSinBanner, Boolean(musicaPreparada), Boolean(cartelPath)));
  } catch (e) {
    if (musicaPreparada) {
      console.warn(`  ⚠️ [${jobId}] Mux con música falló, reintentando sin música: ${e.message}`);
      musicaPreparada = null;
      try {
        await ffmpeg(argsMux(filtroVideoSinBanner, false, Boolean(cartelPath)));
      } catch (e2) {
        if (cartelPath) await degradarDesdeCartel(`Cartel del frame 0 falló al superponerse, reintentando sin él: ${e2.message}`);
        else if (efectos.subsPath) await degradarDesdeSubs(`Subtítulos fallaron al quemarse, reintentando sin ellos: ${e2.message}`);
        else throw e2;
      }
    } else if (cartelPath) {
      await degradarDesdeCartel(`Cartel del frame 0 falló al superponerse, reintentando sin él: ${e.message}`);
    } else if (efectos.subsPath) {
      await degradarDesdeSubs(`Subtítulos fallaron al quemarse, reintentando sin ellos: ${e.message}`);
    } else {
      throw e;
    }
  }

  // El PNG del cartel NO se borra acá: server.js lo conserva junto al preview para reusarlo tal
  // cual en el JPG de portada cuando el usuario elija el fotograma (y lo limpia con él).
  [...segmentos, listaPath, basePath, musicaPreparada].filter(Boolean).forEach(f => {
    try { fs.unlinkSync(f); } catch {}
  });

  return { finalPath, duracion: Math.round(durAudio), clips: segmentos.length, conMusica: Boolean(musicaPreparada) };
}

// Limpiar archivos temporales de un job. NO toca los clips fuente cacheados (src_*.mp4):
// ese caché es compartido entre jobs a propósito (evita redescargar el mismo clip de Drive
// para otro video), y borrarlo aquí corría la carrera de que un job terminando/fallando
// eliminara el clip que OTRO job concurrente acababa de descargar y estaba por leer con
// ffmpeg ("Error opening input file ... No such file or directory"). La limpieza de src_*
// por antigüedad ya la hace limpiarCache() en server.js (TTL de 1h).
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
  TRANSICIONES_DISPONIBLES,
};
