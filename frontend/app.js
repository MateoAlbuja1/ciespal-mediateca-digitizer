/**
 * CIESPAL Mediateca - Digitalizador con IA Real (Google Gemini)
 * Estilo CamScanner con Previsualización, Reorganización, Repetición de Hojas y Carga de PDF.
 */

// Configuración de API Key para Google Gemini
function getApiKey() {
  return window.ENV_GEMINI_API_KEY || '';
}
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];

// Configuración de PDF.js para renderizar PDFs subidos
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

const state = {
  currentRecord: null,
  records: [],
  bookPagesBuffer: [],
  bookPagesBase64: [],
  cameraStream: null,
  cameraReady: false,
  facingMode: 'environment',
  retakeIndex: null,
  activeModalIndex: null,
  detectedBounds: null,     // Bordes detectados del documento en tiempo real
  liveDetectionRAF: null    // requestAnimationFrame ID para detección en vivo
};

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initEvents();
  renderKohaRecordsTable();
  
  // Iniciar cámara con delay para el WebView
  setTimeout(() => { requestCameraPermission(); }, 400);
});

// ========== NAVEGACIÓN ==========
function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-target');
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById(targetId)?.classList.add('active');
    });
  });
}

// ========== CÁMARA NATIVA ==========
async function requestCameraPermission() {
  const hint = document.getElementById('scan-hint');
  hint.textContent = 'Iniciando cámara...';
  
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hint.textContent = 'Cámara no disponible. Use "Cargar PDF" para procesar documentos.';
      return;
    }
    await startCamera();
  } catch (err) {
    console.error('Error cámara:', err);
    hint.textContent = 'Cámara no lista. Use "Cargar PDF" para procesar documentos.';
  }
}

