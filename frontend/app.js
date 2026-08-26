/**
 * CIESPAL Mediateca - Digitalizador con IA Real (Google Gemini)
 * Estilo CamScanner con Previsualización, Reorganización, Repetición de Hojas y Carga de PDF.
 */

// Sistema de Gestión y Rotación Automática de Múltiples Claves API (Google Gemini)
function getApiKeys() {
  const stored = localStorage.getItem('ciespal_gemini_keys');
  if (stored) {
    const keys = stored.split(/[\n,;]/).map(k => k.trim()).filter(k => k.length > 8);
    if (keys.length > 0) return keys;
  }
  if (window.ENV_GEMINI_API_KEYS && Array.isArray(window.ENV_GEMINI_API_KEYS) && window.ENV_GEMINI_API_KEYS.length > 0) {
    return window.ENV_GEMINI_API_KEYS.filter(k => k && k.length > 8);
  }
  if (window.ENV_GEMINI_API_KEY && window.ENV_GEMINI_API_KEY.length > 8) {
    return [window.ENV_GEMINI_API_KEY];
  }
  return [];
}

function getApiKey() {
  const keys = getApiKeys();
  if (keys.length === 0) return '';
  const idx = (state.currentKeyIndex || 0) % keys.length;
  return keys[idx];
}

const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

// Configuración de PDF.js para renderizar PDFs subidos
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

const state = {
  currentRecord: null,
  records: [],
  bookPagesBuffer: [],
  bookPagesBase64: [],
  detectedIndexPages: [],
  currentKeyIndex: 0,       // Índice para rotación automática de claves API
  scanFilterMode: 'magic_color', // 'magic_color' (Fondo Blanco Inteligente), 'bw' (B/N OpenCV), 'original'
  cameraStream: null,
  cameraReady: false,
  facingMode: 'environment',
  retakeIndex: null,
  savedPagesBase64: [],
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

  // Selector de Filtro de Imagen (Realce / B/N OpenCV / Original)
  const btnFilter = document.getElementById('btn-filter-mode');
  if (btnFilter) {
    const modes = ['magic_color', 'bw', 'original'];
    const modeNames = {
      'magic_color': 'Filtro: ✨ Realce Inteligente (Fondo Blanco Limpio)',
      'bw': 'Filtro: 📄 B/N Nítido (OpenCV Adaptive Threshold)',
      'original': 'Filtro: 📸 Color Original'
    };
    btnFilter.addEventListener('click', () => {
      const curr = state.scanFilterMode || 'magic_color';
      const nextIdx = (modes.indexOf(curr) + 1) % modes.length;
      state.scanFilterMode = modes[nextIdx];
      const hint = document.getElementById('scan-hint');
      if (hint) hint.textContent = modeNames[state.scanFilterMode];
      alert(modeNames[state.scanFilterMode]);
    });
  }

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

// ========== CAPTURA DIRECTA CON RECORTE AUTOMÁTICO ESTILO ADOBE SCAN / OPENCV ==========
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

  // 2. Intentar recorte de 4 esquinas y transformación de perspectiva estilo Adobe Scan con OpenCV.js
  let openCvSuccess = false;
  try {
    openCvSuccess = autoCropPerspectiveOpenCV(tempCanvas, canvas);
  } catch (err) {
    console.warn('Error OpenCV:', err);
  }

  // 3. Si OpenCV no detectó un cuadrilátero claro, usar recorte de gradiente inteligente
  if (!openCvSuccess) {
    const bounds = detectSmartBookBounds(tempCtx, fullW, fullH);
    canvas.width = bounds.w;
    canvas.height = bounds.h;
    const ctx = canvas.getContext('2d');

    ctx.filter = 'contrast(1.08) brightness(1.03)';
    ctx.drawImage(tempCanvas, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
    ctx.filter = 'none';
  }

  // 4. Aplicar Filtro de Realce de Documento OpenCV (Fondo Blanco Limpio / B/N Nítido)
  enhanceDocumentWithOpenCV(canvas, state.scanFilterMode || 'magic_color');

  // Obtener DataURL y Blob recortado y realzado de la hoja
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
    document.getElementById('scan-hint').textContent = `Hoja #${targetIdx + 1} reemplazada y realzada`;
  } else {
    // Agregar nueva hoja al libro
    state.bookPagesBuffer.push(blob);
    state.bookPagesBase64.push(base64);
    document.getElementById('scan-hint').textContent = `Hoja #${state.bookPagesBuffer.length} escaneada y realzada`;
  }

  // Actualizar contador y renderizar carrusel de miniaturas inmediatamente
  updatePageCounter();
  renderThumbnails();
}

