// Planificación de clips v2: tiempo por porcentaje de caracteres + rotación aleatoria sin repetir
//
// Reglas:
// - El tiempo de cada párrafo = duración del audio × (caracteres del párrafo / caracteres totales).
// - Ningún clip supera CLIP_MAX segundos: un párrafo largo se reparte en varias tomas iguales.
// - Por famoso: no se repite video hasta agotar TODOS los de su carpeta (ciclo en historial.json).
// - El orden es aleatorio y distinto a la secuencia del render anterior.
// - Máximo 1 fragmento por video en un render; si no alcanzan los videos, se repite con otro
//   offset y las repeticiones quedan lo más separadas posible.
// - Loop de TikTok: el primer y último clip del video final nunca salen del mismo video fuente.
const fs = require('fs');
const path = require('path');

const HISTORIAL_FILE = path.join(__dirname, 'historial.json');
// CLIP_MAX es un LÍMITE LEGAL, no estético: ningún clip de material ajeno puede pasar de 3
// segundos (uso legítimo). No subirlo sin decisión explícita del usuario, y al agregar capas
// nuevas de edición verificar que no lo rompan por un costado (p. ej. la cola extra que
// necesita un `xfade` haría leer CLIP_MAX + duración-de-transición segundos continuos).
const CLIP_MAX = 3;
// Piso de duración: por debajo de esto un clip se percibe como parpadeo, no como toma. Al
// fragmentar por cambio de sujeto aparecen fragmentos muy cortos ("Y Piqué calló."), así que
// hace falta la guarda. Solo se fusiona con un vecino DEL MISMO FAMOSO: un clip corto del
// famoso correcto es mejor que uno largo del equivocado, que es justo el bug que se arregló.
const CLIP_MIN = 0.7;
const RECORTE_INICIAL = 1; // segundos descartados al inicio de cada video fuente

function cargarHistorial() {
  try { return JSON.parse(fs.readFileSync(HISTORIAL_FILE, 'utf8')); } catch { return {}; }
}

