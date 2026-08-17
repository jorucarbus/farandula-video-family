// Catálogo de tipografías para el cartel de portada — portado de farandula-video-generator
// (subtitulos.js), recortado a SOLO lo que el cartel necesita: la lista de fuentes y su
// descarga/caché. Ese repo usa el mismo catálogo también para quemar subtítulos con timing por
// palabra (necesita la alineación de ElevenLabs, que esta versión no tiene) — acá NO se porta esa
// parte, solo el cartel de portada, que no depende de timing alguno.
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TEMP_DIR = path.join(__dirname, 'temp-videos');
const FUENTES_DIR = path.join(TEMP_DIR, 'fuentes');

// Mismo catálogo que el repo principal — todas Google Fonts (OFL/Apache, uso libre), todas
// verificadas reales (descarga + quemado con ffmpeg, no solo la URL).
const FUENTES = {
  anton:     { familia: 'Anton',             archivo: 'Anton-Regular.ttf' },
  poppins:   { familia: 'Poppins ExtraBold', archivo: 'Poppins-ExtraBold.ttf' },
  bebas:     { familia: 'Bebas Neue',        archivo: 'BebasNeue-Regular.ttf' },
  archivo:   { familia: 'Archivo Black',     archivo: 'ArchivoBlack-Regular.ttf' },
  bangers:   { familia: 'Bangers',           archivo: 'Bangers-Regular.ttf' },
  righteous: { familia: 'Righteous',         archivo: 'Righteous-Regular.ttf' },
  passion:   { familia: 'Passion One',       archivo: 'PassionOne-Black.ttf' },
  kanit:     { familia: 'Kanit ExtraBold',   archivo: 'Kanit-ExtraBold.ttf' },
  luckiest:  { familia: 'Luckiest Guy',      archivo: 'LuckiestGuy-Regular.ttf' },
};
const URLS = {
  anton: 'https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf',
  poppins: 'https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-ExtraBold.ttf',
  bebas: 'https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf',
  archivo: 'https://raw.githubusercontent.com/google/fonts/main/ofl/archivoblack/ArchivoBlack-Regular.ttf',
  bangers: 'https://raw.githubusercontent.com/google/fonts/main/ofl/bangers/Bangers-Regular.ttf',
  righteous: 'https://raw.githubusercontent.com/google/fonts/main/ofl/righteous/Righteous-Regular.ttf',
  passion: 'https://raw.githubusercontent.com/google/fonts/main/ofl/passionone/PassionOne-Black.ttf',
  kanit: 'https://raw.githubusercontent.com/google/fonts/main/ofl/kanit/Kanit-ExtraBold.ttf',
  luckiest: 'https://raw.githubusercontent.com/google/fonts/main/apache/luckiestguy/LuckiestGuy-Regular.ttf',
};
const FUENTE_DEFAULT = 'anton';

// Descarga UNA tipografía del catálogo (cache en disco, sobrevive entre renders del mismo
// proceso). Si falla (sin internet, URL cambiada), no aborta: devuelve null y el cartel avisa en
// pantalla en vez de hornear una letra de reemplazo en silencio (ver GET /api/fuente/:clave).
async function obtenerCarpetaFuentes(clave = FUENTE_DEFAULT) {
  const fuente = FUENTES[clave] || FUENTES[FUENTE_DEFAULT];
  const url = URLS[clave] || URLS[FUENTE_DEFAULT];
  try {
    fs.mkdirSync(FUENTES_DIR, { recursive: true });
    const destino = path.join(FUENTES_DIR, fuente.archivo);
    if (!fs.existsSync(destino) || fs.statSync(destino).size < 10000) {
      console.log(`  🔤 Descargando tipografía "${fuente.familia}" (una sola vez)...`);
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
      fs.writeFileSync(destino, res.data);
    }
    return FUENTES_DIR;
  } catch (e) {
    console.warn(`  ⚠️ No se pudo descargar la tipografía "${fuente.familia}" (${e.message})`);
    return null;
  }
}

module.exports = { FUENTES, FUENTE_DEFAULT, obtenerCarpetaFuentes };
