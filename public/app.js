// App Farandula Video - Familia: mismo pipeline (lectura -> guion -> fragmentos -> audio -> video),
// sin ElevenLabs (audio se sube), sin Drive de escritura (todo se descarga localmente).
let MODO = 'video';
function cfg() {
    return MODO === 'video'
        ? { finalLabel: 'Generar y descargar video' }
        : { finalLabel: 'Exportar y descargar insumos (ZIP)' };
}

function setButtonDisabled(buttonId, disabled) {
    const btn = document.getElementById(buttonId);
    if (btn) {
        btn.disabled = disabled;
        btn.style.opacity = disabled ? '0.6' : '1';
    }
}

const STEP_ORDER = ['fuente-section', 'script-section', 'guion-section', 'revision-section', 'audio-section', 'destination-section'];
function lockFrom(stepId) {
    const idx = STEP_ORDER.indexOf(stepId);
    if (idx === -1) return;
    for (let i = idx; i < STEP_ORDER.length; i++) {
        setStepStatus(STEP_ORDER[i], 'locked');
        if (STEP_ORDER[i] === 'guion-section') resetProductoSlot('producto-guion');
        if (STEP_ORDER[i] === 'audio-section') resetProductoSlot('producto-audio');
        if (STEP_ORDER[i] === 'destination-section') resetProductoSlot('producto-final');
    }
    document.getElementById('result-section').classList.add('hidden');
}

// Tipos de transición tildados en el Paso 6 — el server elige al azar SOLO entre estos en cada
// corte; 1 solo tildado = siempre esa; ninguno tildado = todas (video.js cae solo a 'aleatorio').
function tiposTransicionElegidos() {
    return [...document.querySelectorAll('#transicion-tipos-checks input[type="checkbox"]:checked')].map(c => c.value);
}

function setModo(modo) {
    if (modo === MODO) return;
    MODO = modo;
    document.getElementById('modo-selector').dataset.modo = modo;
    document.getElementById('producto-final-label').textContent = modo === 'video' ? 'Video' : 'Insumos';
    document.getElementById('btn-generate-video-label').textContent = cfg().finalLabel;
    // Transiciones son un efecto ENTRE clips — no aplica a Insumos (clips sueltos para editar a
    // mano, cada uno con sus propios efectos quemados pero sin mezcla con el vecino).
    const esInsumos = modo === 'insumos';
    ['transicion-group', 'transicion-tipo-group', 'transicion-dur-group'].forEach(id => {
        document.getElementById(id)?.classList.toggle('hidden', esInsumos);
    });
    state = { jobId: null, sourceData: null, selectedAngle: null, guion: null, fragments: null, audioToken: null, fuentes: [], sesgo: 'neutral' };
    renderFuentesLista();
    document.getElementById('lectura-section').classList.add('hidden');
    hideProgress();
    lockFrom('script-section');
    setStepStatus('fuente-section', 'active');
    log(`🔀 Modo: ${modo === 'video' ? 'Video final' : 'Insumos para editar'}`);
}

// ==================== AUTH ====================
let TOKEN = null;

function requireLogin() {
    TOKEN = localStorage.getItem('token');
    if (!TOKEN) {
        window.location.href = '/login.html';
        return false;
    }
    return true;
}

function logout() {
    localStorage.removeItem('token');
    window.location.href = '/login.html';
}

async function mostrarUsuario() {
    try {
        const result = await apiCall('/me', 'GET');
        document.getElementById('user-email').textContent = result.user.email;
    } catch {
        // Token inválido/expirado
        logout();
    }
}

let state = {
    jobId: null,
    sourceData: null,
    selectedAngle: null,
    guion: null,
    fragments: null,
    carpetas: [],
    audioToken: null,
    fuentes: [],    // [{type, content, tipoReal, fuenteResumen}, ...] — hasta MAX_FUENTES por noticia
    sesgo: 'neutral',
};
const MAX_FUENTES = 3;

const STEP_BADGE = {
    locked: { icon: 'hourglass', texto: 'Pendiente' },
    active: { icon: 'lockOpen', texto: 'Activo' },
    done: { icon: 'checkCircle', texto: 'Listo' },
};

function actualizarStepBadge(el, status) {
    const badge = el.querySelector('.step-badge');
    if (!badge) return;
    const info = STEP_BADGE[status] || STEP_BADGE.locked;
    badge.innerHTML = `${icon(info.icon)} ${info.texto}`;
}

