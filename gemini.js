const axios = require('axios');
const fs = require('fs');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// IMPORTANTE: solo modelos que la cuenta REALMENTE tiene (probados 2026-07-13). Los 2.5/2.0-flash
// dan 404 "no longer available" para cuentas nuevas → NO usarlos. La cuenta es tier gemini-3.x.
// `gemini-flash-latest` resuelve HOY a gemini-3.6-flash (verificado leyendo `modelVersion` de una
// respuesta real, 2026-08-05). No "actualizar" la cadena creyendo que está vieja.
const TIER_ALTO = ['gemini-flash-latest', 'gemini-3.5-flash'];
const TIER_LITE = ['gemini-3.1-flash-lite-preview', 'gemini-flash-lite-latest'];

// Cadenas de modelos por TIPO de tarea. En las dos, si un modelo se satura (503/500/429) o el
// alias rota y da 400/404, se cae al siguiente — la robustez es igual que antes.
//
// La diferencia es por dónde EMPIEZAN:
// - `creativo` arranca en el tier alto: el guion (lo único que decide si el video funciona, y
//   con el prompt afinado para ese modelo) y la lectura (comprensión multimodal).
// - `mecanico` arranca en lite (~6x más barato) y ESCALA al tier alto si lite falla: tareas
//   pautadas donde el modelo no inventa nada.
const CADENAS = {
  creativo: [...TIER_ALTO, ...TIER_LITE],
  mecanico: [...TIER_LITE, ...TIER_ALTO],
};

// Router: qué cadena usa cada llamada. El `nombre` solo sirve para el log, que es lo que
// permite confirmar en producción qué modelo atendió qué.
// (Sin `marcas`: esta versión no usa ElevenLabs, así que no hay prosodia que etiquetar.)
const TAREAS = {
  lectura:       { nombre: 'lectura',       cadena: CADENAS.creativo },
  guion:         { nombre: 'guion',         cadena: CADENAS.creativo },
  fragmentacion: { nombre: 'fragmentación', cadena: CADENAS.mecanico },
  nombreArchivo: { nombre: 'nombre',        cadena: CADENAS.mecanico },
};

// Prompts maestros
const PROMPTS = {
  lectura: `Rol: Periodista de élite, experto en storytelling digital, narrativa transmedia y análisis de tendencias en redes sociales. Tu estilo es audaz, dinámico y profundamente analítico.

Tarea: Procesar el contenido que te proporcione (texto, página web, video o audio) y responder ÚNICAMENTE con un objeto JSON válido (sin markdown, sin bloques de código) con esta estructura exacta:

{
  "cronica": "Crónica periodística sobre el contenido. Centro de atención: el ángulo más viral, actual o disruptivo. Técnicas de storytelling (inicio impactante, desarrollo con tensión y ritmo, cierre memorable). Sin tono corporativo.",
  "titulo": "Título corto, viral y contundente",
  "descripcion": "UNA SOLA descripción adictiva para TikTok terminada en exactamente 5 hashtags estratégicos, todo en un solo bloque",
  "protagonista": "Nombre del famoso principal de la noticia",
  "secundario": "Nombre del segundo involucrado, o cadena vacía si no hay",
  "accion": "El acontecimiento en 2-4 palabras, lo más corto posible"
}

RESTRICCIONES:
- protagonista, secundario y accion NO deben contener caracteres prohibidos en nombres de archivo (/ \\ : * ? " < > |).
- La descripción y los hashtags van juntos en el mismo campo.
- Responde SOLO el JSON.`,

  guion: `Rol: Guionista Senior de Contenido Viral de Farándula. Tu estilo es ágil, picante, cargado de cinismo, tensión dramática y ritmo rápido.

INSTRUCCIONES CRÍTICAS:
1. LONGITUD: El guion DEBE tener entre 205 y 220 palabras (unos 70 segundos de locución). Nunca menos de 200.
2. Efecto Bucle Perfecto: La última frase debe conectar orgánicamente con la primera POR LA IDEA, nunca por las palabras. PROHIBIDO repetir la primera frase (ni completa ni sus primeras palabras) al final. La última frase deja una pregunta o tensión abierta que la primera frase del guion parece responder al reiniciarse el video — con vocabulario totalmente distinto.
3. Apertura de Impacto Directo: Cero introducciones. Arranca con el clímax del escándalo EN LA PRIMERA FRASE.
4. Ritmo: Alterna frases cortas e incisivas (2-5 palabras) con medianas explicativas (10-15 palabras). Mantén tensión constante.
5. Tono: Lenguaje de farándula real ("lo hundió", "quedó expuesto", "se le cayó la mentira", "la jugada le salió mal"). NUNCA uses muletillas de IA como "increíble", "impactante", "no vas a creer".
6. DESARROLLO: El cuerpo debe revelar datos jugosos en el medio y prometer la peor parte al final, pero cumplir la promesa.
7. FORMATO: UN BLOQUE DE TEXTO CORRIDO. Sin saltos de línea, sin etiquetas, sin negritas. Solo texto limpio con comas, puntos y signos de exclamación.

PROHIBIDO:
- Frases incompletas o cortadas.
- Palabras inventadas o neologismos.
- Explicar el contexto antes del clímax (arranca directo en la acción).
- Párrafos separados (TODO en un solo párrafo).
- Numerar, listar o contar palabras en la salida: entrega SOLO el texto del guion.`,
};

