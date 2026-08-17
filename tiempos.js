// Puerta abierta del repo principal (tiempos.js, comentario 2026-08-08): interfaz de "fuente de
// tiempos" intercambiable. Ahí la implementación es ElevenLabs (alineación carácter-por-carácter).
// Acá la implementación es Whisper (transcripcion.js), que da PALABRAS con inicio/fin directo —
// no hace falta la fuzzy-match a nivel de carácter del repo principal, alcanza con matchear
// palabra contra palabra (tolerando que Whisper transcriba con otra tilde/mayúscula/puntuación
// que el guion original, o se salte alguna).
//
// Salida con la MISMA forma que `alinearFragmentos` del repo principal —
// { duraciones: [seg,...], palabras: [[{texto,inicio,fin},...],...] } — para que
// seleccion.tiemposPorFragmento() y subtitulos.generarASS() (ambos portados tal cual) no tengan
// que saber de dónde salió el timing.

// Normaliza para comparar: sin tildes, minúsculas, sin puntuación en los bordes. Letras y eñes
// se preservan (ñ no es diacrítico compuesto, NFD no la toca).
function normalizar(palabra) {
  return palabra
    .replace(/^[\s,.:;!¡?¿"'"«»…\-–—]+|[\s,.:;!¡?¿"'"«»…\-–—]+$/g, '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Cuántas posiciones adelante de Whisper se busca un match para la palabra esperada — tolera que
// Whisper haya insertado o comido una palabra suelta sin perder la sincronía del resto.
const VENTANA_TOLERANCIA = 3;

// fragments: [{texto, famoso, ...}] en orden narrativo (misma lista que arma gemini.fragmentarGuionParrafos)
// palabrasTranscritas: [{texto, inicio, fin}, ...] de transcripcion.transcribirConTimestamps()
// duracionAudioReal: segundos totales del audio (ffprobe)
//
// Nunca lanza: si una palabra no calza dentro de la ventana de tolerancia, devuelve null —
// quien llama cae al reparto por % de caracteres (Regla de robustez del proyecto).
function alinearFragmentosPalabras(fragments, palabrasTranscritas, duracionAudioReal) {
  if (!Array.isArray(palabrasTranscritas) || palabrasTranscritas.length === 0) return null;
  if (!Array.isArray(fragments) || fragments.length === 0) return null;

  let cursor = 0;
  const plano = []; // { texto, inicio, fragIdx }
  for (let fi = 0; fi < fragments.length; fi++) {
    const palabras = (fragments[fi].texto || '').split(/\s+/).filter(Boolean);
    if (palabras.length === 0) {
      console.warn(`  ⚠️ Whisper: fragmento ${fi} sin palabras, cae a % de caracteres`);
      return null;
    }
    for (const palabra of palabras) {
      const norm = normalizar(palabra);
      let hallado = -1;
      for (let k = 0; k < VENTANA_TOLERANCIA && cursor + k < palabrasTranscritas.length; k++) {
        if (normalizar(palabrasTranscritas[cursor + k].texto) === norm) { hallado = cursor + k; break; }
      }
      if (hallado === -1) {
        console.warn(`  ⚠️ Whisper: "${palabra}" (fragmento ${fi}) no calza con la transcripción, cae a % de caracteres`);
        return null;
      }
      plano.push({ texto: palabra, inicio: palabrasTranscritas[hallado].inicio, fragIdx: fi });
      cursor = hallado + 1;
    }
  }

  // Telescopar: cada palabra dura hasta que empieza la SIGUIENTE en toda la locución (mismo
  // esquema que el repo principal) — sin huecos ni superposición, la suma siempre calza.
  const conFin = plano.map((w, idx) => ({
    texto: w.texto,
    inicio: w.inicio,
    fin: idx + 1 < plano.length ? plano[idx + 1].inicio : duracionAudioReal,
    fragIdx: w.fragIdx,
  }));

  const palabrasPorFragmento = fragments.map((_, fi) =>
    conFin.filter(w => w.fragIdx === fi).map(({ texto, inicio, fin }) => ({ texto, inicio, fin })));

  const inicioPorFragmento = fragments.map((_, fi) => {
    const primero = conFin.find(w => w.fragIdx === fi);
    return primero ? primero.inicio : null;
  });
  if (inicioPorFragmento.some(v => v === null)) {
    console.warn('  ⚠️ Whisper: algún fragmento quedó sin palabras alineadas, cae a % de caracteres');
    return null;
  }

  const duraciones = fragments.map((_, idx) => {
    const inicioTramo = idx === 0 ? 0 : inicioPorFragmento[idx];
    const finTramo = idx + 1 < inicioPorFragmento.length ? inicioPorFragmento[idx + 1] : duracionAudioReal;
    return finTramo - inicioTramo;
  });

  if (duraciones.some(d => d <= 0)) {
    console.warn('  ⚠️ Whisper: algún fragmento salió con duración ≤0, cae a % de caracteres');
    return null;
  }

  return { duraciones, palabras: palabrasPorFragmento };
}

module.exports = { alinearFragmentosPalabras };