async function startCamera() {
  const video = document.getElementById('camera-video');
  const hint = document.getElementById('scan-hint');
  
  try {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(t => t.stop());
      state.cameraStream = null;
    }
    
    const constraints = {
      video: {
        facingMode: { ideal: state.facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };
    
    state.cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = state.cameraStream;
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.muted = true;
    
    await video.play();
    state.cameraReady = true;
    
    if (state.retakeIndex !== null) {
      hint.textContent = `MODO REPETIR: Tome la nueva foto para la Hoja #${state.retakeIndex + 1}`;
    } else {
      hint.textContent = 'Encuadre la página del libro';
    }

  } catch (err) {
    console.error('Error cámara:', err);
    state.cameraReady = false;
    hint.textContent = 'Use "Cargar PDF" para subir y procesar un libro.';
  }
}

// ========== EVENTOS ==========
function initEvents() {
  document.getElementById('btn-shutter').addEventListener('click', capturePagePhoto);
  document.getElementById('btn-finish-pdf').addEventListener('click', processBookWithGeminiAI);
  document.getElementById('pdf-fallback').addEventListener('change', handlePDFUpload);
  
  document.getElementById('btn-toggle-camera').addEventListener('click', () => {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    startCamera();
  });
  
  document.getElementById('marc-form').addEventListener('submit', handleFormSubmit);
  document.getElementById('btn-download-csv').addEventListener('click', downloadKohaCSV);
  document.getElementById('btn-discard')?.addEventListener('click', () => {
    if (confirm('¿Descartar el escaneo actual?')) {
      resetScanBuffer();
      document.querySelector('[data-target="screen-capture"]').click();
    }
  });

  // Modal de Previsualización / Repetición
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-delete-page').addEventListener('click', deleteCurrentModalPage);
  document.getElementById('btn-retake-page').addEventListener('click', prepareRetakeFromModal);
}

// ========== HELPER DE CONVERSIÓN DE IMAGEN ==========
function dataURLToBlob(dataurl) {
  try {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  } catch (e) {
    return new Blob([], { type: 'image/jpeg' });
  }
}

// ========== CAPTURA DIRECTA CON RECORTE AUTOMÁTICO DE HOJA / LIBRO ==========
function capturePagePhoto() {
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('photo-canvas');
  
  if (!video || !video.videoWidth) {
    requestCameraPermission();
    return;
  }
  
  const fullW = video.videoWidth;
  const fullH = video.videoHeight;

  // 1. Renderizar frame completo a resolución máxima en canvas temporal
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = fullW;
  tempCanvas.height = fullH;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(video, 0, 0, fullW, fullH);

  // 2. Detectar bordes exactos de la hoja o portada del libro
  const bounds = detectSmartBookBounds(tempCtx, fullW, fullH);

  // 3. Recortar ÚNICAMENTE el área de la hoja descartando el fondo (armario, cobijas, piernas, dedos)
  canvas.width = bounds.w;
  canvas.height = bounds.h;
  const ctx = canvas.getContext('2d');

  ctx.filter = 'contrast(1.08) brightness(1.03)';
  ctx.drawImage(tempCanvas, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
  ctx.filter = 'none';

  // Obtener DataURL y Blob recortado de la hoja
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = dataUrl.split(',')[1];
  const blob = dataURLToBlob(dataUrl);

  // Efecto visual de flash blanco en la cámara al disparar
  const wrapper = document.querySelector('.viewfinder-wrapper');
  if (wrapper) {
    wrapper.style.opacity = '0.3';
    setTimeout(() => { wrapper.style.opacity = '1'; }, 120);
  }

  if (state.retakeIndex !== null) {
    // Modo reemplazar hoja existente
    const targetIdx = state.retakeIndex;
    state.bookPagesBuffer[targetIdx] = blob;
    state.bookPagesBase64[targetIdx] = base64;
    state.retakeIndex = null;
    document.getElementById('scan-hint').textContent = `Hoja #${targetIdx + 1} reemplazada y recortada`;
  } else {
    // Agregar nueva hoja al libro
    state.bookPagesBuffer.push(blob);
    state.bookPagesBase64.push(base64);
    document.getElementById('scan-hint').textContent = `Hoja #${state.bookPagesBuffer.length} recortada exitosamente`;
  }

  // Actualizar contador y renderizar carrusel de miniaturas inmediatamente
  updatePageCounter();
  renderThumbnails();
}

/**
 * Detecta automáticamente la superficie del libro recortando fondo, muebles, cobijas y manos.
 */
function detectSmartBookBounds(tempCtx, w, h) {
  try {
    const sw = 160;
    const sh = Math.round((h / w) * sw);
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sw;
    tempCanvas.height = sh;
    const tCtx = tempCanvas.getContext('2d');
    tCtx.drawImage(tempCtx.canvas, 0, 0, sw, sh);
    const pixels = tCtx.getImageData(0, 0, sw, sh).data;

    const getPix = (x, y) => {
      const idx = (y * sw + x) * 4;
      return {
        r: pixels[idx],
        g: pixels[idx + 1],
        b: pixels[idx + 2],
        lum: 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2]
      };
    };

    const diff = (p1, p2) => {
      return Math.abs(p1.lum - p2.lum) * 2 + Math.abs(p1.r - p2.r) + Math.abs(p1.g - p2.g) + Math.abs(p1.b - p2.b);
    };

    // 1. Escanear TOP
    let top = Math.floor(sh * 0.04);
    for (let y = Math.floor(sh * 0.04); y < Math.floor(sh * 0.42); y++) {
      let accum = 0;
      let count = 0;
      for (let x = Math.floor(sw * 0.25); x < Math.floor(sw * 0.75); x += 2) {
        accum += diff(getPix(x, y), getPix(x, y + 3));
        count++;
      }
      if ((accum / count) > 30) {
        top = y;
        break;
      }
    }

    // 2. Escanear BOTTOM
    let bottom = sh - Math.floor(sh * 0.04);
    for (let y = sh - Math.floor(sh * 0.04); y > Math.floor(sh * 0.58); y--) {
      let accum = 0;
      let count = 0;
      for (let x = Math.floor(sw * 0.25); x < Math.floor(sw * 0.75); x += 2) {
        accum += diff(getPix(x, y), getPix(x, y - 3));
        count++;
      }
      if ((accum / count) > 30) {
        bottom = y;
        break;
      }
    }

    // 3. Escanear LEFT
    let left = Math.floor(sw * 0.04);
    for (let x = Math.floor(sw * 0.04); x < Math.floor(sw * 0.38); x++) {
      let accum = 0;
      let count = 0;
      for (let y = Math.floor(sh * 0.25); y < Math.floor(sh * 0.75); y += 2) {
        accum += diff(getPix(x, y), getPix(x + 3, y));
        count++;
      }
      if ((accum / count) > 30) {
        left = x;
        break;
      }
    }

    // 4. Escanear RIGHT
    let right = sw - Math.floor(sw * 0.04);
    for (let x = sw - Math.floor(sw * 0.04); x > Math.floor(sw * 0.62); x--) {
      let accum = 0;
      let count = 0;
      for (let y = Math.floor(sh * 0.25); y < Math.floor(sh * 0.75); y += 2) {
        accum += diff(getPix(x, y), getPix(x - 3, y));
        count++;
      }
      if ((accum / count) > 30) {
        right = x;
        break;
      }
    }

    // Convertir a píxeles de resolución completa del video
    const scaleX = w / sw;
    const scaleY = h / sh;

    let realX = Math.round(left * scaleX);
    let realY = Math.round(top * scaleY);
    let realW = Math.round((right - left) * scaleX);
    let realH = Math.round((bottom - top) * scaleY);

    // Si la caja resultante es válida (más del 25% del encuadre), aplicar
    if (realW > w * 0.25 && realH > h * 0.25 && (realW < w || realH < h)) {
      realX = Math.max(0, realX - Math.round(w * 0.01));
      realY = Math.max(0, realY - Math.round(h * 0.01));
      realW = Math.min(w - realX, realW + Math.round(w * 0.02));
      realH = Math.min(h - realY, realH + Math.round(h * 0.02));
      return { x: realX, y: realY, w: realW, h: realH };
    }
  } catch (e) {
    console.warn('Error al detectar bordes:', e);
  }

  // Recorte por defecto si no hay bordes contrastados claros
  const marginX = Math.round(w * 0.08);
  const marginY = Math.round(h * 0.12);
  return {
    x: marginX,
    y: marginY,
    w: w - (marginX * 2),
    h: h - (marginY * 2)
  };
}

/**
 * Detecta automáticamente la superficie del libro para recortar teclados, mesas y sillas.
 */
function detectBookCoverBounds(ctx, w, h) {
  try {
    const imageData = ctx.getImageData(0, 0, w, h);
    const pixels = imageData.data;

    let top = Math.floor(h * 0.12);
    const step = 4;
    for (let y = Math.floor(h * 0.02); y < Math.floor(h * 0.35); y += step) {
      let rowVar = 0;
      for (let x = Math.floor(w * 0.2); x < Math.floor(w * 0.8); x += step * 3) {
        const idx = (y * w + x) * 4;
        const nextIdx = ((y + step) * w + x) * 4;
        rowVar += Math.abs(pixels[idx] - pixels[nextIdx]) + Math.abs(pixels[idx+1] - pixels[nextIdx+1]);
      }
      if (rowVar > 1200) {
        top = Math.max(top, y);
        break;
      }
    }

    let bottom = Math.floor(h * 0.88);
    for (let y = Math.floor(h * 0.98); y > Math.floor(h * 0.65); y -= step) {
      let rowVar = 0;
      for (let x = Math.floor(w * 0.2); x < Math.floor(w * 0.8); x += step * 3) {
        const idx = (y * w + x) * 4;
        const prevIdx = ((y - step) * w + x) * 4;
        rowVar += Math.abs(pixels[idx] - pixels[prevIdx]) + Math.abs(pixels[idx+1] - pixels[prevIdx+1]);
      }
      if (rowVar > 1200) {
        bottom = Math.min(bottom, y);
        break;
      }
    }

    const left = Math.floor(w * 0.06);
    const right = Math.floor(w * 0.94);

    const cropW = Math.max(100, right - left);
    const cropH = Math.max(100, bottom - top);

    return { x: left, y: top, w: cropW, h: cropH };
  } catch (e) {
    const marginX = Math.floor(w * 0.06);
    const marginY = Math.floor(h * 0.12);
    return {
      x: marginX,
      y: marginY,
      w: w - (marginX * 2),
      h: h - (marginY * 2)
    };
  }
}

/**
 * Detecta los bordes del documento (hoja de libro) en la imagen.
 * Busca la región rectangular clara (papel) contra el fondo más oscuro (mesa/escritorio).
 * Analiza filas y columnas de píxeles para encontrar dónde empieza y termina el papel.
 */
function detectDocumentEdges(ctx, w, h) {
  // Obtener datos de píxeles de la imagen completa
  const imageData = ctx.getImageData(0, 0, w, h);
  const pixels = imageData.data;

  // Calcular brillo promedio de cada fila y columna
  // Brillo = (R + G + B) / 3. El papel es brillante (>160), el fondo es oscuro (<120)

  // Umbral dinámico: calcular brillo promedio general
  let totalBrightness = 0;
  const sampleStep = 4; // Muestrear cada 4 píxeles para velocidad
  let sampleCount = 0;
  for (let i = 0; i < pixels.length; i += 4 * sampleStep) {
    totalBrightness += (pixels[i] + pixels[i+1] + pixels[i+2]) / 3;
    sampleCount++;
  }
  const avgBrightness = totalBrightness / sampleCount;
  
  // Umbral: el documento es más brillante que el promedio
  const threshold = Math.min(Math.max(avgBrightness * 0.85, 80), 200);

  // Escanear columnas de izquierda a derecha para encontrar borde izquierdo
  let left = 0;
  for (let x = 0; x < w; x++) {
    let brightPixels = 0;
    const totalSamples = Math.floor(h / sampleStep);
    for (let y = Math.floor(h * 0.15); y < Math.floor(h * 0.85); y += sampleStep) {
      const idx = (y * w + x) * 4;
      const brightness = (pixels[idx] + pixels[idx+1] + pixels[idx+2]) / 3;
      if (brightness > threshold) brightPixels++;
    }
    // Si más del 40% de los píxeles de esta columna son brillantes, es el borde del documento
    if (brightPixels / totalSamples > 0.4) {
      left = x;
      break;
    }
  }

  // Escanear columnas de derecha a izquierda para borde derecho
  let right = w - 1;
  for (let x = w - 1; x > left; x--) {
    let brightPixels = 0;
    const totalSamples = Math.floor(h / sampleStep);
    for (let y = Math.floor(h * 0.15); y < Math.floor(h * 0.85); y += sampleStep) {
      const idx = (y * w + x) * 4;
      const brightness = (pixels[idx] + pixels[idx+1] + pixels[idx+2]) / 3;
      if (brightness > threshold) brightPixels++;
    }
    if (brightPixels / totalSamples > 0.4) {
      right = x;
      break;
    }
  }

  // Escanear filas de arriba a abajo para borde superior
  let top = 0;
  for (let y = 0; y < h; y++) {
    let brightPixels = 0;
    const totalSamples = Math.floor((right - left) / sampleStep);
    for (let x = left; x < right; x += sampleStep) {
      const idx = (y * w + x) * 4;
      const brightness = (pixels[idx] + pixels[idx+1] + pixels[idx+2]) / 3;
      if (brightness > threshold) brightPixels++;
    }
    if (brightPixels / totalSamples > 0.4) {
      top = y;
      break;
    }
  }

  // Escanear filas de abajo a arriba para borde inferior
  let bottom = h - 1;
  for (let y = h - 1; y > top; y--) {
    let brightPixels = 0;
    const totalSamples = Math.floor((right - left) / sampleStep);
    for (let x = left; x < right; x += sampleStep) {
      const idx = (y * w + x) * 4;
      const brightness = (pixels[idx] + pixels[idx+1] + pixels[idx+2]) / 3;
      if (brightness > threshold) brightPixels++;
    }
    if (brightPixels / totalSamples > 0.4) {
      bottom = y;
      break;
    }
  }

  // Añadir pequeño padding interno (2%) para no cortar contenido del borde
  const padX = Math.floor((right - left) * 0.01);
  const padY = Math.floor((bottom - top) * 0.01);
  left = Math.max(0, left - padX);
  top = Math.max(0, top - padY);
  right = Math.min(w - 1, right + padX);
  bottom = Math.min(h - 1, bottom + padY);

  const cropW = right - left;
  const cropH = bottom - top;

  // Validar que el recorte detectado sea razonable (al menos 30% del frame original)
  if (cropW < w * 0.3 || cropH < h * 0.3) {
    // Si la detección falla, usar recorte conservador del 90% central
    const fallbackMarginX = Math.floor(w * 0.05);
    const fallbackMarginY = Math.floor(h * 0.05);
    return {
      x: fallbackMarginX,
      y: fallbackMarginY,
      w: w - fallbackMarginX * 2,
      h: h - fallbackMarginY * 2
    };
  }

  return { x: left, y: top, w: cropW, h: cropH };
}

// ========== CARGA DE ARCHIVO PDF (PROCESAMIENTO DIRECTO) ==========
async function handlePDFUpload(e) {
  const file = e.target.files[0];
  if (!file || file.type !== 'application/pdf') {
    alert('Por favor seleccione un archivo PDF válido.');
    return;
  }

  showProcessingOverlay('Leyendo y convirtiendo páginas del archivo PDF...', 15);

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdfDoc.numPages;

    resetScanBuffer();
    updateProcessingProgress(`Procesando ${numPages} páginas del PDF...`, 30);

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.2 });
      
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: ctx, viewport: viewport }).promise;

      // Convertir página a blob y base64
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const base64 = dataUrl.split(',')[1];
      
      const blob = await (await fetch(dataUrl)).blob();

      state.bookPagesBuffer.push(blob);
      state.bookPagesBase64.push(base64);

      const pct = 30 + Math.floor((pageNum / numPages) * 50);
      updateProcessingProgress(`Renderizando hoja ${pageNum} de ${numPages}...`, pct);
    }

    updatePageCounter();
    renderThumbnails();
    hideProcessingOverlay();

    alert(`Se cargó el PDF con ${numPages} hojas.\n\nPresione 'Compilar y Generar PDF' para extraer los metadatos con IA.`);
    document.getElementById('scan-hint').textContent = `PDF cargado: ${numPages} hojas. Presione 'Compilar y Generar PDF'.`;

  } catch (err) {
    hideProcessingOverlay();
    console.error('Error al leer PDF:', err);
    alert('No se pudo procesar el archivo PDF: ' + err.message);
  }

  e.target.value = '';
}