function setStepStatus(stepId, status) {
    const el = document.getElementById(stepId);
    if (!el) return;
    el.dataset.status = status;
    actualizarStepBadge(el, status);
    if (status === 'active') el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

function setProductoSlot(id, status) {
    const el = document.getElementById(id);
    if (el) el.dataset.status = status;
}
function resetProductoSlot(id) {
    setProductoSlot(id, 'pendiente');
    const body = document.querySelector(`#${id} .producto-slot-body`);
    if (body) body.textContent = 'Aún no generado';
}
function renderProductoGuion(texto) {
    setProductoSlot('producto-guion', 'listo');
    const body = document.querySelector('#producto-guion .producto-slot-body');
    body.innerHTML = '';
    const p = document.createElement('p');
    p.style.cssText = 'white-space:pre-wrap;';
    p.textContent = texto.length > 160 ? texto.slice(0, 160) + '…' : texto;
    body.appendChild(p);
}
function renderProductoAudio(src) {
    setProductoSlot('producto-audio', 'listo');
    const body = document.querySelector('#producto-audio .producto-slot-body');
    body.innerHTML = '';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = src;
    body.appendChild(audio);
}
function renderProductoFinal(resultado) {
    setProductoSlot('producto-final', 'listo');
    const body = document.querySelector('#producto-final .producto-slot-body');
    body.innerHTML = '';
    const a = document.createElement('a');
    a.href = resultado.downloadUrl;
    a.innerHTML = `${icon('link')} Descargar`;
    body.appendChild(a);
}

function revealLectura() {
    document.getElementById('lectura-section').classList.remove('hidden');
}

function showProgress(label) {
    ocultarError();
    document.getElementById('progress-title').innerHTML = label || 'Procesando...';
    document.getElementById('progress-section').classList.remove('hidden');
    // La barra de progreso es `position: fixed` abajo (ver style.css): esta clase le agrega
    // espacio al final del body para que no tape el ultimo bloque de la pagina.
    document.body.classList.add('procesando');
    updateProgress(0);
}
function hideProgress() {
    document.getElementById('progress-section').classList.add('hidden');
    document.body.classList.remove('procesando');
}

function mostrarError(mensaje, reintentarFn, volverStepId) {
    log(`❌ ${mensaje}`);
    document.getElementById('progress-section').classList.remove('hidden');
    document.body.classList.add('procesando');
    const bar = document.getElementById('error-actions');
    if (!bar) return;
    const btnR = document.getElementById('btn-reintentar');
    const btnV = document.getElementById('btn-volver');
    btnR.onclick = () => { ocultarError(); reintentarFn(); };
    if (volverStepId) {
        btnV.style.display = '';
        btnV.onclick = () => { ocultarError(); hideProgress(); setStepStatus(volverStepId, 'active'); };
    } else {
        btnV.style.display = 'none';
    }
    bar.classList.remove('hidden');
}
function ocultarError() {
    const bar = document.getElementById('error-actions');
    if (bar) bar.classList.add('hidden');
}

function log(message) {
    const logBox = document.getElementById('log-box');
    const timestamp = new Date().toLocaleTimeString();
    logBox.innerHTML += `[${timestamp}] ${message}\n`;
    logBox.scrollTop = logBox.scrollHeight;
}
function updateProgress(percent) {
    document.getElementById('progress-fill').style.width = percent + '%';
    document.getElementById('progress-text').textContent = percent + '%';
}

async function apiCall(endpoint, method = 'GET', data = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TOKEN}`,
        },
    };
    if (data) options.body = JSON.stringify(data);

    const response = await fetch(`/api${endpoint}`, options);
    if (response.status === 401) {
        logout();
        throw new Error('Sesión expirada, ingresa de nuevo');
    }
    if (!response.ok) {
        let detalle = `HTTP ${response.status}`;
        try { detalle = (await response.json()).error || detalle; } catch {}
        throw new Error(detalle);
    }
    return response.json();
}

// PASO 1: Leer fuente (primera) o agregar otra (hasta MAX_FUENTES) sobre la misma noticia.
async function handleRead() {
    const sourceType = document.getElementById('source-type').value;
    const sourceInput = document.getElementById('source-input').value;
    const sesgo = document.getElementById('sesgo-select').value;

    if (!sourceInput.trim()) {
        alert('Por favor ingresa un link o texto');
        return;
    }
    setButtonDisabled('btn-read', true);
    try {
        await leerFuente(sourceType, sourceInput, sesgo);
    } finally {
        setButtonDisabled('btn-read', false);
    }
}

// Pinta la lista de fuentes ya agregadas (Paso 1) y ajusta el botón/label según cuántas hay.
function renderFuentesLista() {
    const wrap = document.getElementById('fuentes-lista-wrap');
    const lista = document.getElementById('fuentes-lista');
    const contador = document.getElementById('fuentes-contador');
    const btn = document.getElementById('btn-read');
    const label = document.getElementById('source-input-label');

    contador.textContent = `${state.fuentes.length}/${MAX_FUENTES}`;
    lista.innerHTML = state.fuentes.map((f, i) => `
        <li>
            <span class="fuente-num">${i + 1}.</span>
            <span class="fuente-tipo">${f.tipoReal || f.type}</span>
            <span>${f.fuenteResumen || f.content.slice(0, 60)}</span>
        </li>
    `).join('');
    wrap.classList.toggle('hidden', state.fuentes.length === 0);

    if (state.fuentes.length === 0) {
        btn.innerHTML = `${icon('bookOpen')} Leer y procesar`;
        label.textContent = 'Ingresa aquí:';
        document.getElementById('source-input').disabled = false;
    } else if (state.fuentes.length < MAX_FUENTES) {
        btn.innerHTML = `${icon('bookOpen')} Agregar otra fuente sobre la misma noticia`;
        label.textContent = `Fuente ${state.fuentes.length + 1} de ${MAX_FUENTES} (opcional):`;
        document.getElementById('source-input').disabled = false;
    } else {
        btn.innerHTML = `${icon('check')} Máximo de ${MAX_FUENTES} fuentes alcanzado`;
        setButtonDisabled('btn-read', true);
        label.textContent = 'Ingresa aquí:';
        document.getElementById('source-input').disabled = true;
    }
}

// Sin jobId crea el job; con jobId acumula una fuente más sobre la MISMA noticia (Fase 4) —
// cada llamada solo procesa la fuente nueva, nunca vuelve a tocar las anteriores.
async function leerFuente(sourceType, sourceInput, sesgo) {
    const esPrimera = !state.jobId;
    try {
        state.sesgo = sesgo;
        state.selectedAngle = null;
        state.guion = null;
        state.fragments = null;
        state.audioToken = null;
        lockFrom('script-section');

        showProgress(`${icon('bookOpen')} ${esPrimera ? 'Leyendo fuente' : 'Agregando fuente'}...`);
        log(`📖 ${esPrimera ? 'Iniciando lectura' : 'Agregando fuente'} (sesgo: ${sesgo})...`);
        updateProgress(10);

        const result = await apiCall('/read', 'POST', {
            type: sourceType, content: sourceInput, sesgo, jobId: state.jobId || undefined,
        });

        log(esPrimera ? '✅ Lectura completada' : `✅ Fuente ${result.numFuentes}/${result.maxFuentes} agregada (${result.tipoReal})`);
        state.fuentes.push({ type: sourceType, content: sourceInput, tipoReal: result.tipoReal, fuenteResumen: result.fuenteResumen });
        state.sourceData = result;
        state.jobId = result.jobId;
        updateProgress(30);

        document.getElementById('res-titulo').textContent = result.titulo;
        document.getElementById('res-descripcion').textContent = result.descripcion;
        document.getElementById('res-cronica').textContent = result.cronica;
        revealLectura();
        renderFuentesLista();
        document.getElementById('source-input').value = '';

        hideProgress();
        setStepStatus('fuente-section', 'done');
        setStepStatus('script-section', 'active');
        log('➡️ Agrega otra fuente si querés, o selecciona un ángulo para continuar');
    } catch (error) {
        mostrarError(`Error en lectura: ${error.message}`, () => leerFuente(sourceType, sourceInput, sesgo), 'fuente-section');
    }
}

// PASO 2: Ángulo
function selectAngle(angle) {
    state.selectedAngle = angle;
    document.querySelectorAll('.angle-card').forEach(card => card.classList.remove('selected'));
    event.target.closest('.angle-card').classList.add('selected');
    if (angle === 7) {
        document.getElementById('custom-angle-group').classList.remove('hidden');
    } else {
        document.getElementById('custom-angle-group').classList.add('hidden');
    }
    log(`✓ Ángulo ${angle} seleccionado`);
}

async function handleGenerateScript() {
    if (!state.selectedAngle) { alert('Selecciona un ángulo primero'); return; }
    let angleContent = null;
    if (state.selectedAngle === 7) {
        angleContent = document.getElementById('custom-angle').value;
        if (!angleContent.trim()) { alert('Escribe tu enfoque personalizado'); return; }
    }
    setButtonDisabled('btn-generate-script', true);
    try {
        state.fragments = null;
        state.audioToken = null;
        lockFrom('guion-section');

        showProgress(`${icon('pencilSimple')} Generando guion...`);
        log('✍️ Generando guion...');
        updateProgress(40);

        const result = await apiCall('/generate-script', 'POST', {
            jobId: state.jobId,
            cronica: state.sourceData.cronica,
            angle: state.selectedAngle,
            angleContent,
        });

        log('✅ Guion generado');
        state.guion = result.script;
        renderProductoGuion(result.script);
        updateProgress(50);

        document.getElementById('guion-editor').value = result.script;
        actualizarStatsGuion();
        log(`📜 Guion: ${result.palabras} palabras`);
        if (result.palabras < 180) log('⚠️ Guion corto (se esperan 205-220 palabras)');

        hideProgress();
        setStepStatus('script-section', 'done');
        setStepStatus('guion-section', 'active');
        log('➡️ Revisa el guion: aprueba, edita o regenera');
    } catch (error) {
        mostrarError(`Error generando guion: ${error.message}`, () => handleGenerateScript(), 'script-section');
    } finally {
        setButtonDisabled('btn-generate-script', false);
    }
}

function actualizarStatsGuion() {
    const texto = document.getElementById('guion-editor').value;
    const numPalabras = texto.split(/\s+/).filter(Boolean).length;
    const alerta = numPalabras < 180 ? ' ⚠️ corto' : '';
    document.getElementById('guion-stats').textContent = `Guion (${numPalabras} palabras, ~${Math.round(numPalabras / 3)}s de locución)${alerta}`;
}

function copyGuion() {
    navigator.clipboard.writeText(document.getElementById('guion-editor').value).then(() => log('📋 Guion copiado'));
}

async function aprobarGuion() {
    const texto = document.getElementById('guion-editor').value.trim();
    if (!texto) { alert('El guion está vacío'); return; }
    state.guion = texto;
    renderProductoGuion(texto);
    log('✅ Guion aprobado');

    setButtonDisabled('btn-approve-guion', true);
    try {
        state.audioToken = null;
        lockFrom('revision-section');

        showProgress(`${icon('folderOpen')} Asignando carpetas...`);
        log('📂 Asignando carpetas a los párrafos...');
        updateProgress(52);
        const result = await apiCall('/fragment', 'POST', { jobId: state.jobId, script: state.guion });
        state.fragments = result.fragments;
        state.carpetas = result.carpetas;
        state.avisoReconstruccion = result.avisoReconstruccion || null;
        renderAsignaciones(result.protagonistaSinCarpeta, result.protagonista);

        hideProgress();
        setStepStatus('guion-section', 'done');
        setStepStatus('revision-section', 'active');
    } catch (error) {
        mostrarError(`Error asignando carpetas: ${error.message}`, () => aprobarGuion(), 'guion-section');
    } finally {
        setButtonDisabled('btn-approve-guion', false);
    }
}

function renderAsignaciones(protagonistaSinCarpeta, protagonistaNombre) {
    const aviso = document.getElementById('aviso-protagonista');
    if (protagonistaSinCarpeta) {
        aviso.textContent = `⚠️ ${protagonistaNombre} NO tiene carpeta propia: los clips saldrán de las carpetas asignadas abajo.`;
        aviso.classList.remove('hidden');
    } else {
        aviso.classList.add('hidden');
    }

    // Los fragmentos deben reconstruir el guion palabra por palabra: el tiempo en pantalla de
    // cada clip sale de su proporción de caracteres. Si no coinciden, todos los clips quedan
    // corridos respecto de la locución — y no falla nada a la vista, por eso hay que avisarlo.
    const avisoRec = document.getElementById('aviso-reconstruccion');
    if (avisoRec) {
        if (state.avisoReconstruccion) {
            avisoRec.textContent = `⚠️ ${state.avisoReconstruccion}`;
            avisoRec.classList.remove('hidden');
        } else {
            avisoRec.classList.add('hidden');
        }
    }

    const lista = document.getElementById('lista-asignaciones');
    lista.innerHTML = '';
    state.fragments.forEach((f, i) => {
        const totalChars = state.fragments.reduce((s, x) => s + x.caracteres, 0);
        const pct = totalChars ? Math.round((f.caracteres / totalChars) * 100) : 0;
        const div = document.createElement('div');
        div.style.cssText = 'border:1px solid #ddd;border-radius:8px;padding:10px;margin-bottom:8px;';
        const p = document.createElement('p');
        p.style.cssText = 'margin:0 0 6px;font-size:0.9rem;';
        p.textContent = `${i + 1}. (${pct}%) ${f.texto}`;
        const sel = document.createElement('select');
        sel.style.width = '100%';
        state.carpetas.forEach(c => {
            const o = document.createElement('option');
            o.value = c; o.textContent = c;
            if (c === f.famoso) o.selected = true;
            sel.appendChild(o);
        });
        sel.onchange = () => { state.fragments[i].famoso = sel.value; };
        div.appendChild(p);
        div.appendChild(sel);
        lista.appendChild(div);
    });
}

async function confirmarAsignaciones() {
    setButtonDisabled('btn-confirm-assignments', true);
    try {
        hideProgress();
        setStepStatus('revision-section', 'done');
        setStepStatus('audio-section', 'active');
        log('➡️ Sube tu locución en MP3');
    } finally {
        setButtonDisabled('btn-confirm-assignments', false);
    }
}

// PASO 5: Subir audio
let selectedAudioFile = null;

function handleAudioFileSelected() {
    const input = document.getElementById('audio-file-input');
    selectedAudioFile = input.files[0] || null;
    setButtonDisabled('btn-upload-audio', !selectedAudioFile);
}

async function handleUploadAudio() {
    if (!selectedAudioFile) { alert('Selecciona un archivo MP3'); return; }
    setButtonDisabled('btn-upload-audio', true);
    try {
        showProgress(`${icon('microphone')} Subiendo audio...`);
        log('🎙️ Subiendo audio...');
        updateProgress(65);

        const formData = new FormData();
        formData.append('audioFile', selectedAudioFile);
        formData.append('jobId', state.jobId);

        const response = await fetch('/api/upload-audio', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TOKEN}` },
            body: formData,
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${response.status}`);
        }
        const result = await response.json();
        state.audioToken = result.audioToken;

        document.getElementById('audio-info').textContent = `Duración: ${Math.round(result.duracion)}s`;
        const player = document.getElementById('audio-player');
        player.src = result.audioUrl + '?t=' + Date.now();
        player.style.display = 'block';
        player.load();
        renderProductoAudio(player.src);
        document.getElementById('btn-approve-audio').classList.remove('hidden');

        hideProgress();
        log('🎧 Audio subido. Escúchalo y apruébalo.');
    } catch (error) {
        mostrarError(`Error subiendo audio: ${error.message}`, () => handleUploadAudio(), 'revision-section');
    } finally {
        setButtonDisabled('btn-upload-audio', false);
    }
}

async function aprobarAudio() {
    if (!state.audioToken) { alert('Sube un audio primero'); return; }
    setButtonDisabled('btn-approve-audio', true);
    try {
        log('✅ Locución aprobada');
        setStepStatus('audio-section', 'done');
        setStepStatus('destination-section', 'active');
    } finally {
        setButtonDisabled('btn-approve-audio', false);
    }
}

async function regenerarGuion() {
    setButtonDisabled('btn-regenerate-guion', true);
    try {
        log('🔄 Regenerando guion (mismo ángulo)...');
        await handleGenerateScript();
    } finally {
        setButtonDisabled('btn-regenerate-guion', false);
    }
}

function cambiarAngulo() {
    setStepStatus('guion-section', 'locked');
    setStepStatus('script-section', 'active');
    log('🎯 Elige otro ángulo');
}

// PASO 6: Generar (video o insumos) y descargar
async function handleGenerateVideo() {
    setButtonDisabled('btn-generate-video', true);
    try {
        showProgress(MODO === 'video' ? `${icon('rocketLaunch')} Generando video...` : `${icon('rocketLaunch')} Exportando insumos...`);
        log(MODO === 'video' ? '🚀 Iniciando generación de video...' : '🚀 Iniciando exportación de insumos...');
        updateProgress(50);

        if (!state.fragments || state.fragments.length === 0) throw new Error('No hay párrafos asignados');
        if (!state.audioToken) throw new Error('No hay locución aprobada');

        const efectos = {
            zoom: document.getElementById('efecto-zoom')?.value || 'ninguno',
            zoomPct: Number(document.getElementById('zoom-pct')?.value) || 20,
            espejo: document.getElementById('efecto-espejo')?.value || 'ninguno',
        };
        // Transiciones, subtítulos y cartel solo aplican en modo Video — en Insumos cada clip
        // sale suelto para edición manual (sin mezcla con el vecino, sin timeline única sobre la
        // que quemar subtítulos, y sin un "frame 0" único para el cartel).
        if (MODO === 'video') {
            efectos.transicion = document.getElementById('efecto-transicion')?.value || 'ninguno';
            efectos.transicionTipo = tiposTransicionElegidos();
            efectos.transicionDur = Number(document.getElementById('transicion-dur')?.value) || 0.35;
            efectos.subtitulos = document.getElementById('efecto-subtitulos')?.checked ?? true;
            efectos.subtitulosFuente = subsFuente;
            efectos.subtitulosTamano = subsTamano;
            efectos.subtitulosMarginV = subsMarginV;
            // PNG EXACTO que se ve en la previa del Paso 6 (data URL) — el server no lo re-dibuja,
            // lo superpone tal cual en el frame 0 y en el JPG.
            const cartelPNG = await exportarCartelPNG();
            if (document.getElementById('portada-titular')?.value.trim() && !cartelPNG) {
                log('⚠️ No se pudo generar el cartel de portada: el video va a salir sin él.');
            }
            efectos.cartelPNG = cartelPNG;
        }

        let resultado;
        if (MODO === 'video') {
            updateProgress(70);
            resultado = await apiCall('/generate-video', 'POST', { jobId: state.jobId, efectos });
            log('✅ Video generado');
        } else {
            updateProgress(70);
            resultado = await apiCall('/exportar', 'POST', { jobId: state.jobId, efectos });
            log('✅ Insumos exportados');
        }
        updateProgress(100);
        hideProgress();
        setStepStatus('destination-section', 'done');
        showResult(resultado);
    } catch (error) {
        mostrarError(`Error en ${MODO === 'video' ? 'la generación del video' : 'la exportación'}: ${error.message}`, () => handleGenerateVideo(), 'destination-section');
    } finally {
        setButtonDisabled('btn-generate-video', false);
    }
}

function showResult(resultado) {
    const resultSection = document.getElementById('result-section');
    resultSection.classList.remove('hidden');
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const resultInfo = document.getElementById('result-info');
    renderProductoFinal(resultado);

    if (MODO === 'insumos') {
        resultInfo.innerHTML = `
            <p><strong>${icon('checkCircle')} Insumos exportados</strong></p>
            <p>${resultado.clips} clips + locución</p>
            <p><a class="btn btn-primary" href="${resultado.downloadUrl}">${icon('link')} Descargar ZIP (${resultado.zipName})</a></p>
        `;
        log('🎉 ¡Insumos listos para descargar!');
        return;
    }

    const playerHtml = resultado.videoUrl
        ? `<video id="result-video-player" controls playsinline class="result-video-player" src="${resultado.videoUrl}"></video>`
        : '';

    // El cartel quedó FIJO en el Paso 6, antes de generar: el server guardó el PNG que le mandó
    // el navegador y devuelve su URL — es el MISMO archivo que quemó en el frame 0 y que se va a
    // usar para el JPG. Acá solo se muestra, no se re-dibuja ni se re-edita.
    const cartelUrl = resultado.cartelUrl || null;
    const portadaHtml = cartelUrl ? `
        <div class="portada-box mt-md" id="portada-box">
            <p><strong>${icon('videoCamera')} Elegí la foto para el JPG de portada</strong></p>
            <p class="hint">El cartel ya quedó quemado en el primer fotograma del video, tal como lo definiste en el Paso 6 — acá solo elegís QUÉ FOTO de fondo lleva el JPG descargable (mismo cartel, no se re-edita). Pausá el reproductor de arriba donde quieras.</p>
            <div class="portada-live" id="portada-live">
                <canvas id="portada-live-canvas"></canvas>
                <img class="portada-live-cartel" src="${cartelUrl}" alt="">
            </div>
            <button class="btn btn-secondary mt-sm" type="button" id="btn-generar-portada" onclick="generarPortada()">${icon('sparkle')} Generar portada con esta foto</button>
            <div id="portada-resultado"></div>
        </div>
    ` : '';

    resultInfo.innerHTML = `
        ${playerHtml}
        <p><strong>${icon('checkCircle')} Video generado exitosamente</strong></p>
        <p>${icon('hourglass')} Duración: ${resultado.duracion}s</p>
        <p><a class="btn btn-primary" href="${resultado.downloadUrl}">${icon('link')} Descargar video (${resultado.videoName})</a></p>
        ${portadaHtml}
    `;
    if (cartelUrl) {
        const videoEl = document.getElementById('result-video-player');
        // Fotograma por defecto: el primero del video. 0.01 y no 0 a propósito — si currentTime
        // ya está en 0 (arranca ahí), reasignarle 0 es un no-op, nunca dispara 'seeked' y el
        // navegador no decodifica un frame pintable (mockup quedaba negro). Con 0.01s hay un seek
        // real; la diferencia visual con el frame 0 es nula.
        if (videoEl) { try { videoEl.currentTime = 0.01; } catch {} }
        initPortadaLive();
    }
    log('🎉 ¡Video listo para descargar!');
}

function copyText(elementId) {
    const text = document.getElementById(elementId).textContent;
    navigator.clipboard.writeText(text).then(() => log('📋 Copiado al portapapeles'));
}

function observarSnap(container, itemSelector, eje) {
    if (!container) return;
    const horizontal = eje === 'x';
    function actualizar() {
        const items = container.querySelectorAll(itemSelector);
        if (!items.length) return;
        const contRect = container.getBoundingClientRect();
        const contCenter = horizontal ? contRect.left + contRect.width / 2 : contRect.top + contRect.height / 2;
        let masCercano = null, menorDistancia = Infinity;
        items.forEach(item => {
            const r = item.getBoundingClientRect();
            const centro = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
            const distancia = Math.abs(centro - contCenter);
            if (distancia < menorDistancia) { menorDistancia = distancia; masCercano = item; }
        });
        items.forEach(item => item.classList.toggle('snapped', item === masCercano));
    }
    let esperando = false;
    container.addEventListener('scroll', () => {
        if (esperando) return;
        esperando = true;
        requestAnimationFrame(() => { actualizar(); esperando = false; });
    });
    actualizar();
}

function contenedorPasos() { return document.querySelector('.col-procesos .scroll-snap-col'); }
function actualizarPasosIndicador() {
    const cont = contenedorPasos();
    const el = document.getElementById('pasos-nav-indicador');
    if (!cont || !el || !cont.clientWidth) return;
    const total = cont.querySelectorAll('.form-section').length;
    const idx = Math.min(total - 1, Math.max(0, Math.round(cont.scrollLeft / cont.clientWidth)));
    el.textContent = `Paso ${idx + 1} de ${total}`;
}
function pasoSiguiente() {
    const cont = contenedorPasos();
    if (!cont) return;
    cont.scrollBy({ left: cont.clientWidth, behavior: 'smooth' });
    setTimeout(actualizarPasosIndicador, 350);
}
function pasoAnterior() {
    const cont = contenedorPasos();
    if (!cont) return;
    cont.scrollBy({ left: -cont.clientWidth, behavior: 'smooth' });
    setTimeout(actualizarPasosIndicador, 350);
}

// Historial (PostgreSQL, per-user)
const ESTADO_HISTORIAL = {
    lectura: 'Iniciado', guion: 'En guion', fragmentos: 'Fragmentado',
    audio: 'Con audio', video_ok: 'Video listo', insumos_ok: 'Insumos listos',
};
async function cargarHistorial() {
    const cont = document.getElementById('historial-lista');
    cont.innerHTML = '<p style="color:#666;">Cargando...</p>';
    try {
        const result = await apiCall('/history', 'GET');
        const items = result.history || [];
        if (items.length === 0) {
            cont.innerHTML = '<p style="color:#666;">Sin registros todavía.</p>';
            return;
        }
        cont.innerHTML = '';
        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'historial-item';
            div.style.cssText = 'border:2px solid #000;border-radius:8px;padding:10px 12px;margin-bottom:8px;';
            const fecha = new Date(item.fecha).toLocaleString();
            div.innerHTML = `
                <div style="font-weight:900;font-size:0.85rem;">${ESTADO_HISTORIAL[item.status] || item.status}</div>
                <div style="color:#666;font-size:0.75rem;margin-top:3px;">${fecha}${item.duracion ? ` · ${Math.round(item.duracion)}s` : ''}${item.video_name ? ` · ${item.video_name}` : ''}</div>
            `;
            cont.appendChild(div);
        });
    } catch (error) {
        cont.innerHTML = `<p style="color:#c0392b;">Error cargando historial: ${error.message}</p>`;
    }
}

function aplicarIconos() {
    document.querySelectorAll('[data-icon]').forEach(el => {
        el.innerHTML = (typeof ICONS !== 'undefined' && ICONS[el.dataset.icon]) || '';
        el.classList.add('icon-slot');
    });
}

// ---- Cartel de portada: UN SOLO dibujo, en canvas a tamaño real de video ----
// Portado de farandula-video-generator (repo hermano). El cartel se dibuja UNA vez, acá, en un
// <canvas> de 1080x1920 (tamaño real del video, mostrado chico por CSS) — ese canvas ES la vista
// previa, y `canvas.toDataURL()` da exactamente esos píxeles como PNG, que es lo que el server
// superpone en el frame 0 del video y en el JPG de portada. No hay dos dibujos que puedan diferir.
const PORTADA_ANCHO_VIDEO = 1080;
const PORTADA_ALTO_VIDEO = 1920;
const PORTADA_ANCHO_UTIL = PORTADA_ANCHO_VIDEO - 70 - 70;
const PORTADA_FONTSIZE_MAX = 94;
const PORTADA_FONTSIZE_MIN = 36;
const PORTADA_POS_Y_FRACCION = 0.58;
const PORTADA_COLOR_CAJA = '#ff2d6b';
const PORTADA_COLOR_TEXTO = '#ffffff';
const PORTADA_MAX_LINEAS = 3;

function portadaFontCss(claveFuente, fontsize) {
    return `${fontsize}px 'cartel-${claveFuente}', sans-serif`;
}

// Parte `texto` en como máximo `maxLineas` líneas que quepan en `maxAncho` PÍXELES REALES, sin
// cortar palabras (`ctx` ya debe tener la fuente/tamaño finales). Devuelve null si no entra —así
// el automático prueba un tamaño más chico—, salvo `forzar`, que desborda la última línea.
function portadaEnvolverMedido(ctx, texto, maxAncho, maxLineas, forzar) {
    const palabras = texto.trim().split(/\s+/).filter(Boolean);
    if (!palabras.length) return [''];
    const lineas = [''];
    for (const palabra of palabras) {
        const actual = lineas[lineas.length - 1];
        const candidata = actual ? `${actual} ${palabra}` : palabra;
        if (ctx.measureText(candidata).width <= maxAncho || !actual) {
            lineas[lineas.length - 1] = candidata;
        } else if (lineas.length < maxLineas) {
            lineas.push(palabra);
        } else if (forzar) {
            lineas[lineas.length - 1] = candidata;
        } else {
            return null;
        }
    }
    return lineas;
}

function portadaAjustarTamanoMedido(ctx, texto, claveFuente) {
    for (let fontsize = PORTADA_FONTSIZE_MAX; fontsize >= PORTADA_FONTSIZE_MIN; fontsize -= 3) {
        ctx.font = portadaFontCss(claveFuente, fontsize);
        const lineas = portadaEnvolverMedido(ctx, texto, PORTADA_ANCHO_UTIL, PORTADA_MAX_LINEAS, false);
        if (lineas) return { lineas, fontsize };
    }
    ctx.font = portadaFontCss(claveFuente, PORTADA_FONTSIZE_MIN);
    return {
        lineas: portadaEnvolverMedido(ctx, texto, PORTADA_ANCHO_UTIL, PORTADA_MAX_LINEAS, true),
        fontsize: PORTADA_FONTSIZE_MIN,
    };
}

function portadaCaminoCajaRedondeada(ctx, x, y, w, h, r) {
    const radio = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radio, y);
    ctx.arcTo(x + w, y, x + w, y + h, radio);
    ctx.arcTo(x + w, y + h, x, y + h, radio);
    ctx.arcTo(x, y + h, x, y, radio);
    ctx.arcTo(x, y, x + w, y, radio);
    ctx.closePath();
}

// Dibuja el cartel completo (caja + línea blanca interior + texto) sobre un canvas de 1080x1920,
// con fondo TRANSPARENTE — el PNG que sale de acá se superpone sobre cualquier fotograma.
// Devuelve false si no hay titular (nada que dibujar).
function dibujarCartel(canvas, { titular, fuente, tamanoManual, escalaCaja }) {
    const ctx = canvas.getContext('2d');
    canvas.width = PORTADA_ANCHO_VIDEO;
    canvas.height = PORTADA_ALTO_VIDEO;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const texto = (titular || '').trim().toUpperCase();
    if (!texto) return false;

    const claveFuente = fuente || 'anton';
    let lineas, fontsize;
    if (Number.isFinite(tamanoManual)) {
        fontsize = Math.max(24, Math.min(160, Math.round(tamanoManual)));
        ctx.font = portadaFontCss(claveFuente, fontsize);
        lineas = portadaEnvolverMedido(ctx, texto, PORTADA_ANCHO_UTIL, PORTADA_MAX_LINEAS, true);
    } else {
        ({ lineas, fontsize } = portadaAjustarTamanoMedido(ctx, texto, claveFuente));
    }
    ctx.font = portadaFontCss(claveFuente, fontsize);

    const esc = Number.isFinite(escalaCaja) ? escalaCaja : 1;
    const padX = Math.round(fontsize * 0.32 * esc);
    const padY = Math.round(fontsize * 0.22 * esc);
    const lineHeight = Math.round(fontsize * 1.08);
    const lineSpacing = Math.round(fontsize * 0.08);
    const anchoMaxLinea = Math.max(...lineas.map(l => ctx.measureText(l).width));
    const boxW = Math.min(PORTADA_ANCHO_UTIL + padX * 2, Math.round(anchoMaxLinea + padX * 2));
    const boxH = lineas.length * lineHeight + (lineas.length - 1) * lineSpacing + padY * 2;
    const boxX = Math.round((PORTADA_ANCHO_VIDEO - boxW) / 2);
    const boxY = Math.round(PORTADA_ALTO_VIDEO * PORTADA_POS_Y_FRACCION);
    const radio = Math.max(14, Math.min(32, Math.round(fontsize * 0.4)));
    const sombra = Math.max(2, Math.round(fontsize * 0.045));
    const separacion = Math.max(5, Math.round(fontsize * 0.11 * esc));
    const grosor = Math.max(3, Math.round(fontsize * 0.05));

    portadaCaminoCajaRedondeada(ctx, boxX, boxY, boxW, boxH, radio);
    ctx.fillStyle = PORTADA_COLOR_CAJA;
    ctx.fill();
    portadaCaminoCajaRedondeada(ctx, boxX + separacion, boxY + separacion,
        boxW - separacion * 2, boxH - separacion * 2, Math.max(4, radio - separacion));
    ctx.fillStyle = PORTADA_COLOR_TEXTO;
    ctx.fill();
    portadaCaminoCajaRedondeada(ctx, boxX + separacion + grosor, boxY + separacion + grosor,
        boxW - (separacion + grosor) * 2, boxH - (separacion + grosor) * 2,
        Math.max(4, radio - separacion - grosor));
    ctx.fillStyle = PORTADA_COLOR_CAJA;
    ctx.fill();

    ctx.fillStyle = PORTADA_COLOR_TEXTO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowOffsetX = sombra;
    ctx.shadowOffsetY = sombra;
    ctx.shadowBlur = sombra * 1.5;
    const altoTexto = lineas.length * lineHeight + (lineas.length - 1) * lineSpacing;
    let y = boxY + boxH / 2 - altoTexto / 2 + lineHeight / 2;
    for (const linea of lineas) {
        ctx.fillText(linea, boxX + boxW / 2, y);
        y += lineHeight + lineSpacing;
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;
    return true;
}

function leerDisenoCartel() {
    const titularEl = document.getElementById('portada-titular');
    if (!titularEl) return null;
    const autoEl = document.getElementById('portada-tamano-auto');
    const tamanoEl = document.getElementById('portada-tamano-num');
    const cajaEl = document.getElementById('portada-caja-num');
    return {
        titular: titularEl.value || '',
        fuente: document.getElementById('portada-fuente')?.value || 'anton',
        tamanoManual: autoEl && !autoEl.checked ? Number(tamanoEl?.value) || 94 : undefined,
        escalaCaja: (Number(cajaEl?.value) || 100) / 100,
    };
}

// La tipografía tiene que estar CARGADA antes de medir/dibujar, si no el canvas mide y dibuja con
// una de reemplazo — y como este dibujo es el que se hornea en el video, la letra equivocada
// llegaría al resultado final. Se carga el MISMO .ttf que sirve el server (/api/fuente/:clave),
// no el de Google Fonts: los dos lados comparten el archivo exacto, sin depender de un CDN.
const fuentesCartelCargadas = new Map();
async function asegurarFuenteCargada(claveFuente) {
    if (!window.FontFace || !document.fonts) return false;
    if (!fuentesCartelCargadas.has(claveFuente)) {
        fuentesCartelCargadas.set(claveFuente, (async () => {
            try {
                const ff = new FontFace(`cartel-${claveFuente}`, `url(/api/fuente/${encodeURIComponent(claveFuente)})`);
                await ff.load();
                document.fonts.add(ff);
                return true;
            } catch (e) {
                // Solo se cachean los ÉXITOS: cachear un fallo dejaría la tipografía rota hasta
                // recargar la página.
                fuentesCartelCargadas.delete(claveFuente);
                console.warn(`No se pudo cargar la tipografía "${claveFuente}" para el cartel:`, e.message);
                return false;
            }
        })());
    }
    return fuentesCartelCargadas.get(claveFuente);
}

function avisarFuenteCartel(ok) {
    const el = document.getElementById('portada-fuente-aviso');
    if (!el) return;
    el.textContent = ok ? '' : '⚠️ No se pudo cargar esa tipografía: el cartel se está dibujando con una letra de reemplazo, y así quedaría en el video. Revisá la conexión o elegí otra.';
    el.style.display = ok ? 'none' : 'block';
}

async function actualizarPortadaDiseno() {
    const canvas = document.getElementById('portada-diseno-canvas');
    const diseno = leerDisenoCartel();
    if (!canvas || !diseno) return;
    avisarFuenteCartel(await asegurarFuenteCargada(diseno.fuente));
    dibujarCartel(canvas, { ...diseno, titular: diseno.titular || '...' });
}

function initPortadaDiseno() {
    document.getElementById('portada-titular')?.addEventListener('input', actualizarPortadaDiseno);
    document.getElementById('portada-fuente')?.addEventListener('change', actualizarPortadaDiseno);
    actualizarPortadaDiseno();
}

function initPortadaTamano() {
    const auto = document.getElementById('portada-tamano-auto');
    const slider = document.getElementById('portada-tamano');
    const num = document.getElementById('portada-tamano-num');
    if (!auto || !slider || !num) return;
    const sync = valor => {
        const n = Math.max(24, Math.min(160, Math.round(valor) || 94));
        slider.value = n;
        num.value = n;
    };
    auto.addEventListener('change', () => {
        slider.disabled = auto.checked;
        num.disabled = auto.checked;
        actualizarPortadaDiseno();
    });
    slider.addEventListener('input', () => { sync(slider.value); actualizarPortadaDiseno(); });
    num.addEventListener('input', () => { sync(num.value); actualizarPortadaDiseno(); });
}

function initPortadaCaja() {
    const slider = document.getElementById('portada-caja');
    const num = document.getElementById('portada-caja-num');
    if (!slider || !num) return;
    const sync = valor => {
        const n = Math.max(50, Math.min(250, Math.round(valor) || 100));
        slider.value = n;
        num.value = n;
    };
    slider.addEventListener('input', () => { sync(slider.value); actualizarPortadaDiseno(); });
    num.addEventListener('input', () => { sync(num.value); actualizarPortadaDiseno(); });
}

// PNG del cartel tal como se ve en la previa, listo para mandar al server. Devuelve null si no
// hay titular (el usuario no quiere cartel). Es una data URL porque viaja dentro del JSON del
// pedido de generar video, junto al resto de los efectos.
async function exportarCartelPNG() {
    const diseno = leerDisenoCartel();
    if (!diseno || !diseno.titular.trim()) return null;
    await asegurarFuenteCargada(diseno.fuente);
    const canvas = document.createElement('canvas');
    if (!dibujarCartel(canvas, diseno)) return null;
    return canvas.toDataURL('image/png');
}

// Catálogo de tipografías del cartel (server: fuentesCartel.js) — evita mantener una lista
// duplicada acá; si se agrega/saca una fuente, el selector se actualiza solo.
async function cargarFuentesEnSelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    try {
        const { fuentes, default: porDefecto } = await apiCall('/fuentes-subtitulos', 'GET');
        select.innerHTML = fuentes.map(f => `<option value="${f.clave}">${f.familia}</option>`).join('');
        select.value = porDefecto || fuentes[0]?.clave || 'anton';
    } catch (e) {
        console.warn(`No se pudo cargar el catálogo de tipografías para #${selectId}:`, e.message);
    }
}

