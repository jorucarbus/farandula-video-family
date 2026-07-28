const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const FAMOSOS_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

let drive = null;

// Cliente Service Account, SOLO LECTURA. Reusa el mismo acceso de solo lectura que la
// app principal ya tiene sobre la carpeta compartida "Famosos/" (clips fuente por celebridad).
// Esta app NUNCA escribe a Drive (sin OAuth, sin subir nada).
function getDrive() {
  if (!drive) {
    const opciones = { scopes: ['https://www.googleapis.com/auth/drive.readonly'] };
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      opciones.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } else {
      opciones.keyFile = path.join(__dirname, 'credentials.json');
    }
    drive = google.drive({ version: 'v3', auth: new google.auth.GoogleAuth(opciones) });
  }
  return drive;
}

// Mapa {nombreCelebridad: folderId} de las subcarpetas bajo Famosos/
async function obtenerCarpetasFamosos() {
  const cliente = getDrive();
  const res = await cliente.files.list({
    q: `'${FAMOSOS_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 200,
  });
  const mapa = {};
  (res.data.files || []).forEach(f => { mapa[f.name] = f.id; });
  return mapa;
}

// Lista de clips (con duración si está disponible) dentro de la carpeta de una celebridad
async function listarVideos(folderId) {
  const cliente = getDrive();
  const res = await cliente.files.list({
    q: `'${folderId}' in parents and mimeType contains 'video/' and trashed=false`,
    fields: 'files(id, name, videoMediaMetadata(durationMillis))',
    pageSize: 200,
  });
  return (res.data.files || []).map(f => ({
    id: f.id,
    name: f.name,
    duracion: f.videoMediaMetadata ? Number(f.videoMediaMetadata.durationMillis) / 1000 : null,
  }));
}

// Descarga un clip a disco local (cachea por fileId, no vuelve a bajar si ya existe)
async function descargarVideo(fileId, destDir) {
  const destPath = path.join(destDir, `src_${fileId}.mp4`);
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    return destPath;
  }
  fs.mkdirSync(destDir, { recursive: true });
  const cliente = getDrive();
  const res = await cliente.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(destPath);
    res.data.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
    res.data.on('error', reject);
  });
  return destPath;
}

module.exports = {
  obtenerCarpetasFamosos,
  listarVideos,
  descargarVideo,
};