function guardarHistorial(h) {
  fs.writeFileSync(HISTORIAL_FILE, JSON.stringify(h, null, 2));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Reparte la duración de un párrafo en tomas de ≤ CLIP_MAX segundos, todas iguales.
// Ej: 7s → 3 tomas de 2.33s (mejor 2 cortas que una toma alargada).
function repartirTomas(duracion) {
  const n = Math.max(1, Math.ceil(duracion / CLIP_MAX));
  return Array(n).fill(duracion / n);
}

// Agrupa fragmentos consecutivos en BLOQUES de clip, fusionando los que quedarían por debajo de
// CLIP_MIN con un vecino del mismo famoso. El texto de los fragmentos no se toca: lo que se
// fusiona es el corte visual, no la asignación.
//
// La suma de tiempos se conserva exactamente (cada tiempo cae en un bloque y solo uno), así que
// la invariante "duración del video == duración del audio" sigue en pie. Y CLIP_MAX tampoco
// corre riesgo: repartirTomas() parte después cualquier bloque que supere los 3 segundos.
//
// Devuelve: [{famoso, tiempo, indices: [idxParrafo, ...]}]
function agruparParaClips(parrafos, tiempos) {
  const bloques = [];
  parrafos.forEach((p, idx) => {
    const previo = bloques[bloques.length - 1];
    const mismoFamoso = previo && previo.famoso === p.famoso;
    // Fusionar si el nuevo es muy corto, o si el bloque previo se quedó corto y este lo puede
    // completar. Sin la segunda condición, un fragmento corto que abre bloque (porque su
    // anterior era de otro famoso) se quedaría corto para siempre.
    const hayQueFusionar = mismoFamoso && (tiempos[idx] < CLIP_MIN || previo.tiempo < CLIP_MIN);
    if (hayQueFusionar) {
      previo.tiempo += tiempos[idx];
      previo.indices.push(idx);
    } else {
      bloques.push({ famoso: p.famoso, tiempo: tiempos[idx], indices: [idx] });
    }
  });
  return bloques;
}

// parrafos: [{texto, famoso, caracteres}] en orden narrativo
// duracionAudio: segundos reales de la locución (ffprobe)
// inventario: {famoso: [{id, name, duracion|null}]}
// Devuelve: [{videoId, nombre, famoso, offset, duracion, parrafoIdx}] en orden de línea de tiempo
function planificarClips(parrafos, duracionAudio, inventario) {
  const historial = cargarHistorial();
  const totalChars = parrafos.reduce((s, p) => s + p.caracteres, 0);
  if (!totalChars) throw new Error('Párrafos sin caracteres');

  // 1. Línea de tiempo: cada párrafo → su tiempo → agrupar los muy cortos → sus tomas
  const tiempos = parrafos.map(p => duracionAudio * (p.caracteres / totalChars));
  const bloques = agruparParaClips(parrafos, tiempos);
  const fusionados = parrafos.length - bloques.length;
  if (fusionados > 0) {
    console.log(`  🔗 ${fusionados} fragmento(s) bajo ${CLIP_MIN}s fusionados con su vecino del mismo famoso`);
  }

  const requerimientos = [];
  for (const bloque of bloques) {
    for (const dur of repartirTomas(bloque.tiempo)) {
      requerimientos.push({ famoso: bloque.famoso, dur, parrafoIdx: bloque.indices[0] });
    }
  }

  // 2. Selección de videos por famoso (rotación sin repetir + secuencia nueva)
  const colas = {}; // famoso -> cola de videos elegidos (uno por toma requerida)
  const cuentaTomas = {};
  for (const r of requerimientos) cuentaTomas[r.famoso] = (cuentaTomas[r.famoso] || 0) + 1;

  for (const [famoso, cantidad] of Object.entries(cuentaTomas)) {
    const videos = inventario[famoso] || [];
    if (videos.length === 0) {
      console.warn(`  ⚠️ Sin videos para ${famoso}`);
      colas[famoso] = Array(cantidad).fill(null);
      continue;
    }

    const h = (historial[famoso] ??= { ciclo: [], ultimaSecuencia: [], offsets: {} });

    // Prioridad: videos aún no usados en el ciclo actual; luego los ya usados (barajados aparte)
    const frescos = shuffle(videos.filter(v => !h.ciclo.includes(v.id)));
    const gastados = shuffle(videos.filter(v => h.ciclo.includes(v.id)));
    let orden = [...frescos, ...gastados];

    // No repetir la secuencia del render anterior (si hay más de un video posible)
    const propuesta = () => orden.slice(0, Math.min(cantidad, orden.length)).map(v => v.id).join(',');
    let intentos = 0;
    while (videos.length > 1 && propuesta() === h.ultimaSecuencia.join(',') && intentos < 10) {
      orden = shuffle(orden);
      intentos++;
    }

    // 1 toma por video hasta agotar; si faltan videos, repartir con módulo (repeticiones separadas)
    const cola = [];
    for (let i = 0; i < cantidad; i++) cola.push(orden[i % orden.length]);
    colas[famoso] = cola;

    // Actualizar ciclo e historial de secuencia
    for (const v of cola) if (v && !h.ciclo.includes(v.id)) h.ciclo.push(v.id);
    if (h.ciclo.length >= videos.length) h.ciclo = []; // carpeta agotada: reiniciar ciclo
    h.ultimaSecuencia = cola.filter(Boolean).map(v => v.id);
  }

  // 3. Armar el plan con offsets (continuar donde quedó cada video, sin pasarse de su duración)
  const plan = [];
  const consumo = {}; // videoId -> segundos ya consumidos (arranca del historial)
  for (const r of requerimientos) {
    const v = colas[r.famoso].shift();
    if (!v) { plan.push(null); continue; }

    const h = historial[r.famoso];
    if (!(v.id in consumo)) consumo[v.id] = h.offsets[v.id] || 0;

    let offset = RECORTE_INICIAL + consumo[v.id];
    if (v.duracion && offset + r.dur > v.duracion) {
      // No cabe donde iba: reiniciar desde el inicio del video
      consumo[v.id] = 0;
      offset = RECORTE_INICIAL;
      if (offset + r.dur > v.duracion) offset = 0; // video muy corto: usar desde el segundo 0
    }
    consumo[v.id] += r.dur;
    h.offsets[v.id] = Math.round(consumo[v.id] * 100) / 100;

    plan.push({
      videoId: v.id,
      nombre: v.name,
      famoso: r.famoso,
      offset: Math.round(offset * 100) / 100,
      duracion: Math.round(r.dur * 1000) / 1000,
      parrafoIdx: r.parrafoIdx,
    });
  }

  // 4. Loop de TikTok: primer y último clip no pueden salir del mismo video fuente
  const validos = plan.filter(Boolean);
  if (validos.length > 2) {
    const primero = validos[0];
    const ultimo = validos[validos.length - 1];
    if (primero.videoId === ultimo.videoId) {
      // Buscar un clip intermedio de otro video del MISMO famoso que el último, e intercambiar
      for (let i = validos.length - 2; i > 0; i--) {
        if (validos[i].famoso === ultimo.famoso && validos[i].videoId !== ultimo.videoId) {
          const iPlan = plan.indexOf(validos[i]);
          const iUlt = plan.indexOf(ultimo);
          // Intercambiar solo la fuente (video/offset), conservando duración y párrafo del lugar
          [plan[iPlan].videoId, plan[iUlt].videoId] = [plan[iUlt].videoId, plan[iPlan].videoId];
          [plan[iPlan].nombre, plan[iUlt].nombre] = [plan[iUlt].nombre, plan[iPlan].nombre];
          [plan[iPlan].offset, plan[iUlt].offset] = [plan[iUlt].offset, plan[iPlan].offset];
          break;
        }
      }
    }
  }

  guardarHistorial(historial);
  return plan;
}

module.exports = { planificarClips, repartirTomas, agruparParaClips, CLIP_MAX, CLIP_MIN, RECORTE_INICIAL };