// Post-render — ELEGIR FOTO: fotograma real capturado del reproductor + EL PNG REAL del cartel
// encima (`cartelUrl`, el mismo archivo que el server ya quemó en el frame 0). No se re-dibuja ni
// se aproxima nada acá: es la imagen final, estirada al mismo recuadro.
function initPortadaLive() {
    const videoEl = document.getElementById('result-video-player');
    const canvas = document.getElementById('portada-live-canvas');
    if (!videoEl || !canvas) return;

    const capturarFrame = () => {
        try {
            canvas.width = 270;
            canvas.height = 480;
            canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        } catch {} // video aún no tiene un frame decodificado — se reintenta en el próximo evento
    };

    videoEl.addEventListener('seeked', capturarFrame);
    videoEl.addEventListener('loadeddata', capturarFrame);

    let intentos = 0;
    const intentarCaptura = () => {
        if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) capturarFrame();
        else if (intentos < 20) { intentos++; setTimeout(intentarCaptura, 100); }
    };
    intentarCaptura();
}

// Genera el JPG de portada: fotograma elegido en el player + EL MISMO cartel ya quemado en el
// frame 0 (texto/fuente/tamaño/caja vienen del server, guardados junto al video — acá no se
// re-envían ni se re-editan).
async function generarPortada() {
    const videoEl = document.getElementById('result-video-player');
    const destino = document.getElementById('portada-resultado');
    if (!state.jobId) {
        alert('No hay video disponible (generá el video de nuevo)');
        return;
    }
    setButtonDisabled('btn-generar-portada', true);
    destino.innerHTML = '';
    try {
        const { portadaUrl } = await apiCall('/portada', 'POST', {
            jobId: state.jobId,
            timestamp: videoEl ? videoEl.currentTime : 0,
        });
        destino.innerHTML = `
            <img src="${portadaUrl}" alt="Portada" class="portada-preview">
            <p><a href="${portadaUrl}" download="portada.jpg" class="btn btn-secondary">${icon('folderOpen')} Descargar portada (JPG)</a></p>
        `;
    } catch (e) {
        destino.innerHTML = `<p class="error-text">Error generando la portada: ${e.message}</p>`;
    } finally {
        setButtonDisabled('btn-generar-portada', false);
    }
}

