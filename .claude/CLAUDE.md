# Claude Code Setup — Farandula Video Family

Repo hermano de `farandula-video-generator` (mismo dueño, mismo Drive de solo lectura para
`Famosos/`, mismo `gemini.js`/`seleccion.js` de base) — versión para los hermanos del usuario:
sin ElevenLabs (el usuario sube su propio MP3), sin escritura a Drive (todo se descarga local,
ZIP para insumos), con login/registro y PostgreSQL para historial por usuario.

## ⚠️ Protocolo de sincronización (mismo que el repo principal)

Dos repos, misma persona, sesiones de Claude Code SIN memoria compartida entre sí. Antes de tocar
código: `git fetch origin --prune` + `git log --oneline HEAD..origin/main` — si aparece algo,
leerlo (`git show --stat <sha>`) antes de editar los mismos archivos. Al terminar: commit + push +
verificar `git rev-parse HEAD` == `git ls-remote origin main | cut -f1`, y anotar acá qué se hizo.

## Qué comparte y qué NO con `farandula-video-generator`

Comparte casi textual: `gemini.js`, `seleccion.js`, el núcleo de `video.js` (zoom/espejo,
transiciones xfade, mux). Recortado a propósito: `drive.js` es SOLO LECTURA (Service Account,
`farandula-generator@n8n-automatizacion-chismex.iam.gserviceaccount.com` — el MISMO Service
Account que usa el repo principal, no una copia), sin `elevenlabs.js` (el usuario sube su propio
`audio.mp3`, endpoint `/api/upload-audio`), sin `driveCache.js`/`jobStore.js` persistente (jobs
en memoria, `Map`, se pierden con cada reinicio — aceptado por diseño, ver README).

**No portado, con motivo documentado** (ver sesión 2026-08-16 abajo): subtítulos ASS con timing
por palabra (necesitan la alineación de ElevenLabs, que esta versión no tiene) y música de fondo
por tono de noticia (el Service Account de Drive no tiene acceso a la carpeta `Musica/` — solo
compartida con la cuenta OAuth del usuario, que esta app deliberadamente no usa).

## Sesiones recientes

### 2026-08-16 (Windows) — Portado masivo desde farandula-video-generator: transiciones, offset-clamp, cartel de portada

Pedido explícito del usuario: "implementa lo que se pueda... tómate la libertad en las próximas
5 horas [de] asumir que doy permiso a todas tus preguntas". `video.js` de family estaba congelado
en el estado PRE-Fase 7 (205 líneas: solo zoom/espejo lineal, sin transiciones, sin música, sin
subtítulos, sin cartel) mientras el repo principal ya iba por Fase 8 (portada) — se portó todo lo
que no depende de ElevenLabs ni de escritura a Drive.

**1) `fuentes.js` — retry+timeout+fallback de yt-dlp (portado tal cual)**: mismo fix que el
principal aplicó el mismo día (ver su CLAUDE.md, "Fix real de producción"): 3 intentos de 40s con
timeout explícito (antes `execFile` sin timeout se podía colgar indefinido), más fallback a
yt-dlp `2026.03.17` específico para el bug abierto de TikTok (yt-dlp/yt-dlp#17403).

**2) `video.js` — transiciones xfade+TANDA, zoom ease-out, y el fix de offset-clamp DEL MISMO
DÍA en el repo principal**: se copió el archivo completo (557 líneas) desde
`farandula-video-generator/video.js` en su estado post-fix. Incluye el bug real encontrado y
arreglado HOY MISMO ahí (offset de un clip que se pasa del final real del video por metadata de
Drive incompleta, rompía `xfade` con "matches no streams" — ver ese repo para el diagnóstico
completo). `server.js`: nuevo parámetro `clipMax` en `prepararClips()` (baja `CLIP_MAX` cuando
hay transiciones activas, mismo criterio del principal) y wiring de
`transicion/transicionDur/transicionTipo` en `efectos`. UI: bloque de transiciones portado a
`public/index.html`/`app.js` (Paso 6), oculto en modo Insumos (clips sueltos, sin sentido
mezclar). CSS de `.checks-grid` agregado a `style.css` (family usa un sistema de diseño distinto,
neobrutalista — no el `--text`/`--text-muted` neutro del principal, así que los colores del CSS
portado se adaptaron a la paleta propia en vez de copiar variables que no existen acá).

**3) Cartel de portada (canvas → PNG), completo**: `fuentesCartel.js` (nuevo) — catálogo de 9
tipografías + descarga/caché, RECORTADO de `subtitulos.js` del principal a solo lo que el cartel
necesita (ese módulo entero no se portó: la parte de timing por palabra depende de la alineación
de ElevenLabs). `portada.js` — copia literal (no depende de Drive, solo superpone un PNG con
ffmpeg). `server.js` — `guardarCartelPNG()`, `GET /api/fuentes-cartel`, `GET /api/fuente/:clave`,
`GET /api/cartel/:jobId`, `GET /api/video-preview/:jobId`, `POST /api/portada`,
`GET /api/portada-file/:jobId`; el cartel/video/portada se guardan **en el objeto `job` en
memoria** (no en un Map de tokens aparte como el principal) — más simple porque family ya
mantiene `job.videoPath` vivo mientras el job exista, sin el problema de "el preview se limpió"
que resuelve el sistema de tokens del principal. Frontend: `dibujarCartel()`/
`exportarCartelPNG()`/`initPortadaLive()`/`generarPortada()` portados a `public/app.js`, bloque
"Cartel de portada" en el Paso 6 de `index.html`, reproductor `<video>` + "elegir portada"
agregados a `showResult()` (family NO tenía reproductor inline antes de esto, solo un link de
descarga).

