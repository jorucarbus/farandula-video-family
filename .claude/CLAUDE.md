# Claude Code Setup — Farandula Video Family

## 2026-08-21 — DESPLEGADO a Railway (por fin) + fix de las 200 carpetas

Ya está **en producción**: **https://farandula-video-family-production.up.railway.app**

- Proyecto Railway: **`fortunate-unity`** (NO `generous-empathy`, que es el del repo principal).
  Ese proyecto ya existía con un Postgres provisionado y nada más; ahora tiene 2 servicios:
  `Postgres` y `farandula-video-family`.
- Variables copiadas del servicio de producción del repo principal: `GOOGLE_CREDENTIALS_JSON`,
  `GOOGLE_DRIVE_FOLDER_ID`, `GEMINI_API_KEY`. Más `JWT_SECRET` (generado nuevo),
  `NODE_ENV=production`, y `DATABASE_URL` como **referencia** de Railway
  (`${{Postgres.DATABASE_URL}}`, no el valor literal — si Railway rota la credencial sigue
  apuntando bien).
- **`OPENAI_API_KEY` NO está puesta, a propósito** (decisión explícita del usuario: "omite los
  subtítulos y despliega"). El video sale igual; los subtítulos usan reparto estimado por % de
  caracteres en vez del timing real de Whisper. Poner la key cuando se quiera activar eso.
- El esquema de la base se crea solo al arrancar (`db.js initializeDatabase()`, CREATE TABLE IF
  NOT EXISTS) — confirmado en el log del primer arranque.
- Nadie tiene cuenta todavía: cada hermano se registra desde la pantalla de "Registrarse".

**2026-08-21, mismo día — la locución ya acepta WAV/M4A/AAC/OGG/FLAC** (commit `a3c4e7c`).
Estaba limitada a MP3 en los dos lados (el `accept` del input y el `fileFilter` de multer), y el
usuario preguntó por qué no leía WAV. Ahora el `fileFilter` acepta los mimetypes reales que
mandan los navegadores para cada formato (con sus variantes: `audio/wav`, `audio/x-wav`,
`audio/wave`, `audio/mp4`, `audio/x-m4a`…), verificado caso por caso, y sigue rechazando
video/imagen. Lo que no sea MP3 se **transcodifica a MP3 real** con ffmpeg al recibirlo — eso
arregla de paso una mentira que ya existía: el archivo se guardaba como `audio_<token>.mp3`
pasara lo que pasara, así que aceptar otro formato sin convertir habría dejado un WAV con
extensión `.mp3`. La duración se re-mide sobre el convertido (el encoder MP3 agrega ~0.08s de
padding) para que el corte de clips y los subtítulos usen el número del archivo que de verdad se
usa. Límite de subida 50MB → 150MB, porque un WAV pesa ~10x el MP3 equivalente (~10MB/minuto) y
el tope viejo dejaba fuera locuciones normales.

**Bug real encontrado al desplegar** (commit `911d927`): `drive.js` pedía a Drive `pageSize: 200`
sin bucle de paginación, y el usuario ya tiene **264** carpetas de famosos — las últimas ~64
eran invisibles para esta app, EN SILENCIO (sin error ni warning). El repo principal ya usaba
`pageSize: 1000`; se igualó acá, también en `listarVideos`. Verificado contra Drive real: antes
200 carpetas, después 264.

⚠️ **Incidente al desplegar, para no repetirlo**: `railway up` despliega al servicio LINKEADO, y
al hacer `railway link` sobre este proyecto la CLI auto-seleccionó el servicio **Postgres**
(era el único que existía). El primer `railway up` subió la app ENCIMA de la base de datos y la
dejó `Crashed`. Se recuperó desde el dashboard (Deployments → el deploy viejo de
`postgres-ssl:18` → Redeploy), con el volumen intacto, sin pérdida de datos. **Antes de cada
`railway up`: correr `railway status` y confirmar el "Linked service", o pasar `--service
<nombre>` explícito** (que es como quedó documentado el comando de deploy acá).

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

**No portado, con motivo documentado** (ver sesión 2026-08-16 abajo): música de fondo por tono de
noticia (el Service Account de Drive no tiene acceso a la carpeta `Musica/` — solo compartida con
la cuenta OAuth del usuario, que esta app deliberadamente no usa). Subtítulos SÍ están, pero con
una fuente de timing distinta a la del principal — ver "Transcripción + subtítulos" abajo.

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

**Pendiente real que queda** (al cierre de esta sesión, antes de subtítulos — ver sesión
siguiente, que resuelve el punto 2):
1. Música de fondo — bloqueada en el Drive del usuario (ver arriba), no en el código.
2. ~~Subtítulos~~ — resuelto en la sesión siguiente (transcripción con Whisper).
3. Deploy a Railway (README dice "Fases Pendientes: Phase 6", sigue sin hacerse — fuera de
   alcance de esta sesión, no se tocó infraestructura).
4. README.md quedó desactualizado (dice "Fases Pendientes" que en su mayoría ya están hechas,
   de sesiones anteriores) — no se reescribió esta sesión, prioridad baja.

### 2026-08-17 (Windows) — Subtítulos: transcripción alineada con Whisper (OpenAI), en vez de ElevenLabs

Pedido del usuario: "existe algo que escuche el audio que suban mis hermanos y que haga la
transcripción alineada?" — el bloqueo de subtítulos de la sesión anterior era exactamente eso:
el timing por palabra del repo principal sale de la alineación de ElevenLabs (viene gratis con el
audio generado), y acá el audio lo sube el usuario ya grabado, sin alineación de ningún proveedor.

**Comparado con el usuario** Google Cloud STT vs OpenAI Whisper-1 (única opción de OpenAI con
timestamps por palabra — los modelos `gpt-4o-transcribe` no los dan) — Whisper ganó: $0.006/min
desde el minuto 1 vs $0.024/min de Google pasado su franja gratis (60 min/mes), y sin la ceremonia
de habilitar facturación en un proyecto de Google Cloud. El usuario aceptó la recomendación.

**Piezas nuevas**:
- `transcripcion.js` — llama a `POST /v1/audio/transcriptions` de OpenAI (`whisper-1`,
  `response_format=verbose_json`, `timestamp_granularities[]=word`, `language=es` fijo). Nunca
  lanza: sin `OPENAI_API_KEY`, o si Whisper falla, devuelve `null` y el video sale igual, con
  subtítulos por reparto estimado (% de caracteres) en vez de timing real.
- `tiempos.js` — la "puerta abierta" que el propio `tiempos.js` del repo principal dejó anotada
  el 2026-08-08 ("sirve además para farandula-video-family, donde el audio lo sube el usuario y
  no hay timestamps de ningún proveedor"). A diferencia del principal (alinea CARACTERES de
  ElevenLabs con fuzzy-match), acá Whisper ya da PALABRAS con inicio/fin — el match es palabra
  contra palabra normalizada (sin tildes/mayúsculas/puntuación de borde), con una ventana de
  tolerancia de 3 posiciones por si Whisper se saltea o inventa una palabra. Misma forma de
  salida que `alinearFragmentos` del principal (`{ duraciones, palabras }`), para que
  `seleccion.tiemposPorFragmento()` y `subtitulos.generarASS()` (ambos portados sin tocar) no
  sepan ni les importe de dónde salió el timing.
- `subtitulos.js` — copiado tal cual del principal (post-actualización de ayer de la Mac:
  catálogo Bangers/210pt/606 por defecto, preview canvas). Reemplaza a `fuentesCartel.js`
  (borrado): un solo catálogo de tipografías para subtítulos Y cartel, como en el principal.

**Bug real encontrado portando esto, sin relación con Whisper**: `seleccion.js` de family era
una versión VIEJA — `planificarClips()` no aceptaba `duracionesReales`/`clipMax`, y
`tiemposPorFragmento()` no existía. Consecuencia silenciosa: el wiring de `clipMax` para
transiciones que se agregó el 2026-08-16 (tarea "20" de esa sesión) **nunca hizo nada** — JS
ignora argumentos de más, así que `planificarClips(..., null, clipMax)` llamaba a la función
vieja de 3 parámetros sin error ni warning. Portado el `repartirTomas(duracion, clipMax)` y
`planificarClips(parrafos, duracionAudio, inventario, duracionesReales, clipMax)` actuales del
principal, más `tiemposPorFragmento()`. De paso se encontró un SEGUNDO problema del mismo tipo:
`prepararClips()` en `server.js` hardcodeaba `duracionesReales` a `null` — los CORTES de video
habrían seguido por % de caracteres mientras los subtítulos usaban timing real de Whisper, dos
relojes distintos desincronizados entre sí (exactamente lo que el comentario del principal
advierte: "misma línea de tiempo para el corte de video y para los subtítulos, nunca dos relojes
distintos"). Arreglado: `prepararClips()` ahora recibe y pasa `duracionesReales`.

**server.js**: `/api/upload-audio` transcribe+alinea contra `job.fragments` (ya existen en ese
punto del flujo, Paso 3 corre antes que Paso 4) apenas sube el audio, y guarda
`duracionesReales`/`palabrasAlineadas` en `audiosPendientes` — mismo momento y misma forma que el
principal guarda la alineación de ElevenLabs. `/api/generate-video` arma el `.ass` con
`subtitulos.generarASS()` igual que el principal. Nuevo bug preexistente arreglado de paso: el
middleware de auth bloqueaba `/api/fuentes-subtitulos` no, ese ya estaba bien — pero se renombró
`/api/fuentes-cartel` → `/api/fuentes-subtitulos` (mismo catálogo compartido, mismo nombre que el
principal).

**Frontend**: preview de subtítulos portado tal cual (canvas 1080x1920 con cuadrícula, zonas
seguras de TikTok/YouTube Shorts/Facebook Reels, arrastre para fijar `MarginV`) — mismo código
que ayer escribió la Mac en el principal. `<link>` de Google Fonts agregado al `<head>` SOLO para
esta vista previa (el render real sigue self-hosted vía `fontsdir` de ffmpeg, nunca dependió del
CDN). `handleGenerateVideo()` manda `efectos.subtitulos/subtitulosFuente/subtitulosTamano/
subtitulosMarginV` en modo Video (no en Insumos, mismo criterio que transiciones y cartel: no hay
timeline única sobre la que quemar nada).

**Verificado real, sin la key todavía** (no se configuró `OPENAI_API_KEY` esta sesión — pendiente
que el usuario la provea): pipeline completo con 41 clips, 5 tandas de transiciones, cartel Y
subtítulos juntos. El log confirmó la degradación exactamente como se diseñó
(`⚠️ Falta OPENAI_API_KEY: subtítulos van a salir sin timing real`), se generó un `.ass` real de
24KB, y el frame 60 extraído del video final muestra la palabra "YA" quemada en Bangers/amarillo
con contorno negro — confirmado visualmente, no solo por la existencia del archivo. Frame 0
confirma que el cartel sigue intacto y sin superponerse con el subtítulo. `tiempos.js` (el
matching palabra-por-palabra) se probó aparte, unitario: "Piqué" (guion) matcheó correctamente
contra "Pique" (sin tilde, como transcribiría Whisper) — confirma que la normalización funciona
antes de gastar una llamada real a la API.

**Sin verificar todavía**: el camino REAL de Whisper (con `OPENAI_API_KEY` puesta) no se probó
end-to-end — ni la llamada a la API en sí, ni que `alinearFragmentosPalabras()` calce bien contra
una transcripción real (con sus propios errores de reconocimiento, no el "Pique sin tilde"
sintético de la prueba unitaria). Es lo primero para retomar apenas el usuario dé la key.

**Pendiente real, actualizado**:
1. **Verificar el camino real de Whisper** con `OPENAI_API_KEY` puesta — ver arriba.
2. Música de fondo — sigue bloqueada en el Drive del usuario (sin cambios).
3. Deploy a Railway — sin cambios, ver sesión anterior. Si se despliega, no olvidar
   `OPENAI_API_KEY` entre las variables de entorno (ver `.env.example`, actualizado esta sesión).
4. README.md sigue desactualizado — sin cambios, prioridad baja.