// ---- Vista previa de subtítulos: canvas real 1080x1920 con cuadrícula y zonas seguras ----
// Portado de farandula-video-generator (repo hermano, 2026-08-16). Diferencia honesta con el
// cartel de portada: ese canvas ES el archivo que se superpone (idéntico por construcción). Acá
// NO — los subtítulos los quema libass desde el .ass, con su propio motor de texto. La geometría
// (posición, tamaño, márgenes) es fiel; el trazo exacto de cada letra puede variar un pelo.
const SUBS_PLAYRES_Y = 1920;
const SUBS_PLAYRES_X = 1080;
const SUBS_ANCHO_UTIL = SUBS_PLAYRES_X - 60 - 60;
let subsTamano = 210;
let subsMarginV = 606;
let subsFuente = 'bangers';

// Zonas que cada app tapa con su propia interfaz — mismas medidas que el repo principal (leídas
// de las plantillas oficiales de zona segura 9:16 de cada app, calibradas contra 1080x1920).
// Aproximadas (±10px, las plantillas cambian entre versiones). Único lugar donde viven.
const SUBS_ZONAS_APPS = [
    { nombre: 'TikTok',          color: '#ff2d55', arriba: 181, abajo: 292, derecha: 174 },
    { nombre: 'YouTube Shorts',  color: '#ff4444', arriba: 181, abajo: 195, derecha: 169 },
    { nombre: 'Facebook Reels',  color: '#4a9eff', arriba: 191, abajo: 302, derecha: 164 },
];
const SUBS_CORTE_LATERAL = 48;
const SUBS_LIMITE_ARRIBA = Math.max(...SUBS_ZONAS_APPS.map(z => z.arriba));
const SUBS_LIMITE_ABAJO = Math.max(...SUBS_ZONAS_APPS.map(z => z.abajo));
const SUBS_LIMITE_DERECHA = Math.max(...SUBS_ZONAS_APPS.map(z => z.derecha));