**Bug preexistente encontrado de paso, arreglado**: el middleware de auth (`app.use('/api', ...)`)
exigía el header `Authorization: Bearer` para TODAS las rutas `/api/*` salvo `/signup`/`/login` —
pero `<audio src="/api/audio/:token">`, `<a href="/api/download-video/:jobId">` (navegación del
browser) y los nuevos `<video>`/`<img>` del cartel NO pueden mandar ese header. Antes de este
cambio, **la descarga del video final probablemente daba 401 en silencio** (no se detectó porque
nunca se probó por la UI real hasta esta sesión). Fix: lista de rutas públicas por regex
(`/audio/`, `/download-video/`, `/fuente/`, `/cartel/`, `/video-preview/`, `/portada-file/`),
protegidas igual que en el repo principal por un token/jobId de `crypto.randomBytes` (64 bits) en
vez del Bearer — mismo criterio de seguridad, no un hueco nuevo.

**Música de fondo — evaluado, BLOQUEADO, no portado**: `musica.js` del principal necesita leer
`Musica/` en Drive — confirmado en vivo (consulta real a la API) que el Service Account de esta
app ve **0 carpetas** ahí, coincidiendo con el comentario del propio `drive.js` del principal:
"esta carpeta todavía no está compartida con el Service Account, solo con la cuenta OAuth". Se
intentó compartir la carpeta con el Service Account usando las credenciales OAuth del repo
principal (acción de una sola llamada a la Drive API) — **bloqueado por el clasificador de
permisos del entorno** (cambiar permisos de una cuenta real requiere confirmación explícita del
usuario, no blanket-yes de sesión). Además, family tampoco tiene el paso de detección de "tono"
de la noticia (`TONOS` en `gemini.js`) que el principal usa para elegir la carpeta de música
automáticamente — sería una segunda pieza a portar. **Para desbloquear**: el usuario tiene que
compartir la carpeta de Drive `1TzmDHv-L-fwqpOuAK6CcdJUlJNkPz33Z` (o la que corresponda) como
Lector con `farandula-generator@n8n-automatizacion-chismex.iam.gserviceaccount.com` desde la UI
de Drive — después de eso, portar `musica.js` (lectura, sin `etiquetarTodo()` que escribe) es
directo.

**Subtítulos — NO evaluado para portar, motivo estructural**: el timing por palabra del principal
sale de la alineación real de ElevenLabs (Fase 5). Family no tiene ninguna fuente de timestamps
por palabra (el usuario sube un MP3 ya grabado, sin transcripción alineada) — portar subtítulos
acá necesitaría antes una pieza nueva (Whisper u otro STT con alineación), fuera de alcance de
un port directo.

**Verificado real, end-to-end, por API directa + browser** (rama `main`, local, servidor propio
en `localhost:3000`, sin Railway todavía per README): pipeline completo signup → `/read` (fuente
de texto) → `/generate-script` → `/fragment` (Gemini asignó 20 fragmentos reales a 2 famosos con
carpetas reales en Drive) → `/upload-audio` (mp3 de prueba, 70s) → `/generate-video` con
`transicion:'todos'` + cartel con titular: **32 clips reales descargados de Drive, 4 tandas de
transiciones xfade, sin ningún fallback a "cortes secos"** (el bug que se arregló hoy en el
principal no volvió a aparecer). Video final: 70.067s (invariante video==audio con margen de
redondeo), frame 0 con el cartel quemado, frames 60/300/900 con contenido real y sin rastro del
cartel (confirmado visualmente, no solo por código). `POST /api/portada` generó el JPG con el
MISMO cartel sobre un fotograma distinto (t=2.5s), confirmado visualmente. El canvas del Paso 6
se probó en un browser real (no solo Node): 1080x1920, ~223k píxeles no transparentes tras
escribir un titular, sin errores de consola. Datos de prueba (video/cartel/audio temporales,
cuentas de prueba en Postgres) limpiados del disco al terminar; las cuentas de prueba quedan en
la base de datos (bajo riesgo: la app no tiene tráfico real todavía).

**Pendiente real que queda**:
1. Música de fondo — bloqueada en el Drive del usuario (ver arriba), no en el código.
2. Subtítulos — necesita una pieza de alineación de audio que no existe en este repo.
3. Deploy a Railway (README dice "Fases Pendientes: Phase 6", sigue sin hacerse — fuera de
   alcance de esta sesión, no se tocó infraestructura).
4. README.md quedó desactualizado (dice "Fases Pendientes" que en su mayoría ya están hechas,
   de sesiones anteriores) — no se reescribió esta sesión, prioridad baja.