/**
 * Filtro de Realce de Documento OpenCV (Estilo CamScanner / Ventana 'Processed' de OpenCV).
 * Limpia el fondo del papel a blanco puro (#FFFFFF) y aumenta la nitidez y contraste del texto.
 */
function enhanceDocumentWithOpenCV(canvas, mode = 'magic_color') {
  if (!canvas || canvas.width === 0 || canvas.height === 0 || mode === 'original') return;

  if (typeof cv !== 'undefined' && cv.Mat && cv.imread) {
    try {
      const src = cv.imread(canvas);
      
      if (mode === 'bw') {
        // Modo B/N Nítido (OpenCV Adaptive Threshold - como la ventana 'Processed' del video)
        const gray = new cv.Mat();
        const dst = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.adaptiveThreshold(gray, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 10);
        cv.imshow(canvas, dst);
        gray.delete();
        dst.delete();
        src.delete();
        return;
      } else {
        // Modo Realce Inteligente (Magic Color - Fondo blanco puro conservando colores)
        const enhanced = new cv.Mat();
        cv.convertScaleAbs(src, enhanced, 1.22, -18);
        cv.imshow(canvas, enhanced);
        enhanced.delete();
        src.delete();
        return;
      }
    } catch (err) {
      console.warn('Fallback enhanceDocument:', err);
    }
  }

  // Fallback rápido con Canvas 2D
  try {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      if (mode === 'bw') {
        const val = lum > 135 ? 255 : 0;
        d[i] = val; d[i+1] = val; d[i+2] = val;
      } else {
        if (lum > 165) {
          d[i] = Math.min(255, d[i] * 1.18);
          d[i+1] = Math.min(255, d[i] * 1.18);
          d[i+2] = Math.min(255, d[i] * 1.18);
        } else if (lum < 115) {
          d[i] = Math.max(0, d[i] * 0.82);
          d[i+1] = Math.max(0, d[i] * 0.82);
          d[i+2] = Math.max(0, d[i] * 0.82);
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  } catch (e) {}
}

/**
 * Recorte automático de 4 esquinas y desalabeo de perspectiva usando OpenCV.js (Estilo Adobe Scan).
 */
function autoCropPerspectiveOpenCV(srcCanvas, dstCanvas) {
  if (typeof cv === 'undefined' || !cv.Mat || !cv.imread) {
    return false;
  }

  try {
    const src = cv.imread(srcCanvas);
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    // 1. Convertir a grises y suavizar ruido
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    // 2. Detección de bordes Canny
    cv.Canny(blur, edges, 75, 200);

    // 3. Encontrar contornos
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let maxArea = 0;
    let maxContourIndex = -1;
    let bestPoly = null;
    const imgArea = src.rows * src.cols;

    // Buscar el contorno cuadrilátero de 4 esquinas más grande (área > 10% del total)
    for (let i = 0; i < contours.size(); ++i) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area > imgArea * 0.10 && area > maxArea) {
        const peri = cv.arcLength(cnt, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

        if (approx.rows === 4) {
          maxArea = area;
          maxContourIndex = i;
          bestPoly = approx;
        } else {
          approx.delete();
        }
      }
    }

    if (maxContourIndex >= 0 && bestPoly) {
      const pts = [];
      for (let i = 0; i < 4; i++) {
        pts.push({
          x: bestPoly.data32S[i * 2],
          y: bestPoly.data32S[i * 2 + 1]
        });
      }
      bestPoly.delete();

      // Ordenar 4 puntos: [Top-Left, Top-Right, Bottom-Right, Bottom-Left]
      pts.sort((a, b) => a.y - b.y);
      const topPts = [pts[0], pts[1]].sort((a, b) => a.x - b.x);
      const botPts = [pts[2], pts[3]].sort((a, b) => a.x - b.x);

      const tl = topPts[0];
      const tr = topPts[1];
      const br = botPts[1];
      const bl = botPts[0];

      // Dimensiones del rectángulo de salida
      const widthA = Math.hypot(br.x - bl.x, br.y - bl.y);
      const widthB = Math.hypot(tr.x - tl.x, tr.y - tl.y);
      const maxWidth = Math.max(widthA, widthB);

      const heightA = Math.hypot(tr.x - br.x, tr.y - br.y);
      const heightB = Math.hypot(tl.x - bl.x, tl.y - bl.y);
      const maxHeight = Math.max(heightA, heightB);

      if (maxWidth < 100 || maxHeight < 100) {
        src.delete(); gray.delete(); blur.delete(); edges.delete();
        contours.delete(); hierarchy.delete();
        return false;
      }

      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        tl.x, tl.y,
        tr.x, tr.y,
        br.x, br.y,
        bl.x, bl.y
      ]);
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        maxWidth - 1, 0,
        maxWidth - 1, maxHeight - 1,
        0, maxHeight - 1
      ]);

      // Transformación de perspectiva estilo Adobe Scan
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      const dst = new cv.Mat();
      const dsize = new cv.Size(maxWidth, maxHeight);
      cv.warpPerspective(src, dst, M, dsize);

      // Renderizar resultado en canvas de salida
      dstCanvas.width = maxWidth;
      dstCanvas.height = maxHeight;
      cv.imshow(dstCanvas, dst);

      // Limpieza de memoria WebAssembly
      src.delete(); gray.delete(); blur.delete(); edges.delete();
      contours.delete(); hierarchy.delete(); srcTri.delete();
      dstTri.delete(); M.delete(); dst.delete();

      return true; // Éxito en recorte y enderezado estilo Adobe Scan
    }

    src.delete(); gray.delete(); blur.delete(); edges.delete();
    contours.delete(); hierarchy.delete();
    return false;

  } catch (err) {
    console.warn('Fallback OpenCV autoCrop:', err);
    return false;
  }
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

    state.detectedIndexPages = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);

      // Buscar texto del índice en la página mediante PDF.js
      try {
        const textContent = await page.getTextContent();
        const textStr = textContent.items.map(item => item.str).join(' ').toUpperCase();
        if (textStr.includes('ÍNDICE') || textStr.includes('INDICE') || textStr.includes('TABLA DE CONTENIDOS') || textStr.includes('CONTENIDOS') || textStr.includes('SUMARIO') || textStr.includes('INDEX')) {
          state.detectedIndexPages.push(pageNum - 1); // 0-indexed
        }
      } catch (e) {
        // Ignorar si el PDF no tiene capa de texto libre
      }

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
      updateProcessingProgress(`Renderizando y analizando página ${pageNum} de ${numPages}...`, pct);
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