// ========== CARRUSEL DE MINIATURAS CAMSCANNER ==========
function renderThumbnails() {
  const bar = document.getElementById('thumbnails-bar');
  const container = document.getElementById('thumbnails-scroll');
  container.innerHTML = '';

  if (state.bookPagesBase64.length === 0) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');

  state.bookPagesBase64.forEach((b64, idx) => {
    const card = document.createElement('div');
    card.className = 'thumb-card';
    card.title = `Hoja #${idx + 1} (Clic para previsualizar / repetir)`;
    card.innerHTML = `
      <img src="data:image/jpeg;base64,${b64}" alt="Hoja ${idx + 1}">
      <span class="thumb-num">#${idx + 1}</span>
      <button type="button" class="thumb-remove" onclick="event.stopPropagation(); quickDeletePage(${idx})" title="Eliminar hoja">✕</button>
    `;
    card.addEventListener('click', () => openPageModal(idx));
    container.appendChild(card);
  });
}

function quickDeletePage(idx) {
  if (confirm(`¿Eliminar la Hoja #${idx + 1}?`)) {
    state.bookPagesBuffer.splice(idx, 1);
    state.bookPagesBase64.splice(idx, 1);
    
    if (state.retakeIndex === idx) state.retakeIndex = null;
    else if (state.retakeIndex > idx) state.retakeIndex--;

    updatePageCounter();
    renderThumbnails();
  }
}