// Mapeo clave del catálogo (subtitulos.js) → familia/peso CSS del <link> de Google Fonts en
// index.html — SOLO para que la previa se vea con la tipografía real; el render final sigue
// self-hosted con ffmpeg (fontsdir), esto no lo toca.
const SUBS_FUENTES_CSS = {
    anton:     { family: 'Anton',         weight: 400 },
    poppins:   { family: 'Poppins',       weight: 800 },
    bebas:     { family: 'Bebas Neue',    weight: 400 },
    archivo:   { family: 'Archivo Black', weight: 400 },
    bangers:   { family: 'Bangers',       weight: 400 },
    righteous: { family: 'Righteous',     weight: 400 },
    passion:   { family: 'Passion One',   weight: 900 },
    kanit:     { family: 'Kanit',         weight: 800 },
    luckiest:  { family: 'Luckiest Guy',  weight: 400 },
};

async function cargarFuentesSubtitulos() {
    const select = document.getElementById('subs-fuente');
    if (!select) return;
    try {
        const { fuentes, default: porDefecto } = await apiCall('/fuentes-subtitulos', 'GET');
        select.innerHTML = fuentes.map(f => `<option value="${f.clave}">${f.familia}</option>`).join('');
        subsFuente = porDefecto || fuentes[0]?.clave || 'anton';
        select.value = subsFuente;
    } catch (e) {
        console.warn('No se pudo cargar el catálogo de tipografías, se usa Bangers por defecto:', e.message);
    }
}