// ========== HELPER DE COMPRESIÓN DE IMÁGENES PARA PAYLOAD IA (MAX 800PX) ==========
async function resizeBase64ForAi(base64Str, maxDim = 800) {
  // Timeout de 8 segundos para evitar que onload se congele en Android WebView
  return Promise.race([
    new Promise((resolve) => {
      try {
        const img = new Image();
        img.src = 'data:image/jpeg;base64,' + base64Str;
        img.onload = () => {
          try {
            let w = img.width;
            let h = img.height;
            if (w > maxDim || h > maxDim) {
              if (w > h) {
                h = Math.round((h * maxDim) / w);
                w = maxDim;
              } else {
                w = Math.round((w * maxDim) / h);
                h = maxDim;
              }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            const resizedDataUrl = canvas.toDataURL('image/jpeg', 0.75);
            resolve(resizedDataUrl.split(',')[1]);
          } catch (canvasErr) {
            console.warn('Canvas resize falló, usando original:', canvasErr);
            resolve(base64Str);
          }
        };
        img.onerror = () => resolve(base64Str);
      } catch (e) {
        resolve(base64Str);
      }
    }),
    new Promise((resolve) => setTimeout(() => {
      console.warn('resizeBase64ForAi: timeout de 8s alcanzado, usando imagen original');
      resolve(base64Str);
    }, 8000))
  ]);
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
    // Enviar TODAS las páginas del libro a la IA para lectura completa
    const totalBookPages = state.bookPagesBase64.length;

    updateProcessingProgress(`Comprimiendo ${totalBookPages} páginas para IA...`, 15);

    const imageParts = [];
    for (let i = 0; i < totalBookPages; i++) {
      try {
        // Comprimir a 600px y calidad 0.5 para que quepan todas las páginas
        const compressedB64 = await resizeBase64ForAi(state.bookPagesBase64[i], 600);
        imageParts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: compressedB64
          }
        });
      } catch (e) {
        imageParts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: state.bookPagesBase64[i]
          }
        });
      }
      // Actualizar progreso cada 5 páginas
      if (i % 5 === 0) {
        updateProcessingProgress(`Comprimiendo página ${i + 1} de ${totalBookPages}...`, 15 + Math.round((i / totalBookPages) * 25));
      }
    }

    updateProcessingProgress(`Enviando ${imageParts.length} páginas completas a Gemini AI...`, 45);

    const extractionPrompt = {
      contents: [{
        parts: [
          ...imageParts,
          {
            text: `Eres un bibliotecario experto y catalogador MARC21. Se te proporcionan TODAS las ${totalPages} páginas escaneadas de un libro. Examínalas con máximo detalle.

REGLAS ESTRICTAS PARA TABLA DE CONTENIDOS / ÍNDICE (tabla_contenidos):
1. BUSCA en TODAS las imágenes proporcionadas cualquier página titulada "ÍNDICE", "CONTENIDO", "TABLA DE CONTENIDOS", "SUMARIO", "INDEX", "TABLE OF CONTENTS".
2. SI ENCUENTRAS una página de índice/contenido en el documento, TRANSCRÍBELA EXACTAMENTE tal como aparece en la imagen, LÍNEA POR LÍNEA, SIN MODIFICAR NADA, SIN INVENTAR NADA. Copia cada título de capítulo, sección, subsección y número de página exactamente como está escrito.
3. SOLO SI NO EXISTE ninguna página de índice en todo el documento, ENTONCES genera un índice estructurado basándote en los títulos de capítulos y secciones que veas EN LAS PÁGINAS PROPORCIONADAS. NO inventes títulos ni secciones que no existan en el documento.
4. NUNCA inventes contenido. Solo transcribe lo que ves o genera basándote estrictamente en lo visible.

REGLAS DE EXTRACCIÓN DE CAMPOS:
- titulo: Título principal del documento (exacto como aparece en la portada)
- autor_principal: Autor principal formato "Apellido, Nombre"
- colaboradores: Coautores, editores, ilustradores (separados por | si hay varios)
- lugar_publicacion: Ciudad y/o país de publicación
- editorial: Nombre de la editorial
- anio_publicacion: Año de publicación o copyright
- descripcion_fisica: Descripción física ej. "${totalPages} pág. 27 cm"
- notas_fisicas: Condición física o características del ejemplar
- tipo_material: Tipo de material (por defecto "Texto")
- temas: Descriptores o palabras clave del contenido (separados por |)
- clasificacion: Código de clasificación si es visible
- resumen: Resumen breve del contenido del documento
- tabla_contenidos: Índice/Tabla de contenidos (TRANSCRITA EXACTA si existe, o generada si no existe)

Responde SOLO con JSON válido, sin formato markdown, sin bloques de código.

{
  "isbn": "",
  "titulo": "",
  "subtitulo": "",
  "autor_principal": "",
  "colaboradores": "",
  "lugar_publicacion": "",
  "editorial": "",
  "anio_publicacion": "",
  "descripcion_fisica": "${totalPages} pág. 27 cm",
  "notas_fisicas": "",
  "tipo_material": "Texto",
  "temas": "",
  "clasificacion": "",
  "resumen": "",
  "tabla_contenidos": ""
}`
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 16384
      }
    };

    updateProcessingProgress('Gemini AI estructurando registro MARC21...', 65);

    const apiKeys = getApiKeys();
    if (!apiKeys || apiKeys.length === 0) {
      throw new Error('No se ha configurado ninguna Clave API de Google Gemini. Por favor configure su clave en el ícono de llave (🔑) del encabezado.');
    }
    let response = null;
    let lastError = '';

    // Buche de rotación automática: prueba cada clave API si la anterior agota su cuota
    for (let kAttempt = 0; kAttempt < apiKeys.length; kAttempt++) {
      const activeIdx = (state.currentKeyIndex + kAttempt) % apiKeys.length;
      const currentKey = apiKeys[activeIdx];

      for (const model of GEMINI_MODELS) {
        try {
          const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
          const res = await fetch(`${apiUrl}?key=${currentKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(extractionPrompt)
          });

          if (res.ok) {
            response = res;
            state.currentKeyIndex = activeIdx; // Guardar clave activa exitosa
            break;
          } else {
            const errData = await res.json().catch(() => ({}));
            lastError = errData?.error?.message || `Error ${res.status}`;
            if (res.status === 429 || res.status === 403) {
              const nextNum = ((activeIdx + 1) % apiKeys.length) + 1;
              updateProcessingProgress(`Clave #${activeIdx + 1} en límite. Rotando automáticamente a Clave #${nextNum}...`, 75);
            }
          }
        } catch (err) {
          lastError = err.message;
        }
      }

      if (response) break;
    }

    if (!response) {
      console.warn('Gemini API no disponible en ninguna clave:', lastError);
      throw new Error(`Conexión Gemini: ${lastError}`);
    }

    let extracted = {};
    if (response) {
      const data = await response.json().catch(() => ({}));
      let aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      // Limpiar bloques de código markdown que Gemini a veces envuelve (```json ... ```)
      aiText = aiText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      
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

    const bookTitle = (extracted.titulo || extracted.titulo_principal || '').trim() || 'Documento_Digitalizado_CIESPAL';
    const sanitizedName = bookTitle.replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, '_');
    
    const record = {
      id: 'ciespal_' + Date.now().toString(36),
      isbn: extracted.isbn || '',
      titulo_principal: bookTitle,
      subtitulo: extracted.subtitulo || '',
      autor_principal: extracted.autor_principal || '',
      colaboradores: extracted.colaboradores || extracted.autores_secundarios || '',
      lugar_publicacion: extracted.lugar_publicacion || '',
      editorial: extracted.editorial || '',
      anio_publicacion: extracted.anio_publicacion || '',
      descripcion_fisica: extracted.descripcion_fisica || `${totalPages} pág. 27 cm`,
      notas_fisicas: extracted.notas_fisicas || '',
      tipo_material: extracted.tipo_material || 'Texto',
      temas: extracted.temas || extracted.palabras_clave || '',
      clasificacion: extracted.clasificacion || '',
      resumen: extracted.resumen || '',
      tabla_contenidos: extracted.tabla_contenidos || '',
      url_recurso_en_linea: `${sanitizedName}.pdf`,
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
    console.error('Error en procesamiento con IA:', err);
    
    // Mostrar el error real al usuario en vez de fallar silenciosamente
    const errorMsg = err.message || 'Error desconocido';
    alert(`⚠️ Error al procesar con IA:\n${errorMsg}\n\nSe cargará una plantilla vacía para completar manualmente.`);
    
    // Guardar hojas antes de resetear
    state.savedPagesBase64 = [...state.bookPagesBase64];

    const fallbackRecord = {
      id: 'ciespal_' + Date.now().toString(36),
      isbn: '',
      titulo_principal: 'Documento_Digitalizado_CIESPAL',
      subtitulo: '',
      autor_principal: '',
      colaboradores: '',
      lugar_publicacion: '',
      editorial: '',
      anio_publicacion: '',
      descripcion_fisica: `${totalPages} pág. 27 cm`,
      notas_fisicas: '',
      tipo_material: 'Texto',
      temas: '',
      clasificacion: '',
      resumen: '',
      tabla_contenidos: '',
      url_recurso_en_linea: 'Documento_Digitalizado_CIESPAL.pdf',
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
  document.getElementById('field-paginas').value = record.descripcion_fisica || record.numero_paginas || `${totalPages} pág. 27 cm`;
  document.getElementById('field-pdf-url').value = record.url_recurso_en_linea || record.enlace_documento || '';
  document.getElementById('field-notas-fisicas').value = record.notas_fisicas || '';
  document.getElementById('field-tipo-material').value = record.tipo_material || 'Texto';
  document.getElementById('field-clasificacion').value = record.clasificacion || '';
  document.getElementById('field-autores-sec').value = record.colaboradores || record.autores_secundarios || '';
  document.getElementById('field-palabras-clave').value = record.temas || record.palabras_clave || '';
  document.getElementById('field-resumen').value = record.resumen || '';
  document.getElementById('field-tabla-contenidos').value = record.tabla_contenidos || '';

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
    descripcion_fisica: document.getElementById('field-paginas').value,
    numero_paginas: document.getElementById('field-paginas').value,
    url_recurso_en_linea: sanitizedPdfName,
    enlace_documento: sanitizedPdfName,
    notas_fisicas: document.getElementById('field-notas-fisicas').value,
    tipo_material: document.getElementById('field-tipo-material').value,
    clasificacion: document.getElementById('field-clasificacion').value,
    colaboradores: document.getElementById('field-autores-sec').value,
    autores_secundarios: document.getElementById('field-autores-sec').value,
    temas: document.getElementById('field-palabras-clave').value,
    palabras_clave: document.getElementById('field-palabras-clave').value,
    resumen: document.getElementById('field-resumen').value,
    tabla_contenidos: document.getElementById('field-tabla-contenidos').value
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

  state.records.forEach((rec, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${rec.isbn || '-'}</code></td>
      <td><strong>${rec.titulo_principal}</strong></td>
      <td>${rec.autor_principal}</td>
      <td>${rec.numero_paginas || '-'}</td>
      <td><code style="font-size:0.6rem;">${rec.enlace_documento}</code></td>
      <td style="display:flex;gap:4px;flex-direction:column;">
        <button class="btn-secondary" style="padding:4px 8px;font-size:0.68rem;" onclick="editRecord('${rec.id}')">Editar</button>
        <button class="btn-primary" style="padding:4px 8px;font-size:0.68rem;" onclick="downloadSingleCSV('${rec.id}', ${idx})">CSV</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.editRecord = function(id) {
  const rec = state.records.find(r => r.id === id);
  if (rec) onBookScanCompleted(rec, parseInt(rec.numero_paginas) || 0);
};

window.downloadSingleCSV = async function(id, index = 0) {
  const rec = state.records.find(r => r.id === id);
  if (!rec) return;
  await generateAndDownloadCSV(rec, index);
};

// ========== EXPORTACIÓN Y DESCARGA CSV KOHA MARC21 ==========
async function downloadKohaCSV() {
  if (state.records.length === 0) {
    alert('No hay registros para exportar.');
    return;
  }

  // Descargar cada registro como un CSV independiente
  for (let recIdx = 0; recIdx < state.records.length; recIdx++) {
    await generateAndDownloadCSV(state.records[recIdx], recIdx);
    // Pequeña pausa entre descargas múltiples
    if (state.records.length > 1 && recIdx < state.records.length - 1) {
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

async function generateAndDownloadCSV(rec, index = 0) {
  const sep = ';';
  let csv = '\uFEFF';

  // Encabezado del libro
  csv += escCsv('FICHA BIBLIOGRÁFICA MARC21') + sep + escCsv(rec.titulo_principal || 'Documento Digitalizado') + '\n';
  csv += sep + '\n';

  // Sección: Identificación de la Obra
  csv += escCsv('IDENTIFICACIÓN DE LA OBRA') + sep + '\n';
  csv += escCsv('020a — ISBN') + sep + escCsv(rec.isbn) + '\n';
  csv += escCsv('245a — Título') + sep + escCsv(rec.titulo_principal) + '\n';
  csv += escCsv('245b — Subtítulo') + sep + escCsv(rec.subtitulo) + '\n';
  csv += escCsv('100a — Autor Principal') + sep + escCsv(rec.autor_principal) + '\n';
  csv += escCsv('700a — Colaboradores') + sep + escCsv(rec.colaboradores || rec.autores_secundarios) + '\n';
  csv += sep + '\n';

  // Sección: Publicación y Descripción Física
  csv += escCsv('PUBLICACIÓN Y DESCRIPCIÓN FÍSICA') + sep + '\n';
  csv += escCsv('264a — Lugar de Publicación') + sep + escCsv(rec.lugar_publicacion) + '\n';
  csv += escCsv('264b — Editorial') + sep + escCsv(rec.editorial) + '\n';
  csv += escCsv('264c — Año de Publicación') + sep + escCsv(rec.anio_publicacion) + '\n';
  csv += escCsv('300a — Descripción Física') + sep + escCsv(rec.descripcion_fisica || rec.numero_paginas) + '\n';
  csv += escCsv('500a — Notas Físicas') + sep + escCsv(rec.notas_fisicas) + '\n';
  csv += escCsv('Naturaleza — Tipo de Material') + sep + escCsv(rec.tipo_material || 'Texto') + '\n';
  csv += sep + '\n';

  // Sección: Indexación y Clasificación
  csv += escCsv('INDEXACIÓN Y CLASIFICACIÓN') + sep + '\n';
  csv += escCsv('650a — Temas') + sep + escCsv(rec.temas || rec.palabras_clave) + '\n';
  csv += escCsv('090a — Clasificación') + sep + escCsv(rec.clasificacion) + '\n';
  csv += escCsv('520a — Resumen') + sep + escCsv(rec.resumen) + '\n';
  csv += sep + '\n';

  // Sección: Tabla de Contenidos
  csv += escCsv('TABLA DE CONTENIDOS') + sep + '\n';
  const tocText = rec.tabla_contenidos || '';
  const tocEntries = tocText.split(/[\n\r|]+/).map(l => l.trim()).filter(l => l.length > 0);
  if (tocEntries.length > 0) {
    csv += escCsv('505a — Índice') + sep + escCsv(tocEntries[0]) + '\n';
    for (let i = 1; i < tocEntries.length; i++) {
      csv += escCsv('') + sep + escCsv(tocEntries[i]) + '\n';
    }
  } else {
    csv += escCsv('505a — Índice') + sep + escCsv('') + '\n';
  }
  csv += sep + '\n';

  // Sección: Recurso Digital
  csv += escCsv('RECURSO DIGITAL KOHA') + sep + '\n';
  csv += escCsv('856u — Enlace al Documento') + sep + escCsv(rec.url_recurso_en_linea || rec.enlace_documento) + '\n';

  const rawTitle = rec.titulo_principal || `Documento_CIESPAL_${index+1}`;
  const cleanTitle = rawTitle
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/*?:"<>|]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 70);

  // Generamos un timestamp corto o usamos el indice para garantizar que nunca se sobreescriba
  const ts = new Date().getTime().toString().slice(-4);
  const filename = `${cleanTitle}_${ts}.csv`;

  const utf8Bytes = new TextEncoder().encode(csv);
  let binary = '';
  for (let i = 0; i < utf8Bytes.byteLength; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  const base64Data = btoa(binary);

  triggerAndroidSystemDownload(base64Data, filename, 'text/csv');
}

/**
 * Formatea y escapa cadenas para CSV cumpliendo el estándar RFC 4180.
 * Las celdas se ajustan al texto sin cortar filas ni comprimir datos.
 */
function escCsv(str) {
  if (str === null || str === undefined || str === '') return '""';
  // Normalizar saltos de línea, reemplazarlos por ' | ' para mantener todo compacto en una sola línea de Excel, y escapar comillas dobles (") como ("")
  const cleanStr = String(str)
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, ' | ')
    .replace(/\s{2,}/g, ' ')
    .replace(/"/g, '""');
  return `"${cleanStr}"`;
}