// Un intento contra UN modelo, con reintentos internos por sobrecarga temporal.
// Marca el error con _geminiTemporal para que callGemini sepa si vale la pena caer al siguiente modelo.
async function intentarModelo(modelo, prompt, userParts, configExtra) {
  // Pocos reintentos por modelo: como hay cadena de fallback, conviene saltar rápido
  // al siguiente modelo en vez de insistir mucho en uno saturado.
  const MAX_INTENTOS = 2;
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      const response = await axios.post(`${GEMINI_BASE}/${modelo}:generateContent?key=${GEMINI_API_KEY}`, {
        contents: [
          {
            parts: [
              { text: prompt },
              ...userParts
            ]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          maxOutputTokens: 8192,
          // Desactivar el razonamiento interno: consume el límite de tokens y corta la salida
          thinkingConfig: { thinkingBudget: 0 },
          ...configExtra,
        }
      });

      if (response.data.candidates && response.data.candidates.length > 0) {
        // Unir todas las partes de texto (puede venir en varias)
        const parts = response.data.candidates[0].content.parts || [];
        const texto = parts.map(p => p.text || '').join('');
        if (texto.trim()) return texto;
      }
      throw new Error('No hay respuesta de Gemini');
    } catch (error) {
      // 429 = límite de tasa; 503 = modelo sobrecargado; 500 = error interno. Todos temporales.
      const status = error.response?.status;
      // Mensaje real de la API (axios solo deja "Request failed with status code 4xx", inútil para
      // diagnosticar). Lo adjuntamos para que el log/registro diga QUÉ rechazó Gemini.
      const detalleApi = error.response?.data?.error?.message;
      if (detalleApi) error.message = `${modelo} → ${status}: ${detalleApi}`;
      const temporal = status === 429 || status === 503 || status === 500;
      if (temporal && intento < MAX_INTENTOS) {
        const espera = (status === 429 ? 20000 : 8000) * intento;
        console.log(`⏳ ${modelo} respondió ${status}, esperando ${espera / 1000}s (intento ${intento}/${MAX_INTENTOS - 1})...`);
        await new Promise(r => setTimeout(r, espera));
        continue;
      }
      // Los alias -latest rotan su destino (ahora hacia gemini-3): una MISMA request puede dar 400/404
      // en un modelo y funcionar en el siguiente (p.ej. un modelo rechaza thinkingBudget:0 o un campo
      // de config con 400, pero otro lo acepta). Por eso 400 y 404 también caen al siguiente modelo de
      // la cadena en vez de abortar. Solo 401/403 (auth/permiso) son fatales y no se reintentan.
      const authFatal = status === 401 || status === 403;
      error._geminiSiguienteModelo = !authFatal && (temporal || status === 404 || status === 400);
      throw error;
    }
  }
}