function subsDibujarCuadricula(ctx) {
    const pasoX = SUBS_PLAYRES_X / 10;
    const pasoY = SUBS_PLAYRES_Y / 10;
    ctx.lineWidth = 2;
    for (let i = 1; i < 10; i++) {
        const tercioV = i === 3 || i === 7;
        ctx.strokeStyle = tercioV ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)';
        ctx.beginPath(); ctx.moveTo(i * pasoX, 0); ctx.lineTo(i * pasoX, SUBS_PLAYRES_Y); ctx.stroke();
        ctx.strokeStyle = tercioV ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)';
        ctx.beginPath(); ctx.moveTo(0, i * pasoY); ctx.lineTo(SUBS_PLAYRES_X, i * pasoY); ctx.stroke();
    }
}

function subsDibujarZonasSeguras(ctx) {
    ctx.fillStyle = 'rgba(255,60,60,0.16)';
    ctx.fillRect(0, 0, SUBS_PLAYRES_X, SUBS_LIMITE_ARRIBA);
    ctx.fillRect(0, SUBS_PLAYRES_Y - SUBS_LIMITE_ABAJO, SUBS_PLAYRES_X, SUBS_LIMITE_ABAJO);
    ctx.fillRect(SUBS_PLAYRES_X - SUBS_LIMITE_DERECHA, SUBS_LIMITE_ARRIBA,
                 SUBS_LIMITE_DERECHA, SUBS_PLAYRES_Y - SUBS_LIMITE_ARRIBA - SUBS_LIMITE_ABAJO);

    ctx.fillStyle = 'rgba(190,20,90,0.38)';
    ctx.fillRect(0, 0, SUBS_CORTE_LATERAL, SUBS_PLAYRES_Y);
    ctx.fillRect(SUBS_PLAYRES_X - SUBS_CORTE_LATERAL, 0, SUBS_CORTE_LATERAL, SUBS_PLAYRES_Y);

    ctx.setLineDash([18, 14]);
    ctx.lineWidth = 4;
    for (const z of SUBS_ZONAS_APPS) {
        ctx.strokeStyle = z.color;
        ctx.beginPath();
        ctx.moveTo(0, SUBS_PLAYRES_Y - z.abajo);
        ctx.lineTo(SUBS_PLAYRES_X - z.derecha, SUBS_PLAYRES_Y - z.abajo);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, z.arriba);
        ctx.lineTo(SUBS_PLAYRES_X - z.derecha, z.arriba);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(SUBS_PLAYRES_X - z.derecha, z.arriba);
        ctx.lineTo(SUBS_PLAYRES_X - z.derecha, SUBS_PLAYRES_Y - z.abajo);
        ctx.stroke();
    }
    ctx.setLineDash([]);
}