// ========== MODAL DE PREVISUALIZACIÓN & REPETICIÓN DE HOJA ==========
function openPageModal(idx) {
  state.activeModalIndex = idx;
  const modal = document.getElementById('page-modal');
  document.getElementById('modal-page-title').textContent = `Hoja #${idx + 1} de ${state.bookPagesBuffer.length}`;
  document.getElementById('modal-page-img').src = `data:image/jpeg;base64,${state.bookPagesBase64[idx]}`;
  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('page-modal').classList.add('hidden');
  state.activeModalIndex = null;
}

function deleteCurrentModalPage() {
  if (state.activeModalIndex !== null) {
    quickDeletePage(state.activeModalIndex);
    closeModal();
  }
}

function prepareRetakeFromModal() {
  if (state.activeModalIndex !== null) {
    state.retakeIndex = state.activeModalIndex;
    closeModal();
    
    document.getElementById('scan-hint').textContent = 
      `MODO REPETIR: Tome la nueva foto para reemplazar la Hoja #${state.retakeIndex + 1}`;
    
    alert(`Listo. Presione el botón blanco de captura para reemplazar la Hoja #${state.retakeIndex + 1}.`);
  }
}

function updatePageCounter() {
  const count = state.bookPagesBuffer.length;
  document.getElementById('scanned-page-count').textContent = count;
  const btn = document.getElementById('btn-finish-pdf');
  count > 0 ? btn.classList.remove('hidden') : btn.classList.add('hidden');
}

