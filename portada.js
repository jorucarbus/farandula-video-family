// Portada (miniatura) — pedido del usuario: "escoger un fotograma y poner un titular", con el
// look de credibilidad de farándula (caja sólida redondeada de color, texto en negrita encima).
// TikTok no expone API para fijar la portada al publicar, así que además de quemar el cartel en el
// frame 0 del video (ver video.js), esto genera un JPG aparte para subirlo a mano si hace falta.
//
// EL CARTEL NO SE DIBUJA ACÁ. Lo dibuja el navegador en un <canvas> de 1080x1920 (ver
// `dibujarCartel()` en public/app.js) y manda el PNG ya rasterizado; este módulo solo lo
// superpone. Antes el cartel se dibujaba dos veces —acá con el filtro `ass` de libass, y en el
// navegador con una aproximación en CSS para la vista previa— replicando a mano las mismas
// fórmulas de geometría en los dos lados. Siempre terminaban difiriendo: el usuario reportó una
// previa con saltos de línea y ancho de caja distintos a los del video final. La causa de fondo
// era que ambos ESTIMABAN el ancho del texto con un factor promedio por tipografía en vez de
// medirlo, y una diferencia de un carácter por línea cambia el corte, el tamaño de letra elegido
// y el ancho de la caja en cascada. Con un solo dibujo compartido eso no puede volver a pasar:
// la previa, el frame 0 y el JPG son literalmente el mismo archivo.
//
// Efecto colateral bienvenido: el servidor ya no necesita la tipografía instalada para el cartel
// (el texto viene rasterizado), y desaparece el escapado de rutas para el filtro — el PNG entra
// como una entrada más de ffmpeg (`-i`), no como un valor dentro de un filtro.
const path = require('path');
const { ffmpeg, TEMP_DIR } = require('./video');

// videoPath: mp4 fuente (el preview que sobrevive a la limpieza de temporales, ver server.js).
// timestamp: segundos dentro del video, el fotograma que el usuario eligió pausando el player.
// cartelPath: PNG del cartel (el MISMO que se quemó en el frame 0 — server.js lo guarda junto al
//   preview y lo pasa tal cual; nunca se re-dibuja ni se re-edita).
// token: identifica el archivo de salida.
async function generarPortada(videoPath, timestamp, cartelPath, token) {
  const outPath = path.join(TEMP_DIR, `portada_${token}.jpg`);
  await ffmpeg([
    '-ss', Math.max(0, timestamp).toFixed(2),
    '-i', videoPath,
    '-i', cartelPath,
    '-filter_complex', '[0:v][1:v]overlay=0:0[vout]',
    '-map', '[vout]',
    '-frames:v', '1',
    '-q:v', '2',
    outPath,
  ]);
  return outPath;
}

module.exports = { generarPortada };