function dibujarPreviewSubs(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = SUBS_PLAYRES_X;
    canvas.height = SUBS_PLAYRES_Y;

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, SUBS_PLAYRES_X, SUBS_PLAYRES_Y);
    subsDibujarCuadricula(ctx);
    subsDibujarZonasSeguras(ctx);

    const f = SUBS_FUENTES_CSS[subsFuente] || SUBS_FUENTES_CSS.anton;
    let tam = subsTamano;
    ctx.font = `${f.weight} ${tam}px '${f.family}', sans-serif`;
    const ancho = ctx.measureText('PALABRA').width;
    if (ancho > SUBS_ANCHO_UTIL) {
        tam = Math.max(20, Math.floor(tam * (SUBS_ANCHO_UTIL / ancho)));
        ctx.font = `${f.weight} ${tam}px '${f.family}', sans-serif`;
    }

    const yTexto = SUBS_PLAYRES_Y - subsMarginV;
    ctx.strokeStyle = 'rgba(247,194,4,0.75)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 10]);
    ctx.beginPath(); ctx.moveTo(0, yTexto); ctx.lineTo(SUBS_PLAYRES_X, yTexto); ctx.stroke();
    ctx.setLineDash([]);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(4, tam * 0.06);
    ctx.strokeText('PALABRA', SUBS_PLAYRES_X / 2, yTexto);
    ctx.fillStyle = '#fff';
    ctx.fillText('PALABRA', SUBS_PLAYRES_X / 2, yTexto);
}