function resetScanBuffer() {
  state.bookPagesBuffer = [];
  state.bookPagesBase64 = [];
  state.retakeIndex = null;
  updatePageCounter();
  renderThumbnails();
}

// ========== PROCESAMIENTO CON GEMINI AI REAL ==========
async function processBookWithGeminiAI() {
  if (state.bookPagesBuffer.length === 0) {
    alert('Primero tome fotos o cargue un PDF del libro.');
    return;
  }

  const totalPages = state.bookPagesBuffer.length;
  showProcessingOverlay('Enviando portadas a Google Gemini AI...', 10);

  try {
    // Tomar las primeras 4 hojas para análisis de metadatos (portada, créditos)
    const pagesToAnalyze = Math.min(state.bookPagesBase64.length, 4);
    updateProcessingProgress('Analizando metadatos del libro con Inteligencia Artificial...', 35);

    const imageParts = [];
    for (let i = 0; i < pagesToAnalyze; i++) {
      imageParts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data: state.bookPagesBase64[i]
        }
      });
    }

    const extractionPrompt = {
      contents: [{
        parts: [
          ...imageParts,
          {
            text: `You are a librarian expert. Look at these scanned book images carefully. Read ALL text visible in ANY language (English, Spanish, French, etc). Extract bibliographic metadata.

CRITICAL RULES:
- READ the title, authors, publisher, year, ISBN from the cover and credits pages
- The book may be in ANY language - read it in its original language
- If you see text like "AUTHORS:", "AUTORES:", read the names listed below
- If you see a publisher logo or name, extract it
- numero_paginas MUST be "${totalPages} p."
- For palabras_clave, generate 3-5 keywords based on the book topic
- For resumen, write a 1-2 sentence summary of what the book appears to be about
- NEVER leave titulo_principal empty - always put the main title you see
- Respond ONLY with valid JSON, no markdown, no explanation

Exact JSON format:
{
  "isbn": "",
  "titulo_principal": "",
  "subtitulo": "",
  "autor_principal": "",
  "autores_secundarios": "",
  "lugar_publicacion": "",
  "editorial": "",
  "anio_publicacion": "",
  "numero_paginas": "${totalPages} p.",
  "palabras_clave": "",
  "resumen": ""
}`
          }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1500
      }
    };

    updateProcessingProgress('Gemini AI estructurando registro MARC21...', 65);

    let response = null;
    let lastError = '';
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      for (const model of GEMINI_MODELS) {
        try {
          const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
          const res = await fetch(`${apiUrl}?key=${getApiKey()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(extractionPrompt)
          });

          if (res.ok) {
            response = res;
            break;
          } else {
            const errData = await res.json().catch(() => ({}));
            lastError = errData?.error?.message || `Error ${res.status}`;
            if (res.status === 429) {
              updateProcessingProgress(`Servidor Google Gemini ocupado. Reintentando (${attempt}/${maxAttempts})...`, 70);
            }
          }
        } catch (err) {
          lastError = err.message;
        }
      }

      if (response) break;

      if (attempt < maxAttempts) {
        // Pausa de 3 segundos para refrescar la cuota por minuto de Google
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (!response) {
      alert(`⚠️ Límite temporal de consultas de Google alcanzado:\n\nGoogle Gemini reportó límite de velocidad por minuto (HTTP 429).\n\nEspere 30 segundos y vuelva a presionar 'Compilar y Generar PDF' para reintentar la extracción de metadatos.`);
      throw new Error(`No se pudo conectar con Gemini AI: ${lastError}`);
    }

    let extracted = {};
    if (response) {
      const data = await response.json().catch(() => ({}));
      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      // Intentar extraer bloque JSON con regex
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          extracted = JSON.parse(jsonMatch[0]);
        } catch (e) {
          console.warn('No se pudo parsear el JSON de la IA, usando campos por defecto:', aiText);
        }
      }
    }

    updateProcessingProgress('Generando archivo PDF del libro digitalizado...', 90);

    const bookTitle = (extracted.titulo_principal || '').trim() || 'Documento_Digitalizado_CIESPAL';
    const sanitizedName = bookTitle.replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, '_');
    
    const record = {
      id: 'ciespal_' + Date.now().toString(36),
      isbn: extracted.isbn || '',
      titulo_principal: bookTitle,
      subtitulo: extracted.subtitulo || '',
      autor_principal: extracted.autor_principal || '',
      autores_secundarios: extracted.autores_secundarios || '',
      lugar_publicacion: extracted.lugar_publicacion || '',
      editorial: extracted.editorial || '',
      anio_publicacion: extracted.anio_publicacion || '',
      numero_paginas: extracted.numero_paginas || `${totalPages} p.`,
      palabras_clave: extracted.palabras_clave || '',
      resumen: extracted.resumen || '',
      enlace_documento: `${sanitizedName}.pdf`
    };

    updateProcessingProgress('¡Extracción MARC21 finalizada!', 100);

    // IMPORTANTE: Guardar las hojas ANTES de resetear el buffer
    state.savedPagesBase64 = [...state.bookPagesBase64];

    setTimeout(() => {
      hideProcessingOverlay();
      resetScanBuffer();
      onBookScanCompleted(record, totalPages);
    }, 400);

  } catch (err) {
    hideProcessingOverlay();
    console.warn('Procesamiento completado con plantilla por defecto:', err);
    
    // Guardar hojas antes de resetear
    state.savedPagesBase64 = [...state.bookPagesBase64];

    const fallbackRecord = {
      id: 'ciespal_' + Date.now().toString(36),
      isbn: '',
      titulo_principal: 'Documento_Digitalizado_CIESPAL',
      subtitulo: '',
      autor_principal: '',
      autores_secundarios: '',
      lugar_publicacion: 'Quito, Ecuador',
      editorial: 'CIESPAL',
      anio_publicacion: new Date().getFullYear().toString(),
      numero_paginas: `${totalPages} p.`,
      palabras_clave: 'CIESPAL, Mediateca',
      resumen: 'Documento digitalizado.',
      enlace_documento: 'Documento_Digitalizado_CIESPAL.pdf'
    };

    resetScanBuffer();
    onBookScanCompleted(fallbackRecord, totalPages);
  }
}

// ========== OVERLAY ==========
function showProcessingOverlay(text, progress) {
  document.getElementById('processing-overlay').classList.remove('hidden');
  document.getElementById('process-step-text').textContent = text;
  document.getElementById('progress-fill').style.width = `${progress}%`;
}

function updateProcessingProgress(text, progress) {
  document.getElementById('process-step-text').textContent = text;
  document.getElementById('progress-fill').style.width = `${progress}%`;
}

function hideProcessingOverlay() {
  document.getElementById('processing-overlay').classList.add('hidden');
}

// ========== RESULTADO DE ESCANEO ==========
function onBookScanCompleted(record, totalPages) {
  state.currentRecord = record;

  document.getElementById('record-id-badge').textContent = `ID: ${record.id}`;
  document.getElementById('field-titulo').value = record.titulo_principal || '';
  document.getElementById('field-subtitulo').value = record.subtitulo || '';
  document.getElementById('field-autor').value = record.autor_principal || '';
  document.getElementById('field-isbn').value = record.isbn || '';
  document.getElementById('field-editorial').value = record.editorial || '';
  document.getElementById('field-lugar').value = record.lugar_publicacion || '';
  document.getElementById('field-anio').value = record.anio_publicacion || '';
  document.getElementById('field-paginas').value = record.numero_paginas || `${totalPages} p.`;
  document.getElementById('field-pdf-url').value = record.enlace_documento || '';
  document.getElementById('field-autores-sec').value = record.autores_secundarios || '';
  document.getElementById('field-palabras-clave').value = record.palabras_clave || '';
  document.getElementById('field-resumen').value = record.resumen || '';

  const sanitizedPdfName = (record.titulo_principal || 'Documento_Digitalizado')
    .replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, '_') + '.pdf';

  const pdfCard = document.getElementById('pdf-generated-card');
  pdfCard.classList.remove('hidden');
  document.getElementById('pdf-filename-display').textContent = sanitizedPdfName;
  document.getElementById('pdf-pages-display').textContent = `${totalPages} hojas → 1 PDF Unificado`;

  document.getElementById('btn-open-pdf').onclick = () => {
    downloadCompiledPDF(sanitizedPdfName);
  };

  document.querySelector('[data-target="screen-review"]').click();
}

// ========== NOTIFICACIÓN NATIVA DE DESCARGA EN LA BARRA SUPERIOR DE ANDROID ==========
function triggerAndroidSystemDownload(base64Data, filename, mimeType) {
  if (window.AndroidDownloadManager && window.AndroidDownloadManager.downloadFile) {
    window.AndroidDownloadManager.downloadFile(base64Data, filename, mimeType);
    return true;
  }

  if (window.Capacitor?.Plugins?.Filesystem) {
    saveAndShareFileNative(base64Data, filename, mimeType);
    return true;
  }

  try {
    const dataUri = `data:${mimeType};base64,${base64Data}`;
    const a = document.createElement('a');
    a.href = dataUri;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
    }, 1000);
  } catch (err) {
    console.error('Fallback error:', err);
  }
  return false;
}

// ========== FUNCIÓN DE ALMACENAMIENTO FALLBACK ==========
async function saveAndShareFileNative(base64Data, filename, mimeType) {
  const Plugins = window.Capacitor?.Plugins;
  if (Plugins?.Filesystem) {
    try {
      const { Filesystem, Directory } = Plugins;
      await Filesystem.writeFile({
        path: filename,
        data: base64Data,
        directory: Directory.Documents,
        recursive: true
      });
      const uriResult = await Filesystem.getUri({
        path: filename,
        directory: Directory.Documents
      });
      if (Plugins.Share) {
        await Plugins.Share.share({
          title: filename,
          url: uriResult.uri
        }).catch(e => console.warn('Share:', e));
      }
    } catch (e) {
      console.warn('Filesystem native warning:', e);
    }
  }
}

// ========== DESCARGA CON NOTIFICACIÓN NATIVA EN BARRA DE ANDROID ==========
async function downloadCompiledPDF(filename) {
  const pages = state.savedPagesBase64 || state.bookPagesBase64;
  if (!pages || pages.length === 0) {
    alert('No hay hojas para generar el PDF.');
    return;
  }

  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');

    pages.forEach((b64, idx) => {
      if (idx > 0) pdf.addPage();
      pdf.addImage('data:image/jpeg;base64,' + b64, 'JPEG', 0, 0, 210, 297);
    });

    const dataUri = pdf.output('datauristring');
    const base64Data = dataUri.split(',')[1];

    // Activar notificación en la barra superior de Android
    triggerAndroidSystemDownload(base64Data, filename, 'application/pdf');

  } catch (err) {
    console.error('Error PDF:', err);
    alert('Error al generar PDF: ' + err.message);
  }
}

function showPDFViewerModal(dataUri, pagesBase64, filename) {
  const modal = document.getElementById('pdf-viewer-modal');
  const container = document.getElementById('pdf-modal-pages-container');
  document.getElementById('pdf-modal-title').textContent = `📄 ${filename}`;

  container.innerHTML = '';
  pagesBase64.forEach((b64, idx) => {
    const pageWrapper = document.createElement('div');
    pageWrapper.style.cssText = 'background: #222; border-radius: 8px; padding: 8px; text-align: center; color: #fff;';
    pageWrapper.innerHTML = `
      <div style="font-size: 0.75rem; margin-bottom: 6px; font-weight: bold;">Página ${idx + 1} de ${pagesBase64.length}</div>
      <img src="data:image/jpeg;base64,${b64}" style="max-width: 100%; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
    `;
    container.appendChild(pageWrapper);
  });

  modal.classList.remove('hidden');

  document.getElementById('btn-close-pdf-modal').onclick = () => {
    modal.classList.add('hidden');
  };

  document.getElementById('btn-open-external-pdf').onclick = async () => {
    const base64Data = dataUri.split(',')[1];
    triggerAndroidSystemDownload(base64Data, filename, 'application/pdf');
  };
}

// ========== GUARDAR REGISTRO Y DESCARGAR PDF ==========
async function handleFormSubmit(e) {
  e.preventDefault();

  const newTitle = document.getElementById('field-titulo').value;
  const sanitizedPdfName = newTitle.replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, '_') + '.pdf';

  const updatedRecord = {
    ...state.currentRecord,
    titulo_principal: newTitle,
    subtitulo: document.getElementById('field-subtitulo').value,
    autor_principal: document.getElementById('field-autor').value,
    isbn: document.getElementById('field-isbn').value,
    editorial: document.getElementById('field-editorial').value,
    lugar_publicacion: document.getElementById('field-lugar').value,
    anio_publicacion: document.getElementById('field-anio').value,
    numero_paginas: document.getElementById('field-paginas').value,
    enlace_documento: sanitizedPdfName,
    autores_secundarios: document.getElementById('field-autores-sec').value,
    palabras_clave: document.getElementById('field-palabras-clave').value,
    resumen: document.getElementById('field-resumen').value
  };

  const idx = state.records.findIndex(r => r.id === updatedRecord.id);
  if (idx >= 0) state.records[idx] = updatedRecord;
  else state.records.push(updatedRecord);

  renderKohaRecordsTable();

  // Guardar y descargar PDF con notificación en la barra de Android
  await downloadCompiledPDF(sanitizedPdfName);
  document.querySelector('[data-target="screen-export"]').click();
}

// ========== TABLA KOHA ==========
function renderKohaRecordsTable() {
  const tbody = document.getElementById('koha-records-body');
  tbody.innerHTML = '';
  document.getElementById('pending-count').textContent = state.records.length;

  if (state.records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px;">
      No hay libros catalogados en este lote. Escanee un libro o cargue un PDF.</td></tr>`;
    return;
  }

  state.records.forEach(rec => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${rec.isbn || '-'}</code></td>
      <td><strong>${rec.titulo_principal}</strong></td>
      <td>${rec.autor_principal}</td>
      <td>${rec.numero_paginas || '-'}</td>
      <td><code style="font-size:0.6rem;">${rec.enlace_documento}</code></td>
      <td><button class="btn-secondary" style="padding:4px 8px;font-size:0.68rem;" onclick="editRecord('${rec.id}')">Editar</button></td>
    `;
    tbody.appendChild(tr);
  });
}

window.editRecord = function(id) {
  const rec = state.records.find(r => r.id === id);
  if (rec) onBookScanCompleted(rec, parseInt(rec.numero_paginas) || 0);
};

// ========== EXPORTACIÓN Y DESCARGA DE CSV KOHA MARC21 ==========
async function downloadKohaCSV() {
  if (state.records.length === 0) {
    alert('No hay registros para exportar.');
    return;
  }

  const headers = ['020a','100a','245a','245b','700a','264a','264b','264c','300a','520a','650a','856u'];
  let csv = '\uFEFF' + headers.join(',') + '\n';

  state.records.forEach(rec => {
    csv += [
      esc(rec.isbn), esc(rec.autor_principal), esc(rec.titulo_principal),
      esc(rec.subtitulo), esc(rec.autores_secundarios), esc(rec.lugar_publicacion),
      esc(rec.editorial), esc(rec.anio_publicacion), esc(rec.numero_paginas),
      esc(rec.resumen), esc(rec.palabras_clave), esc(rec.enlace_documento)
    ].join(',') + '\n';
  });

  const filename = `ciespal_koha_marc21_${new Date().toISOString().slice(0,10)}.csv`;

  // Convertir string UTF-8 a Base64
  const utf8Bytes = new TextEncoder().encode(csv);
  let binary = '';
  for (let i = 0; i < utf8Bytes.byteLength; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  const base64Data = btoa(binary);

  // Activar notificación en la barra superior de Android
  triggerAndroidSystemDownload(base64Data, filename, 'text/csv');
}

function esc(str) {
  if (!str) return '""';
  return `"${str.replace(/"/g, '""')}"`;
}