// Función principal para llamar a Gemini. Recorre la cadena de modelos de la tarea: intenta el
// primero y, si falla (saturación, 400/404 de routing de alias), cae al siguiente.
// Solo 401/403 (auth/permiso) abortan de una: no los arregla otro modelo.
// `tarea` sale de TAREAS y decide con qué modelo se empieza (ver CADENAS arriba).
async function callGemini(prompt, userMessage, tarea = TAREAS.guion, configExtra = {}) {
  const userParts = Array.isArray(userMessage) ? userMessage : [{ text: userMessage }];
  const cadena = tarea.cadena || CADENAS.creativo;
  let ultimoError;
  for (let i = 0; i < cadena.length; i++) {
    const modelo = cadena[i];
    try {
      if (i > 0) console.log(`↪️  Fallback: reintentando con ${modelo}...`);
      const texto = await intentarModelo(modelo, prompt, userParts, configExtra);
      // Deja rastro de qué modelo atendió cada llamada: sin esto no hay forma de saber si el
      // router está funcionando o si todo se está resolviendo por fallback en el tier caro.
      console.log(`  🤖 ${tarea.nombre || 'gemini'} → ${modelo}`);
      return texto;
    } catch (error) {
      ultimoError = error;
      if (!error._geminiSiguienteModelo) {
        console.error('Error Gemini (no recuperable):', error.message);
        throw error;
      }
      console.warn(`⚠️  ${modelo} saturado tras reintentos; probando el siguiente modelo...`);
    }
  }
  console.error('Error Gemini: todos los modelos de la cadena están saturados');
  throw ultimoError;
}

// Encuentra dónde cierra el primer objeto/array top-level balanceado (cuenta llaves/corchetes
// respetando strings), ignorando cualquier basura que venga después (ej. Gemini a veces repite
// un "}" de más al final de la respuesta).
function extraerBalanceado(t) {
  const abre = t[0];
  const cierra = abre === '[' ? ']' : '}';
  if (abre !== '[' && abre !== '{') return null;
  let profundidad = 0;
  let enString = false;
  let escape = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (enString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') enString = false;
      continue;
    }
    if (c === '"') { enString = true; continue; }
    if (c === abre) profundidad++;
    else if (c === cierra) {
      profundidad--;
      if (profundidad === 0) return t.slice(0, i + 1);
    }
  }
  return null;
}

// Parsear JSON de Gemini con reparación de fallas comunes (fences de markdown,
// texto extra antes o después, array truncado a mitad de un elemento)
function parsearJsonRobusto(texto) {
  let t = texto.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch {}

  // Recortar al primer bloque JSON aparente
  const inicio = Math.min(...['[', '{'].map(c => { const i = t.indexOf(c); return i === -1 ? Infinity : i; }));
  if (inicio !== Infinity) t = t.slice(inicio);
  try { return JSON.parse(t); } catch {}

  // Basura después del objeto/array balanceado (ej. "}" de más al final)
  const balanceado = extraerBalanceado(t);
  if (balanceado) {
    try { return JSON.parse(balanceado); } catch {}
  }

  // Array truncado: cortar hasta el último objeto completo y cerrar
  if (t.startsWith('[')) {
    const ultimoCierre = t.lastIndexOf('}');
    if (ultimoCierre > 0) {
      try { return JSON.parse(t.slice(0, ultimoCierre + 1) + ']'); } catch {}
    }
  }
  throw new Error('JSON irreparable');
}

// Llamada a Gemini que espera JSON: parsea con reparación y reintenta si viene malformado
async function llamarJSON(prompt, userMessage, tarea = TAREAS.guion, config = {}, reintentos = 2) {
  const cadena = tarea.cadena || CADENAS.creativo;
  let ultimoError;
  for (let i = 1; i <= reintentos; i++) {
    // Si el intento anterior devolvió JSON irreparable, no insistir con el MISMO modelo:
    // empezar la cadena un escalón más arriba. Importa sobre todo en las tareas mecánicas,
    // donde el primero es un lite: si ese modelo no logra el formato, subir es lo que resuelve,
    // repetirlo no.
    const desde = Math.min(i - 1, cadena.length - 1);
    const respuesta = await callGemini(prompt, userMessage, { ...tarea, cadena: cadena.slice(desde) }, {
      responseMimeType: 'application/json',
      ...config,
    });
    try {
      return parsearJsonRobusto(respuesta);
    } catch (e) {
      ultimoError = e;
      console.warn(`  ⚠️ JSON malformado de Gemini (intento ${i}/${reintentos}), reintentando...`);
    }
  }
  throw new Error(`Gemini devolvió JSON inválido tras ${reintentos} intentos: ${ultimoError.message}`);
}

