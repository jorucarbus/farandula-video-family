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

function setModo(modo) {
    if (modo === MODO) return;
    MODO = modo;
    document.getElementById('modo-selector').dataset.modo = modo;
    document.getElementById('producto-final-label').textContent = modo === 'video' ? 'Video' : 'Insumos';
    document.getElementById('btn-generate-video-label').textContent = cfg().finalLabel;
    state = { jobId: null, sourceData: null, selectedAngle: null, guion: null, fragments: null, audioToken: null, fuente: null, sesgo: 'neutral' };
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
    fuente: null,
    sesgo: 'neutral',
};

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
    updateProgress(0);
}
function hideProgress() {
    document.getElementById('progress-section').classList.add('hidden');
}

function mostrarError(mensaje, reintentarFn, volverStepId) {
    log(`❌ ${mensaje}`);
    document.getElementById('progress-section').classList.remove('hidden');
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

// PASO 1: Leer fuente
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

async function leerFuente(sourceType, sourceInput, sesgo) {
    try {
        state.fuente = { type: sourceType, content: sourceInput };
        state.sesgo = sesgo;
        state.selectedAngle = null;
        state.guion = null;
        state.fragments = null;
        state.audioToken = null;
        lockFrom('script-section');

        showProgress(`${icon('bookOpen')} Leyendo fuente...`);
        log(`📖 Iniciando lectura (sesgo: ${sesgo})...`);
        updateProgress(10);

        const result = await apiCall('/read', 'POST', { type: sourceType, content: sourceInput, sesgo });

        log('✅ Lectura completada');
        state.sourceData = result;
        state.jobId = result.jobId;
        updateProgress(30);

        document.getElementById('res-titulo').textContent = result.titulo;
        document.getElementById('res-descripcion').textContent = result.descripcion;
        document.getElementById('res-cronica').textContent = result.cronica;
        revealLectura();

        hideProgress();
        setStepStatus('fuente-section', 'done');
        setStepStatus('script-section', 'active');
        log('➡️ Selecciona un ángulo para continuar');
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

    resultInfo.innerHTML = `
        <p><strong>${icon('checkCircle')} Video generado exitosamente</strong></p>
        <p>${icon('hourglass')} Duración: ${resultado.duracion}s</p>
        <p><a class="btn btn-primary" href="${resultado.downloadUrl}">${icon('link')} Descargar video (${resultado.videoName})</a></p>
    `;
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
});