function initSubsPreview() {
    const slider = document.getElementById('subs-tamano');
    const numInput = document.getElementById('subs-tamano-num');
    const preview = document.getElementById('subs-preview');
    const canvas = document.getElementById('subs-preview-canvas');
    const selectFuente = document.getElementById('subs-fuente');
    const lecturaPos = document.getElementById('subs-pos-valor');
    if (!slider || !preview || !canvas) return;

    const repintar = () => {
        dibujarPreviewSubs(canvas);
        if (lecturaPos) lecturaPos.textContent = subsMarginV;
    };

    const fijarTamano = (nuevo) => {
        if (!Number.isFinite(nuevo)) return;
        subsTamano = Math.min(360, Math.max(80, Math.round(nuevo)));
        slider.value = subsTamano;
        if (numInput) numInput.value = subsTamano;
        repintar();
    };

    slider.addEventListener('input', () => fijarTamano(Number(slider.value)));
    numInput?.addEventListener('input', () => {
        if (numInput.value === '') return;
        fijarTamano(Number(numInput.value));
    });
    numInput?.addEventListener('blur', () => fijarTamano(subsTamano));

    selectFuente?.addEventListener('change', async () => {
        subsFuente = selectFuente.value;
        await asegurarFuenteCargada(subsFuente);
        repintar();
    });

    let arrastrando = false;
    const moverA = (clientY) => {
        const rect = preview.getBoundingClientRect();
        const desdeAbajoPx = Math.max(0, Math.min(rect.height, rect.bottom - clientY));
        subsMarginV = Math.round((desdeAbajoPx / rect.height) * SUBS_PLAYRES_Y);
        repintar();
    };
    preview.addEventListener('pointerdown', e => {
        arrastrando = true;
        preview.setPointerCapture(e.pointerId);
        moverA(e.clientY);
    });
    preview.addEventListener('pointermove', e => { if (arrastrando) moverA(e.clientY); });
    preview.addEventListener('pointerup', () => { arrastrando = false; });
    preview.addEventListener('pointercancel', () => { arrastrando = false; });

    if (numInput) numInput.value = subsTamano;
    asegurarFuenteCargada(subsFuente).then(repintar);
    repintar();
}

document.addEventListener('DOMContentLoaded', () => {
    if (!requireLogin()) return;

    aplicarIconos();
    document.querySelectorAll('.steps-grid .form-section[id]').forEach(el => actualizarStepBadge(el, el.dataset.status));
    log('✅ App iniciada');
    mostrarUsuario();
    cargarHistorial();
    observarSnap(document.querySelector('.col-procesos .scroll-snap-col'), '.form-section', 'x');
    const contPasos = contenedorPasos();
    if (contPasos) contPasos.addEventListener('scroll', actualizarPasosIndicador);
    actualizarPasosIndicador();
    cargarFuentesEnSelect('portada-fuente').then(initPortadaDiseno);
    cargarFuentesSubtitulos().then(initSubsPreview);
    initPortadaTamano();
    initPortadaCaja();
});