// Sesgo editorial de la crónica respecto al protagonista
const SESGOS = {
  favor: 'SESGO EDITORIAL OBLIGATORIO: la crónica debe narrarse A FAVOR del protagonista. Preséntalo como víctima de las circunstancias o como quien actúa con razón; cuestiona los motivos de sus detractores y siembra dudas sobre las versiones que lo acusan.',
  contra: 'SESGO EDITORIAL OBLIGATORIO: la crónica debe narrarse EN CONTRA del protagonista. Cuestiona sus motivos, expón sus contradicciones e incoherencias, y dale peso a las voces de los afectados o críticos.',
  neutral: 'SESGO EDITORIAL: neutral. Presenta los hechos con equilibrio, dando peso similar a las dos versiones sin tomar partido.',
};

// Tipos MIME de video que acepta Gemini, por extensión del archivo descargado
const MIME_VIDEO = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.flv': 'video/x-flv',
  '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.3gp': 'video/3gpp',
};

// Subir un archivo (video) a la File API de Gemini y esperar a que quede ACTIVE.
// Devuelve { uri, mimeType } para usar en fileData. Sube por bytes (no base64), así
// no hay límite de 20MB del inline: sirve para TikToks largos o videos pesados.
async function subirArchivoGemini(filePath) {
  const numBytes = fs.statSync(filePath).size;
  const ext = (filePath.match(/\.[^.]+$/) || ['.mp4'])[0].toLowerCase();
  const mimeType = MIME_VIDEO[ext] || 'video/mp4';

  // 1) Iniciar subida resumable: Gemini responde con la URL a la que se suben los bytes
  const inicio = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
    { file: { display_name: 'fuente_video' } },
    { headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(numBytes),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
    }}
  );
  const uploadUrl = inicio.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error('Gemini no devolvió URL de subida (File API)');

  // 2) Subir los bytes del video y finalizar en la misma petición
  const bytes = fs.readFileSync(filePath);
  const subida = await axios.post(uploadUrl, bytes, {
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  let info = subida.data.file;
  if (!info || !info.name) throw new Error('Gemini no devolvió datos del archivo subido');

  // 3) Gemini procesa el video en segundo plano (PROCESSING → ACTIVE). Esperar a que esté listo.
  let estado = info.state;
  for (let i = 0; i < 30 && estado === 'PROCESSING'; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const chequeo = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/${info.name}?key=${GEMINI_API_KEY}`
    );
    info = chequeo.data;
    estado = info.state;
  }
  if (estado !== 'ACTIVE') {
    throw new Error(`El video no quedó listo en Gemini (estado: ${estado})`);
  }
  console.log(`  🎥 Video subido a Gemini (${(numBytes / 1024 / 1024).toFixed(1)} MB, ${mimeType})`);
  return { uri: info.uri, mimeType: info.mimeType || mimeType };
}

// ETAPA 1: Lectura
// sourceType: 'texto' | 'web' (texto ya extraído) | 'youtube' (URL directa) |
//             'audio' (ruta a MP3 local) | 'video' (ruta a video local, se sube a File API)
// sesgo: 'favor' | 'contra' | 'neutral'
async function procesarLectura(sourceType, content, sesgo = 'neutral') {
  try {
    const instruccionSesgo = SESGOS[sesgo] || SESGOS.neutral;
    let userParts;
    if (sourceType === 'youtube') {
      // Gemini lee videos de YouTube directamente por URL
      userParts = [
        { fileData: { fileUri: content } },
        { text: `Procesa este video de una noticia de farándula.\n\n${instruccionSesgo}` },
      ];
    } else if (sourceType === 'audio') {
      // Audio descargado con yt-dlp (TikTok/Instagram), enviado inline en base64
      const data = fs.readFileSync(content).toString('base64');
      userParts = [
        { inlineData: { mimeType: 'audio/mpeg', data } },
        { text: `Procesa este audio de una noticia de farándula.\n\n${instruccionSesgo}` },
      ];
    } else if (sourceType === 'video') {
      // Video descargado (TikTok/IG/etc): subirlo a la File API y que Gemini lo VEA (imagen + audio)
      const archivo = await subirArchivoGemini(content);
      userParts = [
        { fileData: { fileUri: archivo.uri, mimeType: archivo.mimeType } },
        { text: `Procesa este video de una noticia de farándula. Fíjate en lo que se dice Y en lo que se ve (gestos, reacciones, texto en pantalla, quién aparece).\n\n${instruccionSesgo}` },
      ];
    } else {
      userParts = [{ text: `Procesa este contenido (${sourceType}):\n\n${content}\n\n${instruccionSesgo}` }];
    }

    const datos = await llamarJSON(PROMPTS.lectura, userParts, TAREAS.lectura);
    const limpiar = (s) => (s || '').toString().replace(/[/\\:*?"<>|]/g, '').trim();

    const protagonista = limpiar(datos.protagonista);
    const secundario = limpiar(datos.secundario);
    const accion = limpiar(datos.accion);
    // Nombre de archivo: "Protagonista - Secundario - Hecho" (sin la fecha; se antepone al guardar)
    const nombreCorto = [protagonista, secundario, accion].filter(Boolean).join(' - ').slice(0, 80);

    return {
      cronica: (datos.cronica || '').trim(),
      titulo: (datos.titulo || 'Sin título').trim(),
      descripcion: (datos.descripcion || 'Sin descripción').trim(),
      protagonista,
      secundario,
      accion,
      nombreCorto: nombreCorto || 'Video farandula',
    };
  } catch (error) {
    throw new Error(`Error en lectura: ${error.message}`);
  }
}

// ETAPA 2: Generar Guion (7 ángulos)
async function generarGuion(cronica, angle, angleContent = null) {
  try {
    let descripcionEnfoque;

    if (angle === 7) {
      descripcionEnfoque = angleContent;
    } else if (angle === 6) {
      descripcionEnfoque = 'Combina elementos de varios enfoques: lenguaje corporal, hipocresía del pasado, reacción del entorno, dinero oculto y ruptura de expectativas. Usa los 2-3 que mejor encajen con la historia.';
    } else {
      descripcionEnfoque = getAngleDescription(angle);
    }

    const userMessage = `A continuación tienes dos bloques claramente separados.

=== MATERIAL BASE (la crónica con los HECHOS de la noticia; de aquí sale TODO el contenido del guion) ===
${cronica}
=== FIN DEL MATERIAL BASE ===

=== ENFOQUE NARRATIVO (esto NO es contenido; es solo la LENTE con la que debes contar los hechos) ===
${descripcionEnfoque}
=== FIN DEL ENFOQUE ===

TAREA: Escribe el guion de 205-220 palabras usando ÚNICAMENTE los hechos del MATERIAL BASE, contados a través del ENFOQUE NARRATIVO. No copies el texto del enfoque en el guion; úsalo solo para decidir el ángulo, el tono y el orden de la revelación.`;

    const response = await callGemini(PROMPTS.guion, userMessage, TAREAS.guion);
    return response.trim();
  } catch (error) {
    throw new Error(`Error generando guion: ${error.message}`);
  }
}

// Descripción completa de cada ángulo (1-5)
function getAngleDescription(angle) {
  const descripciones = {
    1: 'El Ángulo del Lenguaje Corporal / Detalle Oculto: enfócate en lo que nadie notó en el video, la cara que pusieron, los gestos o un fotograma específico.',
    2: 'El Ángulo del Pasado / Hipocresía: contrapón lo que el famoso dice hoy con una verdad incómoda o un momento de su pasado que lo contradice.',
    3: 'El Ángulo de las Víctimas / Terceros: enfócate en la reacción de la ex, la familia, los amigos o los comentarios filtrados del entorno cercano.',
    4: 'El Ángulo de la Conspiración / Dinero: sigue la pista del beneficio oculto. ¿Es marketing? ¿Cuánto dinero hay en juego? ¿Qué intentan tapar con este escándalo?',
    5: 'El Ángulo de la Ruptura de Expectativas: inicia rompiendo lo que todos dan por hecho (ej: "Todos creen que la pelea fue por X, pero el verdadero motivo es otro...").',
  };
  return descripciones[angle] || 'Enfoque libre.';
}

// Comprueba que los fragmentos, pegados en orden, reconstruyan el guion original.
// Por qué importa: el tiempo en pantalla de cada clip sale de `caracteres_fragmento /
// caracteres_totales` (seleccion.js). Si Gemini recorta, reescribe o inventa palabras, los
// porcentajes cambian y se corren los tiempos de TODOS los clips — el video se desincroniza de
// la locución sin que nada falle a la vista. Antes nadie lo comprobaba: la regla del prompt lo
// pedía y se confiaba. Esto lo vuelve visible.
function verificarReconstruccion(script, parrafos) {
  // Normalización deliberadamente laxa: solo espacios en blanco. NO se normalizan tildes,
  // mayúsculas ni puntuación a propósito — si Gemini cambia eso, es un cambio real del texto
  // que hay que ver, no ruido que tapar.
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const original = norm(script);
  const reconstruido = norm(parrafos.map(p => p.texto).join(' '));

  if (original === reconstruido) return { ok: true };

  // Primer punto donde divergen, para saber DÓNDE se rompió sin leer los dos textos enteros
  let i = 0;
  while (i < original.length && i < reconstruido.length && original[i] === reconstruido[i]) i++;
  const contexto = original.slice(Math.max(0, i - 40), i + 40);

  const desvio = reconstruido.length - original.length;
  const mensaje = `Los fragmentos NO reconstruyen el guion (${desvio > 0 ? '+' : ''}${desvio} caracteres). ` +
    `Divergen cerca de: "…${contexto}…". Los tiempos de los clips van a estar corridos.`;

  return { ok: false, mensaje, desvio, posicion: i };
}

// Fragmentación POR GUION: los cortes salen del texto y del cambio de sujeto.
// Es la única implementación viva hoy. Ver FRAGMENTADORES abajo para la puerta abierta.
async function fragmentarPorGuion(script, carpetas) {
  const prompt = `Rol: Editor de contenido para videos de farándula en TikTok, especializado en ritmo de "corte rápido".

TAREA: Divide el guion en fragmentos y asigna a cada uno la carpeta del famoso del que se habla EN ESE FRAGMENTO.

Principio que manda sobre todo lo demás: en pantalla se ve el famoso asignado al fragmento
mientras se escucha ese fragmento. Si el texto pasa a hablar de otra persona y el fragmento no
se parte, se queda en pantalla la persona equivocada. Evitar eso es la prioridad.

REGLAS:
1. El punto de partida es una oración completa por fragmento (delimitada por punto, signo de
   exclamación o interrogación). No agrupes varias oraciones en un fragmento.
2. OBLIGATORIO: si DENTRO de una misma oración el sujeto del que se habla cambia de un famoso a
   otro, PARTE la oración en ese punto, sin importar lo corta que sea. Corta justo antes del
   conector o de la coma que separa a los dos sujetos. Esto no es opcional y no depende de la
   longitud.
   Ejemplo: "Shakira apareció radiante en la alfombra roja, pero Piqué prefirió quedarse en casa."
   → DOS fragmentos:
      "Shakira apareció radiante en la alfombra roja," (carpeta de Shakira)
      "pero Piqué prefirió quedarse en casa." (carpeta de Piqué)
3. Aparte de la regla 2: si una oración es muy larga (más de ~140 caracteres) y tiene una pausa
   natural fuerte (coma antes de "pero", "y", "porque", "mientras", "aunque"), puedes partirla
   ahí aunque el sujeto no cambie.
4. El texto de los fragmentos unidos debe reconstruir el guion COMPLETO, en el mismo orden, sin
   omitir, agregar ni cambiar NI UNA palabra. Se verifica automáticamente.
5. Usa el nombre EXACTO de la carpeta (respeta mayúsculas y guiones bajos).
6. Cada fragmento debe tener UN SOLO famoso. Si después de aplicar la regla 2 un fragmento
   todavía nombra a dos, elige a quien sea el SUJETO de la acción, no al mencionado de pasada.
   (Ej.: "Shakira habló del divorcio con Piqué" → el sujeto es Shakira.)
7. Responde ÚNICAMENTE con un array JSON válido: [{"parrafo": "texto", "carpeta": "Nombre_Carpeta"}]

Carpetas disponibles: ${carpetas.join(', ')}`;

  const lista = await llamarJSON(prompt, `Guion:\n\n${script}`, TAREAS.fragmentacion);
  if (!Array.isArray(lista) || lista.length === 0) {
    throw new Error('Gemini no devolvió párrafos');
  }

  const setCarpetas = new Set(carpetas);
  const parrafos = lista
    .map(item => {
      const texto = (item.parrafo || '').trim();
      let famoso = (item.carpeta || '').trim();
      // Si el nombre no es exacto, buscar la carpeta más parecida
      if (!setCarpetas.has(famoso)) {
        const encontrada = carpetas.find(c =>
          c.toLowerCase() === famoso.toLowerCase() ||
          c.toLowerCase().includes(famoso.toLowerCase()) ||
          famoso.toLowerCase().includes(c.toLowerCase())
        );
        if (encontrada) famoso = encontrada;
      }
      return { texto, famoso, caracteres: texto.length };
    })
    .filter(p => p.texto && p.famoso);

  const totalChars = parrafos.reduce((s, p) => s + p.caracteres, 0);
  console.log(`  📄 ${parrafos.length} fragmentos, ${totalChars} caracteres totales`);

  const verif = verificarReconstruccion(script, parrafos);
  if (!verif.ok) console.warn(`  ⚠️ ${verif.mensaje}`);
  // Propiedad del array, no un elemento: JSON.stringify de un array IGNORA las propiedades, así
  // que esto no contamina fragments.json ni lo que se guarda en el job. Es solo para que
  // server.js pueda avisarle al usuario en la misma respuesta.
  Object.defineProperty(parrafos, 'verificacion', { value: verif, enumerable: false });

  return parrafos;
}

// Puerta abierta (plan maestro, Fase 2): la fragmentación queda detrás de una interfaz aunque
// hoy solo exista una implementación. La futura `ritmo` toma la misma duración de locución pero
// hace caer los cortes en el PULSO de la música elegida. No se construye ahora: necesita una
// grilla de onsets de la pista y encajar los cortes en ella sin romper las dos invariantes
// (la suma sigue siendo la duración del audio, ningún clip pasa de 3s), y como los pulsos
// pueden estar más separados que eso habría que subdividir compases. Dejar el nombre ahora
// cuesta cero; reabrirlo después obliga a tocar todo lo que dependa de la forma del plan.
const FRAGMENTADORES = {
  guion: fragmentarPorGuion,
  // ritmo: fragmentarPorRitmo,  // futuro
};

// ETAPA 3 v2: dividir el guion en fragmentos y asignar carpeta de famoso a cada uno.
// El tiempo en pantalla de cada fragmento se calcula después por porcentaje de caracteres.
async function fragmentarGuionParrafos(script, carpetas, modo = 'guion') {
  const fragmentar = FRAGMENTADORES[modo];
  if (!fragmentar) throw new Error(`Modo de fragmentación desconocido: ${modo}`);
  try {
    return await fragmentar(script, carpetas);
  } catch (error) {
    throw new Error(`Error fragmentando en párrafos: ${error.message}`);
  }
}

// NOTA: acá NO va `agregarMarcas`. Esta versión no usa ElevenLabs (el usuario sube su propio
// MP3), así que la prosodia no aplica y `PROMPTS.marcas` no existe en este repo. Se borró en la
// limpieza del 2026-08-05 y volvió sin querer al portar la Fase 2 desde el repo principal;
// quedó rota (llamaba con prompt `undefined`) aunque nadie la llamaba. No reintroducirla.

// Generar nombre corto de archivo: "Protagonista - Secundario - Hecho"
async function generarNombreArchivo(guion) {
  try {
    const prompt = `Genera un nombre de archivo para este guion de farándula.
Formato EXACTO: Protagonista - Secundario - Hecho
- Protagonista: el famoso principal de la noticia.
- Secundario: el segundo involucrado (si no hay, omite esta parte y su guion).
- Hecho: el acontecimiento en 2-4 palabras, lo más corto posible.
Responde SOLO el nombre, sin comillas, sin extensión, sin explicaciones.
No uses caracteres prohibidos en nombres de archivo (/ \\ : * ? " < > |).`;

    const response = await callGemini(prompt, guion, TAREAS.nombreArchivo);
    // Sanear por si acaso
    return response.trim().split('\n')[0].replace(/[/\\:*?"<>|]/g, '').slice(0, 80);
  } catch (error) {
    return 'Video farandula';
  }
}

// Utilidades
function getAngleName(angle) {
  const angles = {
    1: 'Lenguaje Corporal / Detalle Oculto',
    2: 'Pasado / Hipocresía',
    3: 'Víctimas / Terceros',
    4: 'Conspiración / Dinero',
    5: 'Ruptura de Expectativas',
    6: 'Combinado',
  };
  return angles[angle] || 'Desconocido';
}

module.exports = {
  procesarLectura,
  generarGuion,
  fragmentarGuionParrafos,
  verificarReconstruccion,
  TAREAS,   // router de modelos: agregar acá la entrada de cada llamada nueva
  CADENAS,
  generarNombreArchivo,
};
