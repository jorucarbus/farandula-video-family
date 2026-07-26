# Farandula Video - Familia

Video generator para familia: sin ElevenLabs, descarga local, autenticación por usuario.

**Diferencias vs app principal:**
- ✅ Upload de audio (MP3) en lugar de generar con ElevenLabs
- ✅ Videos se descargan localmente (no Drive)
- ✅ Insumos como ZIP (clips + locucion.mp3)
- ✅ Sistema de usuarios (login/registro)
- ✅ Historial per-user en PostgreSQL
- ✅ Carpeta de insumos se limpia cada 24h

## Setup Local (Phase 1)

### Requisitos
- Node.js 18+
- PostgreSQL 13+ (local o Railway)
- FFmpeg (ffmpeg-static incluido en deps)
- Google Gemini API key (compartida)

### Pasos

1. **Instalar dependencias**
   ```bash
   npm install
   ```

2. **Crear base de datos PostgreSQL**
   
   **Opción A (Local):**
   ```bash
   createdb farandula_family
   ```

   **Opción B (Railway - recomendado para producción):**
   - Crear nuevo proyecto en Railway.app
   - Agregar plugin PostgreSQL
   - Copiar CONNECTION STRING

3. **Configurar `.env` local**
   ```bash
   cp .env.example .env
   ```
   
   Editar `.env`:
   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/farandula_family
   GEMINI_API_KEY=sk_...
   JWT_SECRET=your-super-secret-key-min-32-chars
   NODE_ENV=development
   PORT=3000
   ```

4. **Ejecutar servidor**
   ```bash
   npm start
   ```

   Debe mostrar:
   ```
   ✅ Database connection successful
   ✅ Database schema initialized
   🔄 Cleanup cron started
   🚀 Server running on http://localhost:3000
   ```

5. **Abrir app**
   - URL: http://localhost:3000
   - Redirige a `/login.html`
   - Crear cuenta: cualquier email + password (min 8 chars, mayús, minús, número)

## Estructura

```
.
├── auth.js               # JWT + bcrypt
├── db.js                 # PostgreSQL queries
├── cleanupCron.js        # Limpia insumos cada 6h
├── server.js             # Express + endpoints
├── gemini.js             # Gemini AI (copiado)
├── video.js              # Video composition (copiado)
├── seleccion.js          # Random clip selection (copiado)
├── public/
│   ├── login.html        # Login/signup UI
│   ├── index.html        # App principal (copiada, pendiente adaptación)
│   ├── app.js            # Frontend logic (copiada, pendiente adaptación)
│   ├── style.css         # Styles (copiada)
│   ├── icons.js          # SVG icons (copiado)
│   └── fonts/            # Tipografía local (copiada)
└── package.json

temp-videos/             # Almacenamiento temporal (audio, video MP4)
temp-insumos/            # Carpetas de insumos (limpiadas a 24h)
```

## Fases Pendientes

- **Phase 2**: Modificar `public/app.js` Step 5 (upload audio en lugar de ElevenLabs)
- **Phase 3**: Quitar referencias a Drive, agregar descargas locales
- **Phase 4**: Completar auth middleware en todos los endpoints
- **Phase 5**: Implementar cleanup cron + validar en Railway
- **Phase 6**: Deploy a Railway + testing e2e

## Notas

- `GEMINI_API_KEY` es compartida entre todos los usuarios (no por usuario)
- Los videos descargados son efímeros (se borran de temp-videos/ cada 1h)
- La carpeta de insumos se limpia a 24h (en dev, configurable a 1min para testing)
- No hay Drive (sin backup en cloud, usuario maneja local)
