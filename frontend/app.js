/**
 * CIESPAL Mediateca - Digitalizador con IA directa DeepSeek
 * Estilo CamScanner con Previsualización, Reorganización, Repetición de Hojas y Carga de PDF.
 */

const DEEPSEEK_CONFIG = {
  keyStorage: 'ciespal_deepseek_api_key',
  indexModeStorage: 'ciespal_index_extraction_mode',
  apiUrl: 'https://api.deepseek.com/chat/completions',
  modelsUrl: 'https://api.deepseek.com/models',
  visionModel: 'deepseek-v4-flash-vision-exp',
  maxDirectPages: 80,
  existingIndexMaxPages: 32,
  generatedIndexMaxPages: 80
};

const INDEX_EXTRACTION_MODES = {
  existing: 'existing',
  generated: 'generated'
};

const SCAN_CONFIG = {
  usePerspectiveWarp: false,
  liveDetectionIntervalMs: 520,
  liveDetectionStableFrames: 3
};

const DRAFT_CONFIG = {
  dbName: 'ciespal_digitizer_drafts',
  storeName: 'drafts',
  key: 'active_scan',
  version: 1,
  debounceMs: 700
};

const CROP_CORNERS = ['tl', 'tr', 'br', 'bl'];

const CIESPAL_KOHA_PROFILE = {
  branchId: 'BIB1',
  itemType: 'BK',
  classificationSource: 'ddc',
  resourceLabel: 'Recuperar PDF',
  includeItemFields: false
};

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
  indexExtractionMode: getStoredIndexExtractionMode(),
  scanFilterMode: 'magic_color', // 'magic_color' (Fondo Blanco Inteligente), 'bw' (B/N OpenCV), 'original'
  cameraStream: null,
  cameraReady: false,
  facingMode: 'environment',
  retakeIndex: null,
  savedPagesBase64: [],
  activeModalIndex: null,
  activeRecordId: null,
  detectedBounds: null,     // Bordes detectados del documento en tiempo real
  liveDetectionRAF: null,   // requestAnimationFrame ID para detección en vivo
  liveDetectionLastRun: 0,
  liveDetectionCanvas: null,
  liveDetectionStableCandidate: null,
  liveDetectionPendingCandidate: null,
  liveDetectionPendingCount: 0,
  liveDetectionMisses: 0,
  cropEditor: null,
  draftSaveTimer: null,
  draftLoaded: false,
  deepSeekKeyModalResolve: null
};

document.addEventListener('DOMContentLoaded', async () => {
  initNavigation();
  initEvents();
  refreshDeepSeekKeyButton();
  await restoreDraft();
  renderIndexExtractionMode();
  renderKohaRecordsTable();
  updatePageCounter();
  renderThumbnails();
  initScannerSurface();
});

// ========== NAVEGACIÓN ==========
function initNavigation() {
  updateCaptureModeClass('screen-capture');
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-target');
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById(targetId)?.classList.add('active');
      updateCaptureModeClass(targetId);
    });
  });
}

function updateCaptureModeClass(activeScreenId) {
  document.getElementById('app')?.classList.remove('capture-mode');
}

function initScannerSurface() {
  stopLiveDocumentDetection();
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(track => track.stop());
    state.cameraStream = null;
  }
  state.cameraReady = false;

  const hint = document.getElementById('scan-hint');
  if (!hint || state.bookPagesBase64.length || state.records.length) return;

  hint.textContent = hasNativeDocumentScanner()
    ? 'Presione Escanear para capturar hojas con recorte automático.'
    : 'Instale el APK en Android o use Cargar PDF para procesar documentos.';
}

// ========== CÁMARA NATIVA ==========
async function requestCameraPermission() {
  const hint = document.getElementById('scan-hint');
  if (!document.getElementById('camera-video')) {
    if (hint) hint.textContent = 'Escaneo directo con ML Kit. Use Escanear.';
    return;
  }
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
  if (!video) {
    if (hint) hint.textContent = 'Escaneo directo con ML Kit. Use Escanear.';
    return;
  }
  
  try {
    if (state.cameraStream) {
      stopLiveDocumentDetection();
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
    startLiveDocumentDetection();
    
    if (state.retakeIndex !== null) {
      hint.textContent = `MODO REPETIR: Tome la nueva foto para la Hoja #${state.retakeIndex + 1}`;
    } else {
      hint.textContent = 'Encuadre la página del libro';
    }

  } catch (err) {
    console.error('Error cámara:', err);
    state.cameraReady = false;
    stopLiveDocumentDetection();
    hint.textContent = 'Use "Cargar PDF" para subir y procesar un libro.';
  }
}

// ========== EVENTOS ==========
function initEvents() {
  document.getElementById('btn-shutter').addEventListener('click', startSmartDocumentScan);
  document.getElementById('btn-finish-pdf').addEventListener('click', processBookWithDeepSeekAI);
  document.getElementById('pdf-fallback').addEventListener('change', handlePDFUpload);
  document.querySelectorAll('[data-index-mode]').forEach(button => {
    button.addEventListener('click', () => setIndexExtractionMode(button.dataset.indexMode));
  });
  document.getElementById('btn-ai-key')?.addEventListener('click', () => configureDeepSeekKey());
  document.getElementById('btn-close-ai-key')?.addEventListener('click', () => closeDeepSeekKeyModal(getDeepSeekApiKey()));
  document.getElementById('btn-cancel-ai-key')?.addEventListener('click', () => closeDeepSeekKeyModal(getDeepSeekApiKey()));
  document.getElementById('btn-save-ai-key')?.addEventListener('click', saveDeepSeekKeyFromModal);
  document.getElementById('btn-test-ai-key')?.addEventListener('click', testDeepSeekKeyFromModal);
  document.getElementById('btn-delete-ai-key')?.addEventListener('click', deleteDeepSeekKeyFromModal);
  document.getElementById('btn-toggle-ai-key')?.addEventListener('click', toggleDeepSeekKeyVisibility);
  document.getElementById('ai-key-input')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveDeepSeekKeyFromModal();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDeepSeekKeyModal(getDeepSeekApiKey());
    }
  });

  document.getElementById('marc-form').addEventListener('submit', handleFormSubmit);
  document.getElementById('btn-download-excel')?.addEventListener('click', downloadKohaExcel);
  document.getElementById('btn-download-marcxml')?.addEventListener('click', downloadKohaMARCXML);
  document.getElementById('btn-discard')?.addEventListener('click', () => {
    if (confirm('¿Descartar el escaneo actual?')) {
      resetScanBuffer();
      document.querySelector('[data-target="screen-capture"]').click();
    }
  });

  // Modal de previsualización del lote
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-delete-page').addEventListener('click', deleteCurrentModalPage);
  document.getElementById('btn-add-more-pages')?.addEventListener('click', () => {
    closeModal();
    startSmartDocumentScan();
  });
  document.getElementById('btn-retake-page')?.addEventListener('click', prepareRetakeFromModal);
  document.getElementById('btn-edit-page-crop')?.addEventListener('click', openCropEditorForCurrentPage);
  document.getElementById('btn-modal-prev-page')?.addEventListener('click', () => moveModalPage(-1));
  document.getElementById('btn-modal-next-page')?.addEventListener('click', () => moveModalPage(1));

  // Guardado automático de borradores
  document.getElementById('marc-form')?.addEventListener('input', () => {
    if (!state.currentRecord) return;
    state.currentRecord = collectRecordFromForm(state.currentRecord);
    scheduleDraftSave();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveDraftNow();
  });

  window.addEventListener('ciespal-document-scan-result', handleNativeDocumentScanResult);
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

function sanitizeFilename(name) {
  return (name || 'Documento_Digitalizado_CIESPAL')
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/*?:"<>|]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 80) || 'Documento_Digitalizado_CIESPAL';
}

function imageBase64ToBlob(base64) {
  return dataURLToBlob(`data:image/jpeg;base64,${base64}`);
}

// ========== BORRADOR LOCAL PERSISTENTE ==========
function openDraftDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB no disponible'));
      return;
    }

    const request = indexedDB.open(DRAFT_CONFIG.dbName, DRAFT_CONFIG.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_CONFIG.storeName)) {
        db.createObjectStore(DRAFT_CONFIG.storeName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo abrir el borrador'));
  });
}

async function readDraftFromDb() {
  const db = await openDraftDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_CONFIG.storeName, 'readonly');
    const request = tx.objectStore(DRAFT_CONFIG.storeName).get(DRAFT_CONFIG.key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('No se pudo leer el borrador'));
    tx.oncomplete = () => db.close();
  });
}

async function writeDraftToDb(draft) {
  const db = await openDraftDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_CONFIG.storeName, 'readwrite');
    tx.objectStore(DRAFT_CONFIG.storeName).put(draft, DRAFT_CONFIG.key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('No se pudo guardar el borrador'));
    };
  });
}

function serializeDraft() {
  return {
    savedAt: new Date().toISOString(),
    records: state.records || [],
    currentRecord: state.currentRecord || null,
    activeRecordId: state.activeRecordId || state.currentRecord?.id || state.records?.[0]?.id || null,
    bookPagesBase64: state.bookPagesBase64 || [],
    savedPagesBase64: state.savedPagesBase64 || [],
    detectedIndexPages: state.detectedIndexPages || [],
    indexExtractionMode: getIndexExtractionMode(),
    scanFilterMode: state.scanFilterMode || 'magic_color'
  };
}

async function restoreDraft() {
  try {
    const draft = await readDraftFromDb();
    if (!draft) return;

    state.records = Array.isArray(draft.records) ? draft.records : [];
    state.currentRecord = draft.currentRecord || null;
    state.activeRecordId = draft.activeRecordId || state.currentRecord?.id || state.records[0]?.id || null;
    state.bookPagesBase64 = Array.isArray(draft.bookPagesBase64) ? draft.bookPagesBase64 : [];
    state.savedPagesBase64 = Array.isArray(draft.savedPagesBase64) ? draft.savedPagesBase64 : [];
    state.detectedIndexPages = Array.isArray(draft.detectedIndexPages) ? draft.detectedIndexPages : [];
    state.indexExtractionMode = normalizeIndexExtractionMode(draft.indexExtractionMode || state.indexExtractionMode);
    state.scanFilterMode = draft.scanFilterMode || state.scanFilterMode || 'magic_color';
    reconcileStoredRecords();
    migrateLegacySavedPagesToActiveRecord();
    state.bookPagesBuffer = state.bookPagesBase64.map(imageBase64ToBlob);
    state.draftLoaded = true;

    if (state.currentRecord) {
      populateRecordForm(state.currentRecord, state.savedPagesBase64.length || state.bookPagesBase64.length || 0);
    }

    const totalPages = state.bookPagesBase64.length;
    const hint = document.getElementById('scan-hint');
    if (hint && (totalPages || state.records.length)) {
      hint.textContent = `Borrador recuperado: ${totalPages} hojas y ${state.records.length} registros.`;
    }
    scheduleDraftSave();
  } catch (err) {
    console.warn('No se pudo restaurar el borrador local:', err);
  }
}

function scheduleDraftSave() {
  clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = setTimeout(() => {
    saveDraftNow();
  }, DRAFT_CONFIG.debounceMs);
}

function reconcileStoredRecords() {
  const records = [];
  const indexById = new Map();
  const addRecord = record => {
    if (!record || typeof record !== 'object') return;
    const normalized = normalizeStoredRecord(record);
    const existingIndex = indexById.get(normalized.id);
    if (existingIndex === undefined) {
      indexById.set(normalized.id, records.length);
      records.push(normalized);
    } else {
      records[existingIndex] = mergeStoredRecords(records[existingIndex], normalized);
    }
  };

  (Array.isArray(state.records) ? state.records : []).forEach(addRecord);
  addRecord(state.currentRecord);
  state.records = records;

  const active = state.records.find(rec => rec.id === state.activeRecordId) || state.records[0] || null;
  state.currentRecord = active;
  state.activeRecordId = active?.id || null;
  if (!active) clearRecordState({ resetForm: false, preserveLibrary: true });
}

function migrateLegacySavedPagesToActiveRecord() {
  if (!Array.isArray(state.savedPagesBase64) || !state.savedPagesBase64.length) return;
  const active = state.records.find(rec => rec.id === state.activeRecordId) || state.currentRecord;
  if (!active || getRecordPages(active).length) return;

  active.pagesBase64 = [...state.savedPagesBase64];
  active.pageCount = active.pageCount || active.pagesBase64.length;
  state.currentRecord = active;
}

function setActiveRecord(record) {
  if (!record) return null;
  const normalized = normalizeStoredRecord(record);
  const existingIndex = state.records.findIndex(rec => rec.id === normalized.id);

  if (existingIndex >= 0) {
    state.records[existingIndex] = mergeStoredRecords(state.records[existingIndex], normalized);
    state.currentRecord = state.records[existingIndex];
  } else {
    state.records.push(normalized);
    state.currentRecord = normalized;
  }

  state.activeRecordId = state.currentRecord.id;
  return state.currentRecord;
}

function normalizeStoredRecord(record) {
  const id = record.id || generateRecordId();
  const pagesBase64 = getRecordPages(record);
  return {
    ...record,
    id,
    pagesBase64,
    pageCount: record.pageCount || pagesBase64.length || parseInt(record.numero_paginas, 10) || 0,
    savedAt: record.savedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function mergeStoredRecords(existing, incoming) {
  const incomingPages = getRecordPages(incoming);
  const existingPages = getRecordPages(existing);
  const pagesBase64 = incomingPages.length ? incomingPages : existingPages;
  return {
    ...existing,
    ...incoming,
    pagesBase64,
    pageCount: incoming.pageCount || existing.pageCount || pagesBase64.length || parseInt(incoming.numero_paginas, 10) || 0,
    savedAt: existing.savedAt || incoming.savedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function generateRecordId() {
  return 'ciespal_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function clearRecordState(options = {}) {
  const preserveLibrary = Boolean(options.preserveLibrary);
  state.currentRecord = null;
  if (!preserveLibrary) {
    state.records = [];
    state.activeRecordId = null;
  } else if (!state.records.some(rec => rec.id === state.activeRecordId)) {
    state.activeRecordId = state.records[0]?.id || null;
  }

  const badge = document.getElementById('record-id-badge');
  if (badge) badge.textContent = 'ID: --';

  const pdfCard = document.getElementById('pdf-generated-card');
  if (pdfCard) pdfCard.classList.add('hidden');

  if (options.resetForm !== false) {
    document.getElementById('marc-form')?.reset();
  }
}

async function saveDraftNow() {
  clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = null;
  try {
    await writeDraftToDb(serializeDraft());
  } catch (err) {
    console.warn('No se pudo guardar el borrador local:', err);
  }
}

function normalizeIndexExtractionMode(mode) {
  return mode === INDEX_EXTRACTION_MODES.generated
    ? INDEX_EXTRACTION_MODES.generated
    : INDEX_EXTRACTION_MODES.existing;
}

function getStoredIndexExtractionMode() {
  try {
    return normalizeIndexExtractionMode(localStorage.getItem(DEEPSEEK_CONFIG.indexModeStorage));
  } catch (err) {
    return INDEX_EXTRACTION_MODES.existing;
  }
}

function getIndexExtractionMode() {
  state.indexExtractionMode = normalizeIndexExtractionMode(state.indexExtractionMode);
  return state.indexExtractionMode;
}

function setIndexExtractionMode(mode) {
  state.indexExtractionMode = normalizeIndexExtractionMode(mode);
  try {
    localStorage.setItem(DEEPSEEK_CONFIG.indexModeStorage, state.indexExtractionMode);
  } catch (err) {
    console.warn('No se pudo guardar el modo de índice:', err);
  }
  renderIndexExtractionMode();
  scheduleDraftSave();
}

function renderIndexExtractionMode() {
  const mode = getIndexExtractionMode();
  document.querySelectorAll('[data-index-mode]').forEach(button => {
    const active = button.dataset.indexMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  const finishButton = document.getElementById('btn-finish-pdf');
  if (finishButton) {
    finishButton.title = mode === INDEX_EXTRACTION_MODES.generated
      ? 'Generar ficha, PDF e índice desde encabezados'
      : 'Generar ficha, PDF y transcribir índice existente';
  }
}

function getAiPageLimitForMode(mode) {
  return normalizeIndexExtractionMode(mode) === INDEX_EXTRACTION_MODES.generated
    ? DEEPSEEK_CONFIG.generatedIndexMaxPages
    : DEEPSEEK_CONFIG.existingIndexMaxPages;
}

function getDeepSeekApiKey() {
  return (localStorage.getItem(DEEPSEEK_CONFIG.keyStorage) || '').trim();
}

function maskApiKey(key) {
  if (!key) return 'sin configurar';
  if (key.length <= 12) return 'configurada';
  return `${key.slice(0, 5)}...${key.slice(-4)}`;
}

function refreshDeepSeekKeyButton() {
  const btn = document.getElementById('btn-ai-key');
  if (!btn) return;
  const key = getDeepSeekApiKey();
  btn.classList.toggle('is-configured', Boolean(key));
  btn.title = key
    ? `Key DeepSeek configurada (${maskApiKey(key)})`
    : 'Configurar key DeepSeek';
}

async function configureDeepSeekKey(options = {}) {
  const currentKey = getDeepSeekApiKey();
  const modal = document.getElementById('ai-key-modal');
  const input = document.getElementById('ai-key-input');
  const current = document.getElementById('ai-key-current');
  const status = document.getElementById('ai-key-status');

  if (!modal || !input) {
    return configureDeepSeekKeyFallback(options);
  }

  if (state.deepSeekKeyModalResolve) closeDeepSeekKeyModal(currentKey);

  return new Promise(resolve => {
    state.deepSeekKeyModalResolve = resolve;
    modal.dataset.skipTest = options.skipTest ? '1' : '0';
    input.value = '';
    input.type = 'password';
    if (current) current.textContent = currentKey
      ? `Key actual: ${maskApiKey(currentKey)}`
      : 'Sin key guardada';
    if (status) {
      status.className = 'ai-key-status';
      status.textContent = currentKey
        ? 'Pegue una nueva key o conserve la actual.'
        : 'La key se guarda solo en este celular.';
    }
    setDeepSeekKeyModalBusy(false);
    setDeepSeekKeyVisibility(false);
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 80);
  });
}

async function ensureDeepSeekApiKey() {
  const currentKey = getDeepSeekApiKey();
  if (currentKey) return currentKey;

  const configuredKey = await configureDeepSeekKey();
  if (configuredKey) return configuredKey;

  alert('Para usar IA sin backend, toque el icono de llave y pegue su key de DeepSeek.');
  return '';
}

async function configureDeepSeekKeyFallback(options = {}) {
  const currentKey = getDeepSeekApiKey();
  const value = window.prompt('Pegue su API key de DeepSeek para usar la IA.', '');
  if (value === null) return currentKey;

  const cleaned = value.trim();
  if (!cleaned) return currentKey;

  if (/^(borrar|delete|eliminar|quitar)$/i.test(cleaned)) {
    localStorage.removeItem(DEEPSEEK_CONFIG.keyStorage);
    refreshDeepSeekKeyButton();
    return '';
  }

  localStorage.setItem(DEEPSEEK_CONFIG.keyStorage, cleaned);
  refreshDeepSeekKeyButton();

  if (!options.skipTest) {
    try {
      await testDeepSeekKey(cleaned);
    } catch (err) {
      console.warn('No se pudo probar la key DeepSeek:', err);
    }
  }

  return cleaned;
}

function closeDeepSeekKeyModal(value) {
  const modal = document.getElementById('ai-key-modal');
  if (modal) modal.classList.add('hidden');
  setDeepSeekKeyModalBusy(false);
  const resolver = state.deepSeekKeyModalResolve;
  state.deepSeekKeyModalResolve = null;
  if (resolver) resolver(value || '');
}

function setDeepSeekKeyVisibility(visible) {
  const input = document.getElementById('ai-key-input');
  const toggle = document.getElementById('btn-toggle-ai-key');
  if (!input || !toggle) return;
  input.type = visible ? 'text' : 'password';
  toggle.innerHTML = `<i data-lucide="${visible ? 'eye-off' : 'eye'}"></i>`;
  if (window.lucide) lucide.createIcons();
}

function toggleDeepSeekKeyVisibility() {
  const input = document.getElementById('ai-key-input');
  setDeepSeekKeyVisibility(input?.type === 'password');
}

function setDeepSeekKeyModalBusy(isBusy) {
  ['btn-save-ai-key', 'btn-test-ai-key', 'btn-delete-ai-key', 'btn-cancel-ai-key', 'btn-close-ai-key', 'btn-toggle-ai-key']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = isBusy;
    });
}

function getDeepSeekKeyInputValue() {
  return (document.getElementById('ai-key-input')?.value || '').trim();
}

function setDeepSeekKeyStatus(text, tone = '') {
  const status = document.getElementById('ai-key-status');
  if (!status) return;
  status.className = ['ai-key-status', tone ? `is-${tone}` : ''].filter(Boolean).join(' ');
  status.textContent = text;
}

async function saveDeepSeekKeyFromModal() {
  const cleaned = getDeepSeekKeyInputValue();
  if (!cleaned) {
    closeDeepSeekKeyModal(getDeepSeekApiKey());
    return;
  }

  localStorage.setItem(DEEPSEEK_CONFIG.keyStorage, cleaned);
  refreshDeepSeekKeyButton();
  setDeepSeekKeyStatus('Key guardada correctamente.', 'success');
  setTimeout(() => closeDeepSeekKeyModal(cleaned), 250);
}

async function testDeepSeekKeyFromModal() {
  const cleaned = getDeepSeekKeyInputValue() || getDeepSeekApiKey();
  if (!cleaned) {
    setDeepSeekKeyStatus('Pegue una key antes de probar.', 'error');
    return;
  }

  setDeepSeekKeyModalBusy(true);
  setDeepSeekKeyStatus('Probando conexión con DeepSeek...');
  try {
    await testDeepSeekKey(cleaned);
    localStorage.setItem(DEEPSEEK_CONFIG.keyStorage, cleaned);
    refreshDeepSeekKeyButton();
    setDeepSeekKeyStatus('Key probada y guardada correctamente.', 'success');
  } catch (err) {
    console.warn('No se pudo probar la key DeepSeek:', err);
    setDeepSeekKeyStatus(getDeepSeekDirectErrorMessage(err), 'error');
  } finally {
    setDeepSeekKeyModalBusy(false);
  }
}

function deleteDeepSeekKeyFromModal() {
  localStorage.removeItem(DEEPSEEK_CONFIG.keyStorage);
  refreshDeepSeekKeyButton();
  const input = document.getElementById('ai-key-input');
  if (input) input.value = '';
  setDeepSeekKeyStatus('Key eliminada de este celular.', 'success');
  closeDeepSeekKeyModal('');
}

async function testDeepSeekKey(apiKey) {
  const result = await deepSeekHttpRequest(DEEPSEEK_CONFIG.modelsUrl, {
    method: 'GET',
    apiKey,
    timeoutMs: 30000
  });

  if (!result.ok) {
    throw new Error(`DeepSeek respondió ${result.status}: ${extractDeepSeekError(result.data || result.text)}`);
  }

  const models = Array.isArray(result.data?.data) ? result.data.data.map(model => model.id) : [];
  if (!models.includes(DEEPSEEK_CONFIG.visionModel)) {
    throw new Error(`La key responde, pero no aparece el modelo ${DEEPSEEK_CONFIG.visionModel}.`);
  }

  return true;
}

function startLiveDocumentDetection() {
  const video = document.getElementById('camera-video');
  if (!video) return;

  stopLiveDocumentDetection(true);
  state.liveDetectionLastRun = 0;

  const tick = (now) => {
    if (!state.cameraReady || !video.videoWidth || document.hidden) {
      state.liveDetectionRAF = requestAnimationFrame(tick);
      return;
    }

    if (now - state.liveDetectionLastRun > SCAN_CONFIG.liveDetectionIntervalMs) {
      state.liveDetectionLastRun = now;
      const candidate = updateLiveDocumentStability(detectLiveDocumentCandidate(video));
      if (candidate) {
        state.detectedBounds = candidate;
        drawLiveDocumentOverlay(candidate, video);
      } else {
        state.detectedBounds = null;
        clearLiveDocumentOverlay();
      }
    }

    state.liveDetectionRAF = requestAnimationFrame(tick);
  };

  state.liveDetectionRAF = requestAnimationFrame(tick);
}

function stopLiveDocumentDetection(clear = true) {
  if (state.liveDetectionRAF) {
    cancelAnimationFrame(state.liveDetectionRAF);
    state.liveDetectionRAF = null;
  }
  state.detectedBounds = null;
  state.liveDetectionStableCandidate = null;
  state.liveDetectionPendingCandidate = null;
  state.liveDetectionPendingCount = 0;
  state.liveDetectionMisses = 0;
  if (clear) clearLiveDocumentOverlay();
}

function detectLiveDocumentCandidate(video) {
  const rawW = video.videoWidth;
  const rawH = video.videoHeight;
  if (!rawW || !rawH) return null;

  const sampleW = Math.min(360, rawW);
  const sampleH = Math.max(1, Math.round(rawH * (sampleW / rawW)));
  const canvas = state.liveDetectionCanvas || document.createElement('canvas');
  state.liveDetectionCanvas = canvas;
  canvas.width = sampleW;
  canvas.height = sampleH;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, sampleW, sampleH);

  const bounds = detectForegroundBookBounds2D(ctx, sampleW, sampleH)
    || detectPaperSheetBounds2D(ctx, sampleW, sampleH);
  if (!bounds) {
    return null;
  }

  const scaleX = rawW / sampleW;
  const scaleY = rawH / sampleH;
  const points = boundsToPoints(bounds).map(point => ({
    x: point.x * scaleX,
    y: point.y * scaleY
  }));

  if (!isLiveCandidateReasonable(points, rawW, rawH)) return null;

  return {
    points,
    method: bounds.method || 'bounds',
    sourceWidth: rawW,
    sourceHeight: rawH,
    timestamp: Date.now()
  };
}

function updateLiveDocumentStability(candidate) {
  if (!candidate) {
    state.liveDetectionMisses += 1;
    if (state.liveDetectionMisses >= SCAN_CONFIG.liveDetectionStableFrames) {
      state.liveDetectionStableCandidate = null;
      state.liveDetectionPendingCandidate = null;
      state.liveDetectionPendingCount = 0;
    }
    return state.liveDetectionStableCandidate;
  }

  state.liveDetectionMisses = 0;

  if (!state.liveDetectionStableCandidate) {
    if (candidatesSimilar(candidate, state.liveDetectionPendingCandidate)) {
      state.liveDetectionPendingCount += 1;
    } else {
      state.liveDetectionPendingCandidate = candidate;
      state.liveDetectionPendingCount = 1;
    }

    if (state.liveDetectionPendingCount >= SCAN_CONFIG.liveDetectionStableFrames) {
      state.liveDetectionStableCandidate = candidate;
    }
    return state.liveDetectionStableCandidate;
  }

  if (candidatesSimilar(candidate, state.liveDetectionStableCandidate)) {
    state.liveDetectionStableCandidate = smoothLiveCandidate(state.liveDetectionStableCandidate, candidate);
    state.liveDetectionPendingCandidate = null;
    state.liveDetectionPendingCount = 0;
    return state.liveDetectionStableCandidate;
  }

  if (candidatesSimilar(candidate, state.liveDetectionPendingCandidate)) {
    state.liveDetectionPendingCount += 1;
  } else {
    state.liveDetectionPendingCandidate = candidate;
    state.liveDetectionPendingCount = 1;
  }

  if (state.liveDetectionPendingCount >= SCAN_CONFIG.liveDetectionStableFrames + 1) {
    state.liveDetectionStableCandidate = candidate;
    state.liveDetectionPendingCandidate = null;
    state.liveDetectionPendingCount = 0;
  }

  return state.liveDetectionStableCandidate;
}

function candidatesSimilar(a, b) {
  if (!a || !b) return false;
  const boxA = pointsToBounds(a.points);
  const boxB = pointsToBounds(b.points);
  const iou = boundsIntersectionOverUnion(boxA, boxB);
  const centerDistance = Math.hypot(
    (boxA.x + boxA.w / 2) - (boxB.x + boxB.w / 2),
    (boxA.y + boxA.h / 2) - (boxB.y + boxB.h / 2)
  );
  const reference = Math.max(1, Math.min(a.sourceWidth || 1, a.sourceHeight || 1));
  return iou > 0.62 && centerDistance / reference < 0.10;
}

function smoothLiveCandidate(previous, next) {
  const alpha = 0.32;
  return {
    ...next,
    points: next.points.map((point, idx) => ({
      x: previous.points[idx].x * (1 - alpha) + point.x * alpha,
      y: previous.points[idx].y * (1 - alpha) + point.y * alpha
    })),
    timestamp: Date.now()
  };
}

function boundsIntersectionOverUnion(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

function drawLiveDocumentOverlay(candidate, video) {
  const overlay = document.getElementById('edge-overlay');
  const polygon = document.getElementById('edge-polygon');
  const frame = document.getElementById('scan-frame');
  const status = document.getElementById('edge-status');
  const wrapper = document.querySelector('.viewfinder-wrapper');
  if (!overlay || !polygon || !wrapper) return;

  const viewW = wrapper.clientWidth || 1;
  const viewH = wrapper.clientHeight || 1;
  const mapped = mapVideoPointsToView(candidate.points, video, viewW, viewH);
  overlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
  polygon.setAttribute('points', mapped.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  overlay.classList.add('active');

  frame?.classList.add('document-detected');
  frame?.classList.remove('no-document');
  if (status) {
    status.textContent = 'Libro detectado';
  }
}

function clearLiveDocumentOverlay() {
  const overlay = document.getElementById('edge-overlay');
  const polygon = document.getElementById('edge-polygon');
  const frame = document.getElementById('scan-frame');
  const status = document.getElementById('edge-status');
  overlay?.classList.remove('active');
  polygon?.setAttribute('points', '');
  frame?.classList.remove('document-detected');
  frame?.classList.add('no-document');
  if (status) status.textContent = 'Buscando bordes';
}

function mapVideoPointsToView(points, video, viewW, viewH) {
  const rawW = video.videoWidth || 1;
  const rawH = video.videoHeight || 1;
  const scale = Math.max(viewW / rawW, viewH / rawH);
  const offsetX = (viewW - rawW * scale) / 2;
  const offsetY = (viewH - rawH * scale) / 2;

  return points.map(point => ({
    x: clampNumber(point.x * scale + offsetX, 0, viewW),
    y: clampNumber(point.y * scale + offsetY, 0, viewH)
  }));
}

function cropFromLiveDetection(srcCanvas, dstCanvas) {
  const candidate = state.detectedBounds;
  if (!candidate || !candidate.points || Date.now() - candidate.timestamp > 1800) {
    return false;
  }

  const scaleX = srcCanvas.width / (candidate.sourceWidth || srcCanvas.width);
  const scaleY = srcCanvas.height / (candidate.sourceHeight || srcCanvas.height);
  const points = candidate.points.map(point => ({
    x: point.x * scaleX,
    y: point.y * scaleY
  }));

  if (!isLiveCandidateReasonable(points, srcCanvas.width, srcCanvas.height)) {
    return false;
  }

  if (SCAN_CONFIG.usePerspectiveWarp && candidate.method === 'polygon' && warpCanvasPerspectiveFromPoints(srcCanvas, dstCanvas, points)) {
    return true;
  }

  renderCroppedFrame(srcCanvas, dstCanvas, pointsToBounds(points));
  return true;
}

function warpCanvasPerspectiveFromPoints(srcCanvas, dstCanvas, points) {
  if (typeof cv === 'undefined' || !cv.Mat || !cv.imread) return false;

  let src;
  let srcTri;
  let dstTri;
  let transform;
  let dst;

  try {
    const ordered = orderDocumentPoints(points);
    if (!ordered) return false;

    const size = getPerspectiveOutputSize(ordered);
    if (!isPerspectiveSizeValid(size, srcCanvas.width, srcCanvas.height)) return false;

    src = cv.imread(srcCanvas);
    const { tl, tr, br, bl } = ordered;
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      tl.x, tl.y,
      tr.x, tr.y,
      br.x, br.y,
      bl.x, bl.y
    ]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      size.width - 1, 0,
      size.width - 1, size.height - 1,
      0, size.height - 1
    ]);

    transform = cv.getPerspectiveTransform(srcTri, dstTri);
    dst = new cv.Mat();
    cv.warpPerspective(src, dst, transform, new cv.Size(size.width, size.height));
    dstCanvas.width = size.width;
    dstCanvas.height = size.height;
    cv.imshow(dstCanvas, dst);
    return true;
  } catch (err) {
    console.warn('Live perspective crop failed:', err);
    return false;
  } finally {
    [src, srcTri, dstTri, transform, dst].forEach(mat => {
      if (mat && typeof mat.delete === 'function') mat.delete();
    });
  }
}

function orderedPointsToArray(points) {
  if (!points) return [];
  if (!Array.isArray(points) && points.tl && points.tr && points.br && points.bl) {
    return [points.tl, points.tr, points.br, points.bl];
  }
  const ordered = orderDocumentPoints(points);
  return ordered ? [ordered.tl, ordered.tr, ordered.br, ordered.bl] : points;
}

function boundsToPoints(bounds) {
  const x = bounds.x;
  const y = bounds.y;
  const right = bounds.x + bounds.w;
  const bottom = bounds.y + bounds.h;
  return [
    { x, y },
    { x: right, y },
    { x: right, y: bottom },
    { x, y: bottom }
  ];
}

function pointsToBounds(points) {
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    method: 'live'
  };
}

function isLiveCandidateReasonable(points, imgW, imgH) {
  if (!points || points.length !== 4) return false;
  const bounds = pointsToBounds(points);
  if (bounds.w < imgW * 0.22 || bounds.h < imgH * 0.22) return false;
  if (bounds.w > imgW * 0.94 && bounds.h > imgH * 0.88) return false;
  const edgeMarginX = imgW * 0.012;
  const edgeMarginY = imgH * 0.012;
  const touchesAllEdges = (
    bounds.x <= edgeMarginX &&
    bounds.y <= edgeMarginY &&
    bounds.x + bounds.w >= imgW - edgeMarginX &&
    bounds.y + bounds.h >= imgH - edgeMarginY
  );
  if (touchesAllEdges) return false;

  const areaRatio = polygonArea(points) / Math.max(1, imgW * imgH);
  if (areaRatio < 0.08 || areaRatio > 0.88) return false;

  const ordered = orderDocumentPoints(points);
  if (!ordered) return false;
  const size = getPerspectiveOutputSize(ordered);
  const minSide = Math.min(size.width, size.height);
  const maxSide = Math.max(size.width, size.height);
  return minSide >= Math.min(imgW, imgH) * 0.18 && maxSide / Math.max(1, minSide) <= 3.4;
}

// ========== EDITOR DE RECORTE MANUAL ==========
function getSuggestedCropForCanvas(srcCanvas, srcCtx) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  let points = null;
  let label = 'ajuste manual';

  const liveCandidate = state.detectedBounds;
  if (liveCandidate?.points && Date.now() - liveCandidate.timestamp < 2200) {
    const scaleX = w / (liveCandidate.sourceWidth || w);
    const scaleY = h / (liveCandidate.sourceHeight || h);
    const livePoints = liveCandidate.points.map(point => ({
      x: point.x * scaleX,
      y: point.y * scaleY
    }));
    if (isLiveCandidateReasonable(livePoints, w, h)) {
      points = livePoints;
      label = 'bordes detectados';
    }
  }

  if (!points) {
    const bounds = detectForegroundBookBounds2D(srcCtx, w, h)
      || detectPaperSheetBounds2D(srcCtx, w, h)
      || detectSmartBookBounds(srcCtx, w, h)
      || clampBounds(null, w, h);
    points = boundsToPoints(bounds);
    label = bounds?.method === 'foreground'
      ? 'libro detectado'
      : bounds?.method === 'paper'
        ? 'hoja detectada'
        : 'ajuste automático';
  }

  return {
    points: sanitizeCropPoints(points, w, h),
    label
  };
}

function sanitizeCropPoints(points, width, height) {
  const fallback = boundsToPoints(clampBounds(null, width, height));
  const ordered = orderDocumentPoints(points || fallback);
  const array = ordered ? [ordered.tl, ordered.tr, ordered.br, ordered.bl] : fallback;
  return array.map(point => ({
    x: clampNumber(point.x, 0, width),
    y: clampNumber(point.y, 0, height)
  }));
}

function cloneCropPoints(points) {
  return (points || []).map(point => ({ x: point.x, y: point.y }));
}

function openCropEditor({ sourceBase64, suggestedPoints, targetIndex = null, title = 'Recortar hoja', label = 'ajuste manual' }) {
  const modal = document.getElementById('crop-modal');
  const image = document.getElementById('crop-image');
  const titleEl = document.getElementById('crop-modal-title');
  if (!modal || !image) return;

  state.cropEditor = {
    sourceBase64,
    suggestedPoints: cloneCropPoints(suggestedPoints),
    points: cloneCropPoints(suggestedPoints),
    targetIndex,
    label,
    activeCorner: null,
    naturalWidth: 0,
    naturalHeight: 0,
    dragMetrics: null,
    handleElements: null,
    dragFrame: null
  };

  titleEl.textContent = title;
  modal.classList.remove('hidden');
  image.onload = () => {
    if (!state.cropEditor) return;
    state.cropEditor.naturalWidth = image.naturalWidth;
    state.cropEditor.naturalHeight = image.naturalHeight;
    if (!state.cropEditor.points.length) {
      state.cropEditor.points = sanitizeCropPoints(null, image.naturalWidth, image.naturalHeight);
      state.cropEditor.suggestedPoints = cloneCropPoints(state.cropEditor.points);
    }
    requestAnimationFrame(renderCropEditor);
  };
  image.src = `data:image/jpeg;base64,${sourceBase64}`;
  document.getElementById('scan-hint').textContent = `Ajuste esquinas: ${label}.`;
}

function cancelCropEditor() {
  document.getElementById('crop-modal')?.classList.add('hidden');
  state.cropEditor = null;
  document.getElementById('scan-hint').textContent = 'Recorte cancelado. Puede volver a escanear.';
}

function resetCropToSuggested() {
  if (!state.cropEditor) return;
  state.cropEditor.points = cloneCropPoints(state.cropEditor.suggestedPoints);
  renderCropEditor();
}

function setCropToFullPage() {
  if (!state.cropEditor) return;
  const w = state.cropEditor.naturalWidth || 1;
  const h = state.cropEditor.naturalHeight || 1;
  const marginX = Math.round(w * 0.015);
  const marginY = Math.round(h * 0.015);
  state.cropEditor.points = boundsToPoints({
    x: marginX,
    y: marginY,
    w: w - marginX * 2,
    h: h - marginY * 2
  });
  renderCropEditor();
}

function getCropMetrics() {
  const stage = document.getElementById('crop-stage');
  const image = document.getElementById('crop-image');
  if (!stage || !image || !state.cropEditor?.naturalWidth) return null;

  const stageRect = stage.getBoundingClientRect();
  const imageRect = image.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height || !imageRect.width || !imageRect.height) return null;

  return {
    stageRect,
    imageRect,
    imageLeft: imageRect.left - stageRect.left,
    imageTop: imageRect.top - stageRect.top,
    imageWidth: imageRect.width,
    imageHeight: imageRect.height,
    naturalWidth: state.cropEditor.naturalWidth,
    naturalHeight: state.cropEditor.naturalHeight
  };
}

function imagePointToStage(point, metrics) {
  return {
    x: metrics.imageLeft + (point.x / metrics.naturalWidth) * metrics.imageWidth,
    y: metrics.imageTop + (point.y / metrics.naturalHeight) * metrics.imageHeight
  };
}

function stageClientToImagePoint(clientX, clientY, metrics) {
  const stageX = clientX - metrics.stageRect.left;
  const stageY = clientY - metrics.stageRect.top;
  const clampedX = clampNumber(stageX, metrics.imageLeft, metrics.imageLeft + metrics.imageWidth);
  const clampedY = clampNumber(stageY, metrics.imageTop, metrics.imageTop + metrics.imageHeight);
  return {
    x: ((clampedX - metrics.imageLeft) / metrics.imageWidth) * metrics.naturalWidth,
    y: ((clampedY - metrics.imageTop) / metrics.imageHeight) * metrics.naturalHeight
  };
}

function renderCropEditor(metricsOverride = null) {
  if (!state.cropEditor) return;
  const metrics = metricsOverride || getCropMetrics();
  if (!metrics) return;

  const overlay = document.getElementById('crop-overlay');
  const polygon = document.getElementById('crop-polygon');
  overlay?.setAttribute('viewBox', `0 0 ${metrics.stageRect.width} ${metrics.stageRect.height}`);

  const stagePoints = state.cropEditor.points.map(point => imagePointToStage(point, metrics));
  polygon?.setAttribute('points', stagePoints.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '));

  const handles = state.cropEditor.handleElements || CROP_CORNERS.map(corner =>
    document.querySelector(`.crop-handle[data-corner="${corner}"]`)
  );

  CROP_CORNERS.forEach((corner, idx) => {
    const handle = handles[idx];
    const point = stagePoints[idx];
    if (!handle || !point) return;
    handle.style.left = `${point.x}px`;
    handle.style.top = `${point.y}px`;
  });
}

function startCropHandleDrag(event) {
  if (!state.cropEditor) return;
  event.preventDefault();
  const corner = event.currentTarget.dataset.corner;
  if (!CROP_CORNERS.includes(corner)) return;

  state.cropEditor.activeCorner = corner;
  state.cropEditor.dragMetrics = getCropMetrics();
  state.cropEditor.handleElements = CROP_CORNERS.map(c =>
    document.querySelector(`.crop-handle[data-corner="${c}"]`)
  );
  event.currentTarget.setPointerCapture?.(event.pointerId);
  document.addEventListener('pointermove', moveCropHandle, { passive: false });
  document.addEventListener('pointerup', stopCropHandleDrag, { once: true });
  document.addEventListener('pointercancel', stopCropHandleDrag, { once: true });
}

function moveCropHandle(event) {
  if (!state.cropEditor?.activeCorner) return;
  event.preventDefault();
  const metrics = state.cropEditor.dragMetrics || getCropMetrics();
  if (!metrics) return;

  const idx = CROP_CORNERS.indexOf(state.cropEditor.activeCorner);
  if (idx < 0) return;

  state.cropEditor.points[idx] = stageClientToImagePoint(event.clientX, event.clientY, metrics);

  if (state.cropEditor.dragFrame) return;
  state.cropEditor.dragFrame = requestAnimationFrame(() => {
    if (!state.cropEditor) return;
    const editor = state.cropEditor;
    editor.dragFrame = null;
    renderCropEditor(editor.dragMetrics || metrics);
  });
}

function stopCropHandleDrag() {
  if (state.cropEditor) {
    if (state.cropEditor.dragFrame) {
      cancelAnimationFrame(state.cropEditor.dragFrame);
      state.cropEditor.dragFrame = null;
    }
    state.cropEditor.activeCorner = null;
    state.cropEditor.dragMetrics = null;
    state.cropEditor.handleElements = null;
    renderCropEditor();
  }
  document.removeEventListener('pointermove', moveCropHandle);
}

async function confirmCropSelection() {
  const editor = state.cropEditor;
  if (!editor?.sourceBase64) return;

  try {
    const image = await loadImageFromBase64(editor.sourceBase64);
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = image.naturalWidth || image.width;
    srcCanvas.height = image.naturalHeight || image.height;
    srcCanvas.getContext('2d').drawImage(image, 0, 0, srcCanvas.width, srcCanvas.height);

    const outputCanvas = document.getElementById('photo-canvas') || document.createElement('canvas');
    const points = sanitizeCropPoints(editor.points, srcCanvas.width, srcCanvas.height);
    const warped = Boolean(editor.allowPerspective) && warpCanvasPerspectiveFromPoints(srcCanvas, outputCanvas, points);
    if (!warped) {
      renderCroppedFrame(srcCanvas, outputCanvas, pointsToBounds(points));
    }

    enhanceDocumentWithOpenCV(outputCanvas, state.scanFilterMode || 'magic_color');
    saveProcessedPageCanvas(outputCanvas, editor.targetIndex, 'recortada manualmente');

    document.getElementById('crop-modal')?.classList.add('hidden');
    state.cropEditor = null;
  } catch (err) {
    console.error('Error en recorte manual:', err);
    alert('No se pudo guardar el recorte: ' + err.message);
  }
}

function loadImageFromBase64(base64) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Imagen no válida'));
    image.src = `data:image/jpeg;base64,${base64}`;
  });
}

function saveProcessedPageCanvas(canvas, targetIndex = null, qualityLabel = 'guardada') {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = dataUrl.split(',')[1];
  const blob = dataURLToBlob(dataUrl);
  const hint = document.getElementById('scan-hint');
  const startsFreshLot = targetIndex === null && state.bookPagesBase64.length === 0;
  if (startsFreshLot) clearRecordState({ preserveLibrary: true });
  state.savedPagesBase64 = [];

  if (targetIndex !== null && targetIndex >= 0 && targetIndex < state.bookPagesBase64.length) {
    state.bookPagesBuffer[targetIndex] = blob;
    state.bookPagesBase64[targetIndex] = base64;
    if (state.retakeIndex === targetIndex) state.retakeIndex = null;
    if (hint) hint.textContent = `Hoja #${targetIndex + 1} reemplazada, ${qualityLabel}`;
  } else {
    state.bookPagesBuffer.push(blob);
    state.bookPagesBase64.push(base64);
    if (hint) hint.textContent = `Hoja #${state.bookPagesBuffer.length} guardada, ${qualityLabel}`;
  }

  updatePageCounter();
  renderThumbnails();
  if (startsFreshLot) renderRecordsStrip();
  scheduleDraftSave();
}

function openCropEditorForCurrentPage() {
  if (state.activeModalIndex === null || !state.bookPagesBase64[state.activeModalIndex]) return;
  const idx = state.activeModalIndex;
  const sourceBase64 = state.bookPagesBase64[idx];
  closeModal();
  openCropEditor({
    sourceBase64,
    suggestedPoints: [],
    targetIndex: idx,
    title: `Recortar hoja ${idx + 1}`,
    label: 'recorte existente'
  });
}

// ========== ESCÁNER NATIVO ML KIT ==========
function hasNativeDocumentScanner() {
  return Boolean(
    window.CiespalDocumentScanner &&
    typeof window.CiespalDocumentScanner.scanDocuments === 'function'
  );
}

function startSmartDocumentScan() {
  const hint = document.getElementById('scan-hint');

  if (!hasNativeDocumentScanner()) {
    if (hint) hint.textContent = 'Escáner inteligente disponible solo en Android.';
    alert('El escáner inteligente se abre desde el APK instalado en Android. En navegador, use Cargar PDF.');
    return;
  }

  try {
    if (state.cameraStream) {
      stopLiveDocumentDetection();
      state.cameraStream.getTracks().forEach(track => track.stop());
      state.cameraStream = null;
      state.cameraReady = false;
    }

    if (hint) hint.textContent = 'Abriendo escáner inteligente...';
    const pageLimit = state.retakeIndex !== null ? 1 : 50;
    const response = window.CiespalDocumentScanner.scanDocuments(pageLimit);
    const parsed = parseNativeBridgeResult(response);

    if (!parsed || !parsed.success) {
      const message = parsed?.error || 'No se pudo abrir ML Kit.';
      if (hint) hint.textContent = 'Intente Escanear otra vez o use Cargar PDF.';
      alert(`No se pudo abrir el escáner inteligente:\n${message}`);
    }
  } catch (err) {
    console.warn('Escáner inteligente no disponible:', err);
    if (hint) hint.textContent = 'No se pudo abrir el escáner inteligente.';
    alert(`No se pudo abrir el escáner inteligente:\n${err.message || err}`);
  }
}

async function handleNativeDocumentScanResult(event) {
  const detail = typeof event.detail === 'string'
    ? parseNativeBridgeResult(event.detail)
    : (event.detail || {});
  const hint = document.getElementById('scan-hint');

  if (detail.cancelled) {
    if (hint) hint.textContent = 'Escaneo cancelado. Puede volver a intentarlo.';
    return;
  }

  if (!detail.success) {
    const message = detail.error || 'El escáner no devolvió resultado.';
    if (hint) hint.textContent = 'Intente Escanear otra vez o use Cargar PDF.';
    alert(`No se pudo usar el escáner inteligente:\n${message}`);
    return;
  }

  const pages = Array.isArray(detail.pages) ? detail.pages : [];
  if (!pages.length) {
    if (hint) hint.textContent = 'El escáner no devolvió páginas.';
    alert('ML Kit no devolvió páginas para guardar.');
    return;
  }

  const targetIndex = state.retakeIndex !== null ? state.retakeIndex : null;
  let imported = 0;

  try {
    showProcessingOverlay('Importando páginas escaneadas...', 8);
    for (let i = 0; i < pages.length; i++) {
      updateProcessingProgress(
        `Guardando hoja ${i + 1} de ${pages.length}...`,
        10 + Math.round(((i + 1) / pages.length) * 82)
      );

      const pageBase64 = getNativeScannedPageBase64(pages[i]);
      if (!pageBase64) continue;

      const replaceIndex = targetIndex !== null && imported === 0 ? targetIndex : null;
      saveScannedPageBase64(pageBase64, replaceIndex, 'escaneada con ML Kit');
      imported++;
    }
  } catch (err) {
    console.error('Error importando escaneo ML Kit:', err);
    alert(`No se pudieron importar las páginas escaneadas:\n${err.message || err}`);
  } finally {
    hideProcessingOverlay();
  }

  if (!imported) {
    if (hint) hint.textContent = 'No se guardó ninguna hoja escaneada.';
    return;
  }

  if (hint) {
    hint.textContent = targetIndex !== null
      ? `Hoja #${targetIndex + 1} reemplazada con escáner inteligente.`
      : `${imported} hoja${imported === 1 ? '' : 's'} guardada${imported === 1 ? '' : 's'} con escáner inteligente.`;
  }
}

function getNativeScannedPageBase64(page) {
  const embedded = normalizeImageBase64(page?.imageBase64 || '');
  if (embedded) return embedded;

  if (
    page?.uri &&
    window.CiespalDocumentScanner &&
    typeof window.CiespalDocumentScanner.readImageAsBase64 === 'function'
  ) {
    const response = window.CiespalDocumentScanner.readImageAsBase64(page.uri);
    const parsed = parseNativeBridgeResult(response);
    if (parsed?.success && parsed.imageBase64) {
      return normalizeImageBase64(parsed.imageBase64);
    }
    throw new Error(parsed?.error || 'No se pudo leer la imagen escaneada.');
  }

  return '';
}

function normalizeImageBase64(value) {
  return String(value || '')
    .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
    .trim();
}

function saveScannedPageBase64(base64, targetIndex = null, qualityLabel = 'guardada') {
  const cleanBase64 = normalizeImageBase64(base64);
  if (!cleanBase64) throw new Error('Imagen escaneada vacía.');

  const blob = imageBase64ToBlob(cleanBase64);
  const hint = document.getElementById('scan-hint');
  const startsFreshLot = targetIndex === null && state.bookPagesBase64.length === 0;
  if (startsFreshLot) clearRecordState({ preserveLibrary: true });
  state.savedPagesBase64 = [];

  if (targetIndex !== null && targetIndex >= 0 && targetIndex < state.bookPagesBase64.length) {
    state.bookPagesBuffer[targetIndex] = blob;
    state.bookPagesBase64[targetIndex] = cleanBase64;
    if (state.retakeIndex === targetIndex) state.retakeIndex = null;
    if (hint) hint.textContent = `Hoja #${targetIndex + 1} reemplazada, ${qualityLabel}`;
  } else {
    state.bookPagesBuffer.push(blob);
    state.bookPagesBase64.push(cleanBase64);
    if (hint) hint.textContent = `Hoja #${state.bookPagesBuffer.length} guardada, ${qualityLabel}`;
  }

  updatePageCounter();
  renderThumbnails();
  if (startsFreshLot) renderRecordsStrip();
  scheduleDraftSave();
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

  // Efecto visual de flash blanco en la cámara al disparar
  const wrapper = document.querySelector('.viewfinder-wrapper');
  if (wrapper) {
    wrapper.style.opacity = '0.3';
    setTimeout(() => { wrapper.style.opacity = '1'; }, 120);
  }

  const targetIndex = state.retakeIndex !== null ? state.retakeIndex : null;
  let cropSuccess = false;
  let captureQualityLabel = 'recortada';

  if (cropFromLiveDetection(tempCanvas, canvas)) {
    cropSuccess = true;
    captureQualityLabel = 'bordes detectados y recortada';
  }

  try {
    if (!cropSuccess && SCAN_CONFIG.usePerspectiveWarp) {
      cropSuccess = autoCropPerspectiveOpenCV(tempCanvas, canvas);
      if (cropSuccess) captureQualityLabel = 'recortada y enderezada';
    }
  } catch (err) {
    console.warn('Error OpenCV:', err);
  }

  if (!cropSuccess) {
    const bounds = detectForegroundBookBounds2D(tempCtx, fullW, fullH)
      || detectPaperSheetBounds2D(tempCtx, fullW, fullH)
      || detectSmartBookBounds(tempCtx, fullW, fullH);
    renderCroppedFrame(tempCanvas, canvas, bounds);
    captureQualityLabel = bounds?.method === 'foreground'
      ? 'libro detectado y recortado'
      : bounds?.method === 'paper'
        ? 'hoja detectada y recortada'
        : 'recortada con ajuste automático';
  }

  enhanceDocumentWithOpenCV(canvas, state.scanFilterMode || 'magic_color');
  saveProcessedPageCanvas(canvas, targetIndex, captureQualityLabel);
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
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (mode === 'bw') {
        const val = lum > 135 ? 255 : 0;
        d[i] = val; d[i+1] = val; d[i+2] = val;
      } else {
        if (lum > 165) {
          d[i] = Math.min(255, r * 1.18);
          d[i+1] = Math.min(255, g * 1.18);
          d[i+2] = Math.min(255, b * 1.18);
        } else if (lum < 115) {
          d[i] = Math.max(0, r * 0.82);
          d[i+1] = Math.max(0, g * 0.82);
          d[i+2] = Math.max(0, b * 0.82);
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

  let src;
  let srcTri;
  let dstTri;
  let transform;
  let dst;
  try {
    src = cv.imread(srcCanvas);
    const candidate = findDocumentPolygonOpenCV(src);
    if (!candidate) {
      return false;
    }

    const ordered = orderDocumentPoints(candidate.points);
    const size = getPerspectiveOutputSize(ordered);
    if (!isPerspectiveSizeValid(size, src.cols, src.rows)) {
      return false;
    }

    const { tl, tr, br, bl } = ordered;
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      tl.x, tl.y,
      tr.x, tr.y,
      br.x, br.y,
      bl.x, bl.y
    ]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      size.width - 1, 0,
      size.width - 1, size.height - 1,
      0, size.height - 1
    ]);

    transform = cv.getPerspectiveTransform(srcTri, dstTri);
    dst = new cv.Mat();
    cv.warpPerspective(src, dst, transform, new cv.Size(size.width, size.height));

    dstCanvas.width = size.width;
    dstCanvas.height = size.height;
    cv.imshow(dstCanvas, dst);
    return true;

  } catch (err) {
    console.warn('Fallback OpenCV autoCrop:', err);
    return false;
  } finally {
    [src, srcTri, dstTri, transform, dst].forEach(mat => {
      if (mat && typeof mat.delete === 'function') mat.delete();
    });
  }
}

function findDocumentPolygonOpenCV(src) {
  const mats = [];
  let best = null;

  try {
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    mats.push(gray, blur);

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const cannySoft = new cv.Mat();
    const cannyStrong = new cv.Mat();
    const adaptive = new cv.Mat();
    const adaptiveEdges = new cv.Mat();
    const otsu = new cv.Mat();
    const kernel3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const kernel7 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    mats.push(cannySoft, cannyStrong, adaptive, adaptiveEdges, otsu, kernel3, kernel7);

    cv.Canny(blur, cannySoft, 35, 120);
    cv.dilate(cannySoft, cannySoft, kernel3);

    cv.Canny(blur, cannyStrong, 70, 190);
    cv.dilate(cannyStrong, cannyStrong, kernel3);

    cv.adaptiveThreshold(blur, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 7);
    cv.morphologyEx(adaptive, adaptive, cv.MORPH_CLOSE, kernel7);
    cv.Canny(adaptive, adaptiveEdges, 40, 140);
    cv.dilate(adaptiveEdges, adaptiveEdges, kernel3);

    cv.threshold(blur, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(otsu, otsu, cv.MORPH_CLOSE, kernel7);

    [cannySoft, cannyStrong, adaptiveEdges, otsu].forEach((mask, idx) => {
      const found = findBestPolygonInMask(mask, src.cols, src.rows, idx * 0.15);
      if (found && (!best || found.score > best.score)) {
        best = found;
      }
    });
  } catch (err) {
    console.warn('OpenCV polygon detection failed:', err);
  } finally {
    mats.forEach(mat => {
      if (mat && typeof mat.delete === 'function') mat.delete();
    });
  }

  return best;
}

function findBestPolygonInMask(mask, imgW, imgH, scoreBias = 0) {
  const work = mask.clone();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let best = null;
  const imgArea = imgW * imgH;

  try {
    cv.findContours(work, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      let hull = null;

      try {
        if (Math.abs(cv.contourArea(contour)) < imgArea * 0.025) continue;

        const shape = new cv.Mat();
        hull = shape;
        if (typeof cv.convexHull === 'function') {
          cv.convexHull(contour, shape, false, true);
        } else {
          contour.copyTo(shape);
        }

        const area = Math.abs(cv.contourArea(shape));
        if (area < imgArea * 0.10 || area > imgArea * 0.985) continue;

        const perimeter = cv.arcLength(shape, true);
        const epsilons = [0.012, 0.018, 0.026, 0.036, 0.052, 0.07];

        for (const epsilon of epsilons) {
          const approx = new cv.Mat();
          try {
            cv.approxPolyDP(shape, approx, epsilon * perimeter, true);
            if (approx.rows !== 4) continue;
            if (typeof cv.isContourConvex === 'function' && !cv.isContourConvex(approx)) continue;

            const points = matToPoints(approx);
            const score = scoreDocumentPolygon(points, area, imgW, imgH) + scoreBias;
            if (Number.isFinite(score) && (!best || score > best.score)) {
              best = { points, score };
            }
          } finally {
            approx.delete();
          }
        }
      } finally {
        if (hull) hull.delete();
        contour.delete();
      }
    }
  } finally {
    work.delete();
    contours.delete();
    hierarchy.delete();
  }

  return best;
}

function matToPoints(mat) {
  const points = [];
  const data = mat.data32S || mat.data32F;
  for (let i = 0; i < mat.rows; i++) {
    points.push({
      x: data[i * 2],
      y: data[i * 2 + 1]
    });
  }
  return points;
}

function orderDocumentPoints(points) {
  if (!points || points.length !== 4) return null;

  const bySum = [...points].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => (a.x - a.y) - (b.x - b.y));
  const ordered = {
    tl: bySum[0],
    br: bySum[3],
    tr: byDiff[3],
    bl: byDiff[0]
  };

  const unique = new Set(Object.values(ordered).map(p => `${Math.round(p.x)}:${Math.round(p.y)}`));
  if (unique.size === 4) return ordered;

  const byY = [...points].sort((a, b) => a.y - b.y);
  const top = [byY[0], byY[1]].sort((a, b) => a.x - b.x);
  const bottom = [byY[2], byY[3]].sort((a, b) => a.x - b.x);
  return { tl: top[0], tr: top[1], br: bottom[1], bl: bottom[0] };
}

function getPerspectiveOutputSize(ordered) {
  const widthA = Math.hypot(ordered.br.x - ordered.bl.x, ordered.br.y - ordered.bl.y);
  const widthB = Math.hypot(ordered.tr.x - ordered.tl.x, ordered.tr.y - ordered.tl.y);
  const heightA = Math.hypot(ordered.tr.x - ordered.br.x, ordered.tr.y - ordered.br.y);
  const heightB = Math.hypot(ordered.tl.x - ordered.bl.x, ordered.tl.y - ordered.bl.y);
  return {
    width: Math.max(1, Math.round(Math.max(widthA, widthB))),
    height: Math.max(1, Math.round(Math.max(heightA, heightB)))
  };
}

function isPerspectiveSizeValid(size, imgW, imgH) {
  const minSide = Math.min(size.width, size.height);
  const maxSide = Math.max(size.width, size.height);
  if (minSide < Math.min(imgW, imgH) * 0.18) return false;
  if (size.width * size.height < imgW * imgH * 0.10) return false;
  return maxSide / minSide <= 3.2;
}

function scoreDocumentPolygon(points, area, imgW, imgH) {
  const ordered = orderDocumentPoints(points);
  if (!ordered) return Number.NEGATIVE_INFINITY;

  const size = getPerspectiveOutputSize(ordered);
  if (!isPerspectiveSizeValid(size, imgW, imgH)) return Number.NEGATIVE_INFINITY;

  const areaRatio = Math.abs(polygonArea(points)) / (imgW * imgH);
  if (areaRatio < 0.10 || areaRatio > 0.985) return Number.NEGATIVE_INFINITY;

  const rectArea = size.width * size.height;
  const fillRatio = Math.min(1, Math.max(0, area / Math.max(1, rectArea)));
  const aspect = Math.max(size.width, size.height) / Math.max(1, Math.min(size.width, size.height));
  const aspectPenalty = Math.max(0, aspect - 1.65) * 8;
  const center = centroid(points);
  const centerDistance = Math.hypot(center.x - imgW / 2, center.y - imgH / 2) / Math.hypot(imgW / 2, imgH / 2);
  const anglePenalty = maxCornerCosine(ordered) * 12;

  return areaRatio * 100 + fillRatio * 22 - aspectPenalty - centerDistance * 18 - anglePenalty;
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
}

function centroid(points) {
  const sum = points.reduce((acc, point) => {
    acc.x += point.x;
    acc.y += point.y;
    return acc;
  }, { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function maxCornerCosine({ tl, tr, br, bl }) {
  return Math.max(
    Math.abs(cornerCosine(bl, tl, tr)),
    Math.abs(cornerCosine(tl, tr, br)),
    Math.abs(cornerCosine(tr, br, bl)),
    Math.abs(cornerCosine(br, bl, tl))
  );
}

function cornerCosine(prev, corner, next) {
  const ax = prev.x - corner.x;
  const ay = prev.y - corner.y;
  const bx = next.x - corner.x;
  const by = next.y - corner.y;
  const dot = ax * bx + ay * by;
  const norm = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return norm ? dot / norm : 1;
}

function renderCroppedFrame(srcCanvas, dstCanvas, bounds) {
  const clamped = clampBounds(bounds, srcCanvas.width, srcCanvas.height);
  dstCanvas.width = clamped.w;
  dstCanvas.height = clamped.h;
  const ctx = dstCanvas.getContext('2d');
  ctx.filter = 'contrast(1.08) brightness(1.03)';
  ctx.drawImage(srcCanvas, clamped.x, clamped.y, clamped.w, clamped.h, 0, 0, clamped.w, clamped.h);
  ctx.filter = 'none';
}

function clampBounds(bounds, maxW, maxH) {
  const fallback = {
    x: Math.round(maxW * 0.06),
    y: Math.round(maxH * 0.08),
    w: Math.round(maxW * 0.88),
    h: Math.round(maxH * 0.84)
  };
  const source = bounds || fallback;
  const x = Math.max(0, Math.min(maxW - 1, Math.round(source.x)));
  const y = Math.max(0, Math.min(maxH - 1, Math.round(source.y)));
  const w = Math.max(80, Math.min(maxW - x, Math.round(source.w)));
  const h = Math.max(80, Math.min(maxH - y, Math.round(source.h)));
  return { x, y, w, h, method: source.method || 'fallback' };
}

function detectForegroundBookBounds2D(tempCtx, w, h) {
  try {
    const sw = 260;
    const sh = Math.max(1, Math.round((h / w) * sw));
    const scaled = document.createElement('canvas');
    scaled.width = sw;
    scaled.height = sh;
    const sCtx = scaled.getContext('2d');
    sCtx.drawImage(tempCtx.canvas, 0, 0, sw, sh);

    const pixels = sCtx.getImageData(0, 0, sw, sh).data;
    const bg = cornerBackgroundColor(pixels, sw, sh);
    const mask = new Uint8Array(sw * sh);
    const dynamicThreshold = bg.lum < 70 ? 26 : 38;

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const idx = (y * sw + x) * 4;
        const r = pixels[idx];
        const g = pixels[idx + 1];
        const b = pixels[idx + 2];
        const lum = luminance(r, g, b);
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        const dist = colorDistance({ r, g, b, lum }, bg);

        if (dist > dynamicThreshold || Math.abs(lum - bg.lum) > 34 || chroma > bg.chroma + 28) {
          mask[y * sw + x] = 1;
        }
      }
    }

    closeMask(mask, sw, sh, 2);
    const component = largestPaperComponent(mask, sw, sh);
    if (!component) return null;

    const boxW = component.maxX - component.minX + 1;
    const boxH = component.maxY - component.minY + 1;
    const touchesTooMuchEdge = (
      component.minX <= 1 &&
      component.minY <= 1 &&
      component.maxX >= sw - 2 &&
      component.maxY >= sh - 2
    );
    if (touchesTooMuchEdge || boxW * boxH > sw * sh * 0.96) {
      return null;
    }

    const padX = Math.max(5, Math.round(boxW * 0.08));
    const padY = Math.max(5, Math.round(boxH * 0.08));
    const left = Math.max(0, component.minX - padX);
    const top = Math.max(0, component.minY - padY);
    const right = Math.min(sw - 1, component.maxX + padX);
    const bottom = Math.min(sh - 1, component.maxY + padY);
    const scaleX = w / sw;
    const scaleY = h / sh;

    return {
      x: Math.round(left * scaleX),
      y: Math.round(top * scaleY),
      w: Math.round((right - left + 1) * scaleX),
      h: Math.round((bottom - top + 1) * scaleY),
      method: 'foreground'
    };
  } catch (err) {
    console.warn('Foreground bounds fallback failed:', err);
    return null;
  }
}

function detectPaperSheetBounds2D(tempCtx, w, h) {
  try {
    const sw = 240;
    const sh = Math.max(1, Math.round((h / w) * sw));
    const scaled = document.createElement('canvas');
    scaled.width = sw;
    scaled.height = sh;
    const sCtx = scaled.getContext('2d');
    sCtx.drawImage(tempCtx.canvas, 0, 0, sw, sh);

    const pixels = sCtx.getImageData(0, 0, sw, sh).data;
    const luminanceValues = [];
    for (let i = 0; i < pixels.length; i += 4) {
      luminanceValues.push(luminance(pixels[i], pixels[i + 1], pixels[i + 2]));
    }
    luminanceValues.sort((a, b) => a - b);

    const p55 = percentile(luminanceValues, 0.55);
    const p82 = percentile(luminanceValues, 0.82);
    const bg = cornerBackgroundLuminance(pixels, sw, sh);
    const threshold = clampNumber(Math.max(108, Math.min(p82 - 8, Math.max(p55 + 14, bg + 18))), 100, 228);
    const mask = new Uint8Array(sw * sh);

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const idx = (y * sw + x) * 4;
        const r = pixels[idx];
        const g = pixels[idx + 1];
        const b = pixels[idx + 2];
        const lum = luminance(r, g, b);
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        if ((lum >= threshold && chroma < 92) || lum >= p82 + 6) {
          mask[y * sw + x] = 1;
        }
      }
    }

    const component = largestPaperComponent(mask, sw, sh);
    if (!component) return null;

    const padX = Math.max(2, Math.round((component.maxX - component.minX) * 0.025));
    const padY = Math.max(2, Math.round((component.maxY - component.minY) * 0.025));
    const left = Math.max(0, component.minX - padX);
    const top = Math.max(0, component.minY - padY);
    const right = Math.min(sw - 1, component.maxX + padX);
    const bottom = Math.min(sh - 1, component.maxY + padY);

    const scaleX = w / sw;
    const scaleY = h / sh;
    return {
      x: Math.round(left * scaleX),
      y: Math.round(top * scaleY),
      w: Math.round((right - left + 1) * scaleX),
      h: Math.round((bottom - top + 1) * scaleY),
      method: 'paper'
    };
  } catch (err) {
    console.warn('Paper bounds fallback failed:', err);
    return null;
  }
}

function largestPaperComponent(mask, sw, sh) {
  const visited = new Uint8Array(mask.length);
  let best = null;
  const minArea = sw * sh * 0.045;

  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const start = y * sw + x;
      if (!mask[start] || visited[start]) continue;

      const stack = [start];
      visited[start] = 1;
      let area = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      while (stack.length) {
        const idx = stack.pop();
        const cx = idx % sw;
        const cy = Math.floor(idx / sw);
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]].forEach(([nx, ny]) => {
          if (nx < 0 || nx >= sw || ny < 0 || ny >= sh) return;
          const next = ny * sw + nx;
          if (visited[next] || !mask[next]) return;
          visited[next] = 1;
          stack.push(next);
        });
      }

      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      if (area < minArea || boxW < sw * 0.24 || boxH < sh * 0.24) continue;

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const centerDistance = Math.hypot(centerX - sw / 2, centerY - sh / 2) / Math.hypot(sw / 2, sh / 2);
      const fillRatio = area / (boxW * boxH);
      const score = area * (0.75 + fillRatio) - centerDistance * sw * sh * 0.08;

      if (!best || score > best.score) {
        best = { minX, maxX, minY, maxY, area, score };
      }
    }
  }

  return best;
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return 0;
  const idx = Math.max(0, Math.min(sortedValues.length - 1, Math.round((sortedValues.length - 1) * ratio)));
  return sortedValues[idx];
}

function cornerBackgroundLuminance(pixels, w, h) {
  const samples = [];
  const size = Math.max(3, Math.round(Math.min(w, h) * 0.10));
  const corners = [
    [0, 0],
    [w - size, 0],
    [0, h - size],
    [w - size, h - size]
  ];

  corners.forEach(([startX, startY]) => {
    for (let y = Math.max(0, startY); y < Math.min(h, startY + size); y += 2) {
      for (let x = Math.max(0, startX); x < Math.min(w, startX + size); x += 2) {
        const idx = (y * w + x) * 4;
        samples.push(luminance(pixels[idx], pixels[idx + 1], pixels[idx + 2]));
      }
    }
  });

  samples.sort((a, b) => a - b);
  return percentile(samples, 0.45);
}

function cornerBackgroundColor(pixels, w, h) {
  const colors = [];
  const size = Math.max(4, Math.round(Math.min(w, h) * 0.11));
  const corners = [
    [0, 0],
    [w - size, 0],
    [0, h - size],
    [w - size, h - size]
  ];

  corners.forEach(([startX, startY]) => {
    for (let y = Math.max(0, startY); y < Math.min(h, startY + size); y += 2) {
      for (let x = Math.max(0, startX); x < Math.min(w, startX + size); x += 2) {
        const idx = (y * w + x) * 4;
        const r = pixels[idx];
        const g = pixels[idx + 1];
        const b = pixels[idx + 2];
        colors.push({
          r,
          g,
          b,
          lum: luminance(r, g, b),
          chroma: Math.max(r, g, b) - Math.min(r, g, b)
        });
      }
    }
  });

  if (!colors.length) return { r: 0, g: 0, b: 0, lum: 0, chroma: 0 };
  colors.sort((a, b) => a.lum - b.lum);
  const sample = colors[Math.floor(colors.length * 0.45)];
  return sample || colors[0];
}

function colorDistance(color, bg) {
  return (
    Math.abs(color.r - bg.r) * 0.35 +
    Math.abs(color.g - bg.g) * 0.35 +
    Math.abs(color.b - bg.b) * 0.35 +
    Math.abs(color.lum - bg.lum) * 0.75
  );
}

function closeMask(mask, w, h, passes = 1) {
  for (let i = 0; i < passes; i++) {
    dilateMask(mask, w, h);
  }
  for (let i = 0; i < passes; i++) {
    erodeMask(mask, w, h);
  }
}

function dilateMask(mask, w, h) {
  const source = mask.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (source[idx]) continue;
      if (source[idx - 1] || source[idx + 1] || source[idx - w] || source[idx + w]) {
        mask[idx] = 1;
      }
    }
  }
}

function erodeMask(mask, w, h) {
  const source = mask.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (!source[idx]) continue;
      if (!source[idx - 1] || !source[idx + 1] || !source[idx - w] || !source[idx + w]) {
        mask[idx] = 0;
      }
    }
  }
}

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

  resetScanBuffer();
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
    scheduleDraftSave();
    hideProcessingOverlay();

    alert(`Se cargó el PDF con ${numPages} hojas.\n\nPresione 'Generar ficha y PDF' para extraer los metadatos con IA.`);
    document.getElementById('scan-hint').textContent = `PDF cargado: ${numPages} hojas. Presione 'Generar ficha y PDF'.`;

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
    updateHomeOverview();
    return;
  }

  bar.classList.remove('hidden');

  state.bookPagesBase64.forEach((b64, idx) => {
    const card = document.createElement('div');
    card.className = `thumb-card${state.activeModalIndex === idx ? ' active' : ''}`;
    card.title = `Ver hoja #${idx + 1}`;
    card.innerHTML = `
      <img src="data:image/jpeg;base64,${b64}" alt="Hoja ${idx + 1}">
      <span class="thumb-num">#${idx + 1}</span>
    `;
    card.addEventListener('click', () => openPageModal(idx));
    container.appendChild(card);
  });
  updateHomeOverview();
}

function quickDeletePage(idx) {
  if (confirm(`¿Eliminar la Hoja #${idx + 1}?`)) {
    state.bookPagesBuffer.splice(idx, 1);
    state.bookPagesBase64.splice(idx, 1);
    if (state.savedPagesBase64.length) state.savedPagesBase64.splice(idx, 1);
    
    if (state.retakeIndex === idx) state.retakeIndex = null;
    else if (state.retakeIndex > idx) state.retakeIndex--;

    updatePageCounter();
    renderThumbnails();
    scheduleDraftSave();
  }
}

// ========== MODAL DE PREVISUALIZACIÓN & REPETICIÓN DE HOJA ==========
function openPageModal(idx) {
  state.activeModalIndex = idx;
  const modal = document.getElementById('page-modal');
  renderPageModal();
  modal.classList.remove('hidden');
  renderThumbnails();
}

function closeModal() {
  document.getElementById('page-modal').classList.add('hidden');
  state.activeModalIndex = null;
  renderThumbnails();
}

function renderPageModal() {
  const total = state.bookPagesBase64.length;
  if (!total) {
    closeModal();
    return;
  }

  state.activeModalIndex = clampNumber(state.activeModalIndex ?? 0, 0, total - 1);
  const idx = state.activeModalIndex;
  document.getElementById('modal-page-title').textContent = `Hoja ${idx + 1} de ${total}`;
  document.getElementById('modal-page-img').src = `data:image/jpeg;base64,${state.bookPagesBase64[idx]}`;

  const prevBtn = document.getElementById('btn-modal-prev-page');
  const nextBtn = document.getElementById('btn-modal-next-page');
  if (prevBtn) prevBtn.disabled = total <= 1;
  if (nextBtn) nextBtn.disabled = total <= 1;

  renderModalThumbnails();
}

function renderModalThumbnails() {
  const strip = document.getElementById('modal-thumbnails-strip');
  if (!strip) return;

  strip.innerHTML = '';
  state.bookPagesBase64.forEach((b64, idx) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `modal-thumb${idx === state.activeModalIndex ? ' active' : ''}`;
    button.title = `Ver hoja ${idx + 1}`;
    button.innerHTML = `
      <img src="data:image/jpeg;base64,${b64}" alt="Hoja ${idx + 1}">
      <span>${idx + 1}</span>
    `;
    button.addEventListener('click', () => {
      state.activeModalIndex = idx;
      renderPageModal();
      renderThumbnails();
    });
    strip.appendChild(button);
  });
}

function moveModalPage(delta) {
  if (state.activeModalIndex === null || state.bookPagesBase64.length === 0) return;
  const total = state.bookPagesBase64.length;
  state.activeModalIndex = (state.activeModalIndex + delta + total) % total;
  renderPageModal();
  renderThumbnails();
}

function deleteCurrentModalPage() {
  if (state.activeModalIndex !== null) {
    const idx = state.activeModalIndex;
    quickDeletePage(idx);
    if (state.bookPagesBase64.length === 0) {
      closeModal();
    } else {
      state.activeModalIndex = Math.min(idx, state.bookPagesBase64.length - 1);
      renderPageModal();
      renderThumbnails();
    }
  }
}

function prepareRetakeFromModal() {
  if (state.activeModalIndex !== null) {
    state.retakeIndex = state.activeModalIndex;
    closeModal();
    
    document.getElementById('scan-hint').textContent = 
      `MODO REPETIR: Escanee una hoja para reemplazar la Hoja #${state.retakeIndex + 1}`;
    
    alert(`Listo. Presione Escanear para reemplazar la Hoja #${state.retakeIndex + 1}.`);
  }
}

function updatePageCounter() {
  const count = state.bookPagesBuffer.length;
  document.getElementById('scanned-page-count').textContent = count;
  const btn = document.getElementById('btn-finish-pdf');
  count > 0 ? btn.classList.remove('hidden') : btn.classList.add('hidden');
  updateHomeOverview();
}

function updateHomeOverview() {
  const pages = state.bookPagesBase64.length;

  const emptyPanel = document.getElementById('empty-lot-panel');
  if (emptyPanel) emptyPanel.classList.toggle('hidden', pages > 0);
}

function getRecordPages(record = {}) {
  if (Array.isArray(record.pagesBase64) && record.pagesBase64.length) return record.pagesBase64;
  if (Array.isArray(record.savedPagesBase64) && record.savedPagesBase64.length) return record.savedPagesBase64;
  return [];
}

function getRecordPageCount(record = {}) {
  const pages = getRecordPages(record);
  return record.pageCount || pages.length || parseInt(record.numero_paginas, 10) || 0;
}

function getCurrentPagesSnapshot() {
  if (Array.isArray(state.savedPagesBase64) && state.savedPagesBase64.length) {
    return [...state.savedPagesBase64];
  }
  if (Array.isArray(state.bookPagesBase64) && state.bookPagesBase64.length) {
    return [...state.bookPagesBase64];
  }
  return [];
}

function attachPagesToRecord(record, totalPages, pagesOverride = null) {
  const explicitPages = Array.isArray(pagesOverride) ? pagesOverride : [];
  const existingPages = getRecordPages(record);
  const pagesBase64 = explicitPages.length ? [...explicitPages] : existingPages.length ? existingPages : getCurrentPagesSnapshot();
  return {
    ...record,
    pagesBase64,
    pageCount: totalPages || pagesBase64.length || getRecordPageCount(record)
  };
}

function getCompiledPdfPages(record = null) {
  if (record) {
    const recordPages = getRecordPages(record);
    if (recordPages.length) return recordPages;
  }

  const currentPages = getCurrentPagesSnapshot();
  if (currentPages.length) {
    return currentPages;
  }

  return getRecordPages(state.currentRecord || getActiveExportRecord());
}

function resetScanBuffer(options = {}) {
  const preserveSavedPages = Boolean(options.preserveSavedPages);
  const preserveRecord = Boolean(options.preserveRecord);

  state.bookPagesBuffer = [];
  state.bookPagesBase64 = [];
  if (!preserveSavedPages) state.savedPagesBase64 = [];
  state.detectedIndexPages = [];
  state.retakeIndex = null;
  if (!preserveRecord) clearRecordState({ preserveLibrary: true });
  updatePageCounter();
  renderThumbnails();
  if (!preserveRecord) renderKohaRecordsTable();
  scheduleDraftSave();
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

// ========== PROCESAMIENTO CON DEEPSEEK DIRECTO DESDE EL APK ==========
async function processBookWithDeepSeekAI() {
  if (state.bookPagesBuffer.length === 0) {
    alert('Primero escanee hojas o cargue un PDF del libro.');
    return;
  }

  const apiKey = await ensureDeepSeekApiKey();
  if (!apiKey) return;

  const totalPages = state.bookPagesBuffer.length;
  const indexMode = getIndexExtractionMode();
  const modeText = indexMode === INDEX_EXTRACTION_MODES.generated
    ? 'sin índice'
    : 'con índice';
  showProcessingOverlay(`Preparando hojas (${modeText}) para DeepSeek...`, 10);

  try {
    const selectedIndexes = selectPageIndexesForAi(totalPages, getAiPageLimitForMode(indexMode));
    const content = [{
      type: 'text',
      text: buildDeepSeekExtractionPrompt(totalPages, selectedIndexes, indexMode)
    }];

    for (let i = 0; i < selectedIndexes.length; i++) {
      const pageIndex = selectedIndexes[i];
      const resizedBase64 = await resizeBase64ForAi(state.bookPagesBase64[pageIndex], 1200);
      content.push({
        type: 'text',
        text: `Hoja escaneada ${pageIndex + 1} de ${totalPages}.`
      });
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${resizedBase64}`,
          detail: 'high'
        }
      });
      updateProcessingProgress(
        `Preparando imagen ${i + 1} de ${selectedIndexes.length} para IA...`,
        15 + Math.round(((i + 1) / selectedIndexes.length) * 25)
      );
    }

    updateProcessingProgress('DeepSeek está extrayendo metadatos MARC21...', 55);

    const result = await deepSeekHttpRequest(DEEPSEEK_CONFIG.apiUrl, {
      method: 'POST',
      apiKey,
      timeoutMs: indexMode === INDEX_EXTRACTION_MODES.generated ? 300000 : 180000,
      data: {
        model: DEEPSEEK_CONFIG.visionModel,
        messages: [
          {
            role: 'system',
            content: 'Eres un catalogador experto MARC21 para una mediateca. Responde solo JSON válido.'
          },
          {
            role: 'user',
            content
          }
        ],
        temperature: 0,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' }
      }
    });

    if (!result.ok) {
      throw new Error(`DeepSeek respondió ${result.status}: ${extractDeepSeekError(result.data || result.text)}`);
    }

    const contentText = result.data?.choices?.[0]?.message?.content || '';
    const extracted = extractJsonFromAiText(contentText);
    if (!Object.keys(extracted).length) {
      throw new Error('DeepSeek no devolvió JSON válido.');
    }

    updateProcessingProgress('Generando registro y PDF local...', 88);
    const record = normalizeDeepSeekRecord(extracted, totalPages);

    updateProcessingProgress('Extracción MARC21 finalizada.', 100);

    const completedPages = [...state.bookPagesBase64];
    state.savedPagesBase64 = completedPages;

    setTimeout(() => {
      hideProcessingOverlay();
      resetScanBuffer({ preserveSavedPages: true, preserveRecord: true });
      onBookScanCompleted(record, totalPages, completedPages);
    }, 400);

  } catch (err) {
    hideProcessingOverlay();
    console.error('Error en procesamiento directo con DeepSeek:', err);

    const errorMsg = getDeepSeekDirectErrorMessage(err);
    alert(`Error al procesar con IA:\n${errorMsg}\n\nSe cargará una plantilla vacía para completar manualmente.`);

    const completedPages = [...state.bookPagesBase64];
    state.savedPagesBase64 = completedPages;
    resetScanBuffer({ preserveSavedPages: true, preserveRecord: true });
    onBookScanCompleted(createFallbackRecord(totalPages), totalPages, completedPages);
  }
}

function selectPageIndexesForAi(totalPages, maxDirectPages = DEEPSEEK_CONFIG.maxDirectPages) {
  const safeLimit = Number.isFinite(maxDirectPages) ? Math.max(0, maxDirectPages) : DEEPSEEK_CONFIG.maxDirectPages;
  const maxPages = Math.min(totalPages, safeLimit);
  if (maxPages === 0) return [];

  const priority = [];
  const seen = new Set();
  const addIndex = idx => {
    if (idx < 0 || idx >= totalPages || seen.has(idx)) return;
    seen.add(idx);
    priority.push(idx);
  };

  (state.detectedIndexPages || []).forEach(idx => {
    addIndex(idx - 1);
    addIndex(idx);
    addIndex(idx + 1);
  });

  const frontPages = Math.min(totalPages, Math.min(8, maxPages));
  for (let i = 0; i < frontPages; i++) addIndex(i);

  if (totalPages > 1) addIndex(totalPages - 1);

  const intervals = Math.max(1, maxPages - 1);
  for (let i = 0; priority.length < maxPages && i <= intervals; i++) {
    addIndex(Math.round((i / intervals) * (totalPages - 1)));
  }

  for (let i = 0; priority.length < maxPages && i < totalPages; i++) {
    addIndex(i);
  }

  return priority
    .slice(0, maxPages)
    .sort((a, b) => a - b);
}

function buildDeepSeekExtractionPrompt(totalPages, selectedIndexes, indexMode = getIndexExtractionMode()) {
  const selectedPages = selectedIndexes.map(idx => idx + 1).join(', ');
  const indexRules = buildIndexExtractionPromptRules(indexMode);
  return `
Eres un bibliotecario experto en catalogación MARC21/Koha para la Mediateca CIESPAL.
Se escanearon ${totalPages} hojas. Para extraer metadatos estás viendo estas hojas: ${selectedPages}.
Cada imagen está precedida por una etiqueta "Hoja escaneada N de ${totalPages}". Usa esa etiqueta como referencia cuando no se vea un número de página impreso.

Extrae metadatos bibliográficos reales usando solo texto visible. Si un dato no aparece claramente, deja el campo vacío. No inventes ISBN, editorial, autores, año, capítulos, clasificación ni materias por contexto.

Perfil Koha observado para CIESPAL:
- Clasificación/signatura local: 084 $a.
- Publicación: 260 $a, 260 $b, 260 $c.
- Descripción física: separa extensión 300 $a, soporte/detalle 300 $b y dimensiones 300 $c.
- Materias controladas: 650 $a solo si aparecen explícitas o son muy evidentes.
- Descriptores libres: 653 $a para palabras clave sugeridas por IA.
- Recurso digital: 856 $y debe decir "Recuperar PDF"; 856 $u será el PDF local generado por la app.
- Tipo local Koha para libros: 942 $c = "BK".

Reglas para tabla_contenidos:
${indexRules}

Devuelve SOLO JSON válido con esta forma:
{
  "codigo_control": "",
  "isbn": "",
  "titulo": "",
  "subtitulo": "",
  "autor_principal": "",
  "colaboradores": "",
  "lugar_publicacion": "",
  "editorial": "",
  "anio_publicacion": "",
  "numero_paginas": "",
  "descripcion_fisica": "",
  "soporte_fisico": "",
  "dimensiones": "",
  "notas_fisicas": "",
  "tipo_material": "BK",
  "temas_controlados": "",
  "descriptores_libres": "",
  "clasificacion": "",
  "resumen": "",
  "tabla_contenidos": ""
}`.trim();
}

function buildIndexExtractionPromptRules(indexMode) {
  if (normalizeIndexExtractionMode(indexMode) === INDEX_EXTRACTION_MODES.generated) {
    return `
Modo seleccionado: SIN ÍNDICE. El usuario indicó que el libro no trae índice formal.
1. Si aun así encuentras páginas tituladas "ÍNDICE", "INDICE", "CONTENIDO", "TABLA DE CONTENIDOS", "SUMARIO", "INDEX" o "TABLE OF CONTENTS", transcríbelas línea por línea.
2. Si no existe índice formal, crea tabla_contenidos a partir de títulos, capítulos, unidades, lecciones, secciones o encabezados visibles dentro del libro.
3. Para cada entrada creada, incluye el número de página impreso si se ve. Si no se ve, usa la hoja escaneada correspondiente, por ejemplo: "Lección 1: Mi rutina diaria - hoja 7".
4. No inventes capítulos que no aparezcan como encabezado visible. Solo usa encabezados/títulos realmente leídos en las imágenes.
5. Conserva numeración y páginas cuando sean visibles. Usa líneas separadas, por ejemplo: "1. Introducción - p. 3".
6. Si solo ves una muestra del libro y no todas las hojas, genera el índice con los encabezados visibles en esa muestra.
7. Devuelve ese dato únicamente en tabla_contenidos. No uses claves como indice, contenido, sumario ni toc.`.trim();
  }

  return `
Modo seleccionado: ÍNDICE. El usuario indicó que el libro debería traer índice formal.
1. Busca páginas tituladas "ÍNDICE", "INDICE", "CONTENIDO", "TABLA DE CONTENIDOS", "SUMARIO", "INDEX" o "TABLE OF CONTENTS".
2. Si existe índice, transcríbelo línea por línea.
3. Si no encuentras un índice formal visible, deja tabla_contenidos como "".
4. No crees una tabla de contenidos desde encabezados sueltos en este modo.
5. Conserva numeración y páginas cuando sean visibles. Usa líneas separadas, por ejemplo: "1. Introducción - p. 3".
6. Devuelve ese dato únicamente en tabla_contenidos. No uses claves como indice, contenido, sumario ni toc.`.trim();
}

async function deepSeekHttpRequest(url, { method = 'GET', apiKey, data, timeoutMs = 180000 } = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`
  };
  if (data !== undefined) headers['Content-Type'] = 'application/json';

  const nativeHttp = window.Capacitor?.Plugins?.CapacitorHttp || window.CapacitorHttp;
  const isNative = Boolean(window.Capacitor?.isNativePlatform?.());

  if (isNative && nativeHttp?.request) {
    const response = await nativeHttp.request({
      url,
      method,
      headers,
      data,
      responseType: 'json',
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      data: parseHttpResponseData(response.data),
      text: typeof response.data === 'string' ? response.data : JSON.stringify(response.data || '')
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: controller.signal,
      cache: 'no-store'
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      data: parseHttpResponseData(text),
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseHttpResponseData(data) {
  if (!data) return {};
  if (typeof data === 'object') return data;
  try {
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

function extractJsonFromAiText(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (innerErr) {
      return {};
    }
  }
}

function extractDeepSeekError(payload) {
  if (!payload) return 'error desconocido';
  if (typeof payload === 'string') return payload.substring(0, 300);
  return (payload.error?.message || payload.message || JSON.stringify(payload)).substring(0, 300);
}

function getDeepSeekDirectErrorMessage(err) {
  const rawMessage = err?.message || 'Error desconocido';
  if (/401|unauthorized|authentication|api key|invalid/i.test(rawMessage)) {
    return 'La key de DeepSeek no parece válida. Toque el icono de llave y vuelva a pegarla.';
  }
  if (/failed to fetch|networkerror|load failed|network request failed|abort/i.test(rawMessage)) {
    return 'No se pudo conectar con DeepSeek. Revise que el celular tenga internet. En navegador web puede fallar por CORS; en el APK usa HTTP nativo.';
  }
  return rawMessage;
}

function normalizeDeepSeekRecord(extracted, totalPages) {
  const title = pickAiText(extracted, 'titulo', 'titulo_principal') || 'Documento Digitalizado CIESPAL';
  const filename = sanitizeFilename(title) + '.pdf';
  return normalizeBackendRecord({
    id: 'ciespal_' + Date.now().toString(36),
    codigo_control: pickAiText(extracted, 'codigo_control') || pickAiText(extracted, 'clasificacion'),
    isbn: pickAiText(extracted, 'isbn'),
    titulo_principal: title,
    subtitulo: pickAiText(extracted, 'subtitulo'),
    autor_principal: pickAiText(extracted, 'autor_principal', 'autor'),
    colaboradores: pickAiText(extracted, 'colaboradores', 'autores_secundarios'),
    autores_secundarios: pickAiText(extracted, 'colaboradores', 'autores_secundarios'),
    lugar_publicacion: pickAiText(extracted, 'lugar_publicacion'),
    editorial: pickAiText(extracted, 'editorial'),
    anio_publicacion: pickAiText(extracted, 'anio_publicacion', 'anio'),
    numero_paginas: pickAiText(extracted, 'numero_paginas'),
    descripcion_fisica: pickAiText(extracted, 'descripcion_fisica'),
    soporte_fisico: pickAiText(extracted, 'soporte_fisico'),
    dimensiones: pickAiText(extracted, 'dimensiones'),
    notas_fisicas: pickAiText(extracted, 'notas_fisicas'),
    tipo_material: pickAiText(extracted, 'tipo_material') || CIESPAL_KOHA_PROFILE.itemType,
    temas: pickAiText(extracted, 'temas_controlados', 'temas'),
    temas_controlados: pickAiText(extracted, 'temas_controlados', 'temas'),
    palabras_clave: pickAiText(extracted, 'descriptores_libres', 'palabras_clave'),
    descriptores_libres: pickAiText(extracted, 'descriptores_libres', 'palabras_clave'),
    clasificacion: pickAiText(extracted, 'clasificacion'),
    resumen: pickAiText(extracted, 'resumen'),
    tabla_contenidos: pickAiTableOfContents(extracted),
    url_recurso_en_linea: filename,
    enlace_documento: filename
  }, totalPages);
}

function pickAiText(data, ...keys) {
  for (const key of keys) {
    const value = aiValueToText(data?.[key]);
    if (value) return value;
  }
  return '';
}

function pickAiTableOfContents(data) {
  const rawValue = pickAiValue(
    data,
    'tabla_contenidos',
    'tabla_de_contenidos',
    'indice',
    'índice',
    'contenido',
    'contenidos',
    'sumario',
    'table_of_contents',
    'toc'
  );
  return aiTableOfContentsToText(rawValue);
}

function pickAiValue(data, ...keys) {
  for (const key of keys) {
    if (!data || !Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = data[key];
    if (aiValueToText(value)) return value;
  }
  return '';
}

function aiTableOfContentsToText(value) {
  if (value === null || value === undefined) return '';

  if (Array.isArray(value)) {
    return value
      .map(formatTocEntry)
      .filter(Boolean)
      .join('\n');
  }

  if (typeof value === 'object') {
    const nested = pickAiValue(value, 'items', 'capitulos', 'capítulos', 'secciones', 'entries', 'lineas', 'líneas');
    if (nested) return aiTableOfContentsToText(nested);
    const singleEntry = formatTocEntry(value);
    if (singleEntry) return singleEntry;
    return Object.values(value)
      .map(formatTocEntry)
      .filter(Boolean)
      .join('\n');
  }

  return String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\s*\|\s*/g, '\n')
    .trim();
}

function formatTocEntry(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(formatTocEntry).filter(Boolean).join(' - ');
  if (typeof value !== 'object') return String(value).trim();

  const number = aiValueToText(value.numero ?? value.número ?? value.capitulo ?? value.capítulo ?? value.seccion ?? value.sección);
  const title = aiValueToText(value.titulo ?? value.título ?? value.nombre ?? value.tema ?? value.descripcion ?? value.descripción);
  const page = aiValueToText(value.pagina ?? value.página ?? value.pag ?? value.page);
  const pieces = [number, title].filter(Boolean);
  if (page) pieces.push(`p. ${page.replace(/^p\.?\s*/i, '')}`);
  return pieces.join(' - ').trim();
}

function aiValueToText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(aiValueToText).filter(Boolean).join(' | ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function normalizeBackendRecord(record, totalPages) {
  const title = (record.titulo_principal || record.titulo || '').trim() || 'Documento Digitalizado CIESPAL';
  const filename = sanitizeFilename(title) + '.pdf';
  const physical = inferPhysicalParts(record, totalPages);
  const temasControlados = record.temas_controlados || record.temas || '';
  const descriptoresLibres = record.descriptores_libres || record.palabras_clave || '';
  return {
    ...record,
    id: record.id || 'ciespal_' + Date.now().toString(36),
    codigo_control: record.codigo_control || record.clasificacion || '',
    titulo_principal: title,
    autor_principal: record.autor_principal || '',
    colaboradores: record.colaboradores || record.autores_secundarios || '',
    autores_secundarios: record.autores_secundarios || record.colaboradores || '',
    descripcion_fisica: record.descripcion_fisica || physical.extent,
    numero_paginas: record.numero_paginas || physical.extent,
    soporte_fisico: record.soporte_fisico || physical.support,
    dimensiones: record.dimensiones || physical.dimensions,
    tipo_material: normalizeKohaItemType(record.tipo_material),
    temas: temasControlados,
    temas_controlados: temasControlados,
    palabras_clave: descriptoresLibres,
    descriptores_libres: descriptoresLibres,
    url_recurso_en_linea: record.url_recurso_en_linea || record.enlace_documento || filename,
    enlace_documento: record.enlace_documento || record.url_recurso_en_linea || filename
  };
}

function inferPhysicalParts(record = {}, totalPages = 0) {
  const description = String(record.descripcion_fisica || record.numero_paginas || '').trim();
  const fallbackExtent = totalPages ? `${totalPages} p.` : '';
  const extent = String(record.numero_paginas || extractPhysicalExtent(description) || description || fallbackExtent).trim();
  const dimensions = String(record.dimensiones || extractPhysicalDimensions(description)).trim();
  const support = String(record.soporte_fisico || extractPhysicalSupport(description, extent, dimensions)).trim();
  return { extent, support, dimensions };
}

function extractPhysicalExtent(value) {
  const match = String(value || '').match(/\b\d+\s*(?:p\.|p[aá]g\.?|p[aá]gs\.?|p[aá]ginas|pages?)\b/i);
  return match ? match[0].trim() : '';
}

function extractPhysicalDimensions(value) {
  const match = String(value || '').match(/\b\d+(?:[.,]\d+)?\s*cm\b/i);
  return match ? match[0].trim() : '';
}

function extractPhysicalSupport(value, extent, dimensions) {
  let support = String(value || '');
  [extent, dimensions].filter(Boolean).forEach(part => {
    support = support.replace(part, '');
  });
  return support.replace(/\s+/g, ' ').replace(/^[\s.;,-]+|[\s.;,-]+$/g, '').trim();
}

function normalizeKohaItemType(value) {
  const text = String(value || '').trim();
  if (!text || ['texto', 'text', 'libro', 'book'].includes(text.toLowerCase())) {
    return CIESPAL_KOHA_PROFILE.itemType;
  }
  return text;
}

function createFallbackRecord(totalPages) {
  return {
    id: 'ciespal_' + Date.now().toString(36),
    codigo_control: '',
    isbn: '',
    titulo_principal: 'Documento Digitalizado CIESPAL',
    subtitulo: '',
    autor_principal: '',
    colaboradores: '',
    autores_secundarios: '',
    lugar_publicacion: '',
    editorial: '',
    anio_publicacion: '',
    descripcion_fisica: `${totalPages} p.`,
    numero_paginas: `${totalPages} p.`,
    soporte_fisico: '',
    dimensiones: '',
    notas_fisicas: '',
    tipo_material: CIESPAL_KOHA_PROFILE.itemType,
    temas: '',
    temas_controlados: '',
    palabras_clave: '',
    descriptores_libres: '',
    clasificacion: '',
    resumen: '',
    tabla_contenidos: '',
    url_recurso_en_linea: 'Documento_Digitalizado_CIESPAL.pdf',
    enlace_documento: 'Documento_Digitalizado_CIESPAL.pdf'
  };
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
function populateRecordForm(record, totalPages) {
  const resolvedPageCount = totalPages || getRecordPageCount(record);
  document.getElementById('record-id-badge').textContent = `ID: ${record.id}`;
  document.getElementById('field-titulo').value = record.titulo_principal || '';
  document.getElementById('field-subtitulo').value = record.subtitulo || '';
  document.getElementById('field-autor').value = record.autor_principal || '';
  document.getElementById('field-isbn').value = record.isbn || '';
  document.getElementById('field-editorial').value = record.editorial || '';
  document.getElementById('field-lugar').value = record.lugar_publicacion || '';
  document.getElementById('field-anio').value = record.anio_publicacion || '';
  document.getElementById('field-paginas').value = record.numero_paginas || record.descripcion_fisica || (resolvedPageCount ? `${resolvedPageCount} p.` : '');
  document.getElementById('field-soporte-fisico').value = record.soporte_fisico || '';
  document.getElementById('field-dimensiones').value = record.dimensiones || '';
  document.getElementById('field-pdf-url').value = record.url_recurso_en_linea || record.enlace_documento || '';
  document.getElementById('field-notas-fisicas').value = record.notas_fisicas || '';
  document.getElementById('field-tipo-material').value = normalizeKohaItemType(record.tipo_material);
  document.getElementById('field-clasificacion').value = record.clasificacion || '';
  document.getElementById('field-autores-sec').value = record.colaboradores || record.autores_secundarios || '';
  document.getElementById('field-temas-controlados').value = record.temas_controlados || record.temas || '';
  document.getElementById('field-palabras-clave').value = record.descriptores_libres || record.palabras_clave || '';
  document.getElementById('field-resumen').value = record.resumen || '';
  document.getElementById('field-tabla-contenidos').value = record.tabla_contenidos || '';

  const sanitizedPdfName = record.enlace_documento
    || record.url_recurso_en_linea
    || `${sanitizeFilename(record.titulo_principal || 'Documento_Digitalizado')}.pdf`;

  const pdfCard = document.getElementById('pdf-generated-card');
  pdfCard.classList.remove('hidden');
  document.getElementById('pdf-filename-display').textContent = sanitizedPdfName;
  document.getElementById('pdf-pages-display').textContent = `${resolvedPageCount || 0} hojas guardadas`;

  document.getElementById('btn-open-pdf').onclick = () => {
    downloadCompiledPDF(sanitizedPdfName, getRecordPages(record));
  };
}

function collectRecordFromForm(baseRecord = {}) {
  const newTitle = document.getElementById('field-titulo')?.value || '';
  const sanitizedPdfName = sanitizeFilename(newTitle || 'Documento_Digitalizado') + '.pdf';
  const clasificacion = document.getElementById('field-clasificacion')?.value || '';
  const temasControlados = document.getElementById('field-temas-controlados')?.value || '';
  const descriptoresLibres = document.getElementById('field-palabras-clave')?.value || '';

  return {
    ...baseRecord,
    id: baseRecord.id || 'ciespal_' + Date.now().toString(36),
    codigo_control: clasificacion || baseRecord.codigo_control || '',
    titulo_principal: newTitle,
    subtitulo: document.getElementById('field-subtitulo')?.value || '',
    autor_principal: document.getElementById('field-autor')?.value || '',
    isbn: document.getElementById('field-isbn')?.value || '',
    editorial: document.getElementById('field-editorial')?.value || '',
    lugar_publicacion: document.getElementById('field-lugar')?.value || '',
    anio_publicacion: document.getElementById('field-anio')?.value || '',
    descripcion_fisica: document.getElementById('field-paginas')?.value || '',
    numero_paginas: document.getElementById('field-paginas')?.value || '',
    soporte_fisico: document.getElementById('field-soporte-fisico')?.value || '',
    dimensiones: document.getElementById('field-dimensiones')?.value || '',
    url_recurso_en_linea: sanitizedPdfName,
    enlace_documento: sanitizedPdfName,
    notas_fisicas: document.getElementById('field-notas-fisicas')?.value || '',
    tipo_material: normalizeKohaItemType(document.getElementById('field-tipo-material')?.value || 'BK'),
    clasificacion,
    colaboradores: document.getElementById('field-autores-sec')?.value || '',
    autores_secundarios: document.getElementById('field-autores-sec')?.value || '',
    temas: temasControlados,
    temas_controlados: temasControlados,
    palabras_clave: descriptoresLibres,
    descriptores_libres: descriptoresLibres,
    resumen: document.getElementById('field-resumen')?.value || '',
    tabla_contenidos: document.getElementById('field-tabla-contenidos')?.value || ''
  };
}

function onBookScanCompleted(record, totalPages, pagesBase64 = null) {
  const storedRecord = setActiveRecord(attachPagesToRecord(record, totalPages, pagesBase64));
  populateRecordForm(storedRecord, getRecordPageCount(storedRecord));
  updateHomeOverview();
  scheduleDraftSave();

  document.querySelector('[data-target="screen-review"]').click();
}

// ========== NOTIFICACIÓN NATIVA DE DESCARGA EN LA BARRA SUPERIOR DE ANDROID ==========
function triggerAndroidSystemDownload(base64Data, filename, mimeType) {
  if (window.AndroidDownloadManager && window.AndroidDownloadManager.downloadFile) {
    try {
      const result = window.AndroidDownloadManager.downloadFile(base64Data, filename, mimeType);
      const parsed = parseNativeDownloadResult(result);
      if (!parsed || parsed.success) return true;
      console.warn('AndroidDownloadManager falló:', parsed.error);
    } catch (err) {
      console.warn('AndroidDownloadManager no disponible:', err);
    }
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

function parseNativeDownloadResult(result) {
  return parseNativeBridgeResult(result);
}

function parseNativeBridgeResult(result) {
  if (!result) return null;
  if (typeof result === 'object') return result;
  if (typeof result !== 'string') return null;
  try {
    return JSON.parse(result);
  } catch (err) {
    return null;
  }
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
async function downloadCompiledPDF(filename, pagesOverride = null) {
  const pages = Array.isArray(pagesOverride) && pagesOverride.length
    ? pagesOverride
    : getCompiledPdfPages();
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

  const updatedRecord = collectRecordFromForm(state.currentRecord || {});
  const sanitizedPdfName = updatedRecord.enlace_documento || 'Documento_Digitalizado.pdf';

  const storedRecord = setActiveRecord(attachPagesToRecord(updatedRecord, getRecordPageCount(updatedRecord)));

  renderKohaRecordsTable();
  scheduleDraftSave();

  // Guardar y descargar PDF con notificación en la barra de Android
  await downloadCompiledPDF(sanitizedPdfName, getRecordPages(storedRecord));
  document.querySelector('[data-target="screen-export"]').click();
}

// ========== TABLA KOHA ==========
function renderKohaRecordsTable() {
  const tbody = document.getElementById('koha-records-body');
  tbody.innerHTML = '';
  document.getElementById('pending-count').textContent = state.records.length;
  updateHomeOverview();
  renderRecordsStrip();

  if (state.records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:20px;">
      No hay libros guardados. Escanee un libro o cargue un PDF.</td></tr>`;
    return;
  }

  const selected = getActiveExportRecord();
  if (!selected) return;

  const tr = document.createElement('tr');
  appendEditableRecordCell(tr, selected, '020a ISBN', 'isbn', { size: 'medium' });
  appendEditableRecordCell(tr, selected, '245a Título', 'titulo_principal', { size: 'large' });
  appendEditableRecordCell(tr, selected, '100a Autor', 'autor_principal', { size: 'large' });
  appendEditableRecordCell(tr, selected, '260c Año', 'anio_publicacion', { size: 'small' });
  appendEditableRecordCell(tr, selected, '300a Págs', 'numero_paginas', { size: 'small' });
  appendEditableRecordCell(tr, selected, '084a Clasif.', 'clasificacion', { size: 'small' });
  appendEditableRecordCell(tr, selected, '650a Materias', 'temas_controlados', { multiline: true, size: 'large' });
  appendEditableRecordCell(tr, selected, '653a Descriptores', 'descriptores_libres', { multiline: true, size: 'large' });
  appendEditableRecordCell(tr, selected, '856u PDF', 'enlace_documento', { size: 'large' });

  const actionTd = document.createElement('td');
  actionTd.dataset.label = 'Acción';
  actionTd.className = 'table-action-cell';
  const pdfBtn = document.createElement('button');
  pdfBtn.type = 'button';
  pdfBtn.className = 'btn-secondary table-action-btn';
  pdfBtn.textContent = 'PDF';
  pdfBtn.disabled = getRecordPages(selected).length === 0;
  pdfBtn.title = pdfBtn.disabled ? 'Este registro no tiene hojas guardadas' : 'Descargar PDF guardado';
  pdfBtn.addEventListener('click', () => {
    const filename = selected.enlace_documento || selected.url_recurso_en_linea || `${sanitizeFilename(selected.titulo_principal || 'Documento_Digitalizado')}.pdf`;
    downloadCompiledPDF(filename, getRecordPages(selected));
  });
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn-secondary table-action-btn';
  editBtn.textContent = 'Formulario';
  editBtn.addEventListener('click', () => window.editRecord(selected.id));
  actionTd.appendChild(pdfBtn);
  actionTd.appendChild(editBtn);
  tr.appendChild(actionTd);
  tbody.appendChild(tr);
}

function renderRecordsStrip() {
  const strip = document.getElementById('records-strip');
  if (!strip) return;

  strip.innerHTML = '';
  if (!state.records.length) {
    strip.classList.add('hidden');
    return;
  }

  if (!state.activeRecordId || !state.records.some(rec => rec.id === state.activeRecordId)) {
    state.activeRecordId = state.records[0].id;
  }

  strip.classList.remove('hidden');
  state.records.forEach((rec, idx) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `record-chip${rec.id === state.activeRecordId ? ' active' : ''}`;
    button.title = rec.titulo_principal || `Libro ${idx + 1}`;

    const title = document.createElement('span');
    title.className = 'record-chip-title';
    title.textContent = rec.titulo_principal || `Libro ${idx + 1}`;

    const meta = document.createElement('span');
    meta.className = 'record-chip-meta';
    meta.textContent = rec.autor_principal || rec.enlace_documento || 'Sin autor';

    button.appendChild(title);
    button.appendChild(meta);
    button.addEventListener('click', () => {
      state.activeRecordId = rec.id;
      state.currentRecord = rec;
      renderKohaRecordsTable();
      scheduleDraftSave();
    });
    strip.appendChild(button);
  });
}

function getActiveExportRecord() {
  if (!state.records.length) return null;
  let rec = state.records.find(r => r.id === state.activeRecordId);
  if (!rec) {
    rec = state.records[0];
    state.activeRecordId = rec.id;
  }
  state.currentRecord = rec;
  return rec;
}

function appendEditableRecordCell(row, record, label, field, options = {}) {
  const td = document.createElement('td');
  td.dataset.label = label;
  const el = document.createElement(options.multiline ? 'textarea' : 'input');
  if (!options.multiline) el.type = 'text';
  el.className = [
    options.multiline ? 'koha-edit-textarea' : 'koha-edit-input',
    options.size ? `koha-edit-${options.size}` : ''
  ].filter(Boolean).join(' ');
  el.value = getRecordGridValue(record, field);
  el.addEventListener('input', () => updateRecordFieldFromGrid(record.id, field, el.value));
  td.appendChild(el);
  row.appendChild(td);
}

function getRecordGridValue(record, field) {
  if (field === 'temas_controlados') return record.temas_controlados || record.temas || '';
  if (field === 'descriptores_libres') return record.descriptores_libres || record.palabras_clave || '';
  if (field === 'enlace_documento') return record.enlace_documento || record.url_recurso_en_linea || '';
  return record[field] || '';
}

function updateRecordFieldFromGrid(id, field, value) {
  const rec = state.records.find(r => r.id === id);
  if (!rec) return;

  rec[field] = value;
  if (field === 'numero_paginas') rec.descripcion_fisica = value;
  if (field === 'clasificacion') rec.codigo_control = value || rec.codigo_control || '';
  if (field === 'temas_controlados') rec.temas = value;
  if (field === 'descriptores_libres') rec.palabras_clave = value;
  if (field === 'enlace_documento') rec.url_recurso_en_linea = value;

  if (state.currentRecord?.id === id) {
    state.currentRecord = { ...state.currentRecord, ...rec };
    syncVisibleFormField(field, value);
  }

  if (field === 'titulo_principal' || field === 'autor_principal' || field === 'enlace_documento') {
    renderRecordsStrip();
  }

  scheduleDraftSave();
}

function syncVisibleFormField(field, value) {
  const idsByField = {
    isbn: 'field-isbn',
    titulo_principal: 'field-titulo',
    autor_principal: 'field-autor',
    anio_publicacion: 'field-anio',
    numero_paginas: 'field-paginas',
    clasificacion: 'field-clasificacion',
    temas_controlados: 'field-temas-controlados',
    descriptores_libres: 'field-palabras-clave',
    enlace_documento: 'field-pdf-url'
  };
  const input = document.getElementById(idsByField[field]);
  if (input) input.value = value;
}

window.editRecord = function(id) {
  const rec = state.records.find(r => r.id === id);
  if (rec) {
    state.activeRecordId = rec.id;
    state.currentRecord = rec;
    populateRecordForm(rec, getRecordPageCount(rec));
    renderRecordsStrip();
    scheduleDraftSave();
    document.querySelector('[data-target="screen-review"]').click();
  }
};

async function downloadKohaExcel() {
  const record = getActiveExportRecord();
  if (!record) {
    alert('No hay registros para exportar.');
    return;
  }

  const html = buildKohaExcelWorkbook([record]);
  downloadTextFile(html, `${getRecordExportBaseName(record)}_ficha_bibliografica.xls`, 'application/vnd.ms-excel');
}

function buildKohaExcelWorkbook(records) {
  const rows = records
    .flatMap((record, index) => buildBibliographicFichaRows(record, index))
    .filter(Boolean);
  const rowsXml = rows
    .map(row => buildBibliographicFichaRowXml(row))
    .join('');

  return `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
  <Author>CIESPAL</Author>
  <Title>Ficha bibliográfica MARC21</Title>
 </DocumentProperties>
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Color="#17212B"/>
  </Style>
  <Style ss:ID="TitleLabel">
   <Alignment ss:Vertical="Center" ss:WrapText="1"/>
   <Font ss:FontName="Calibri" ss:Size="12" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1D6295" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="TitleValue">
   <Alignment ss:Vertical="Center" ss:WrapText="1"/>
   <Font ss:FontName="Calibri" ss:Size="12" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1D6295" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Section">
   <Alignment ss:Vertical="Center" ss:WrapText="1"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#123B55"/>
   <Interior ss:Color="#E8F2F8" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Field">
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#1D6295"/>
   <Interior ss:Color="#F5F9FC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD8E3"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD8E3"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD8E3"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD8E3"/>
   </Borders>
  </Style>
  <Style ss:ID="Value">
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Color="#17212B"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD8E3"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD8E3"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD8E3"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD8E3"/>
   </Borders>
  </Style>
  <Style ss:ID="Spacer">
   <Font ss:FontName="Calibri" ss:Size="4"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Ficha MARC21">
  <Table ss:ExpandedColumnCount="2" ss:ExpandedRowCount="${rows.length}" x:FullColumns="1" x:FullRows="1" ss:DefaultRowHeight="18">
   <Column ss:AutoFitWidth="0" ss:Width="210"/>
   <Column ss:AutoFitWidth="0" ss:Width="520"/>
${rowsXml}  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <PageSetup>
    <Layout x:Orientation="Portrait"/>
   </PageSetup>
   <Selected/>
   <FreezePanes/>
   <FrozenNoSplit/>
   <SplitHorizontal>1</SplitHorizontal>
   <TopRowBottomPane>1</TopRowBottomPane>
   <ActivePane>2</ActivePane>
  </WorksheetOptions>
 </Worksheet>
</Workbook>`;
}

function buildBibliographicFichaRows(rec, index) {
  const title = rec.titulo_principal || `Registro ${index + 1}`;
  const physical = physicalMarcParts(rec);
  const resourceUrl = rec.url_recurso_en_linea || rec.enlace_documento || '';

  return [
    { type: 'title', label: 'FICHA BIBLIOGRÁFICA MARC21', value: title },
    { type: 'spacer' },
    { type: 'section', label: 'IDENTIFICACIÓN DE LA OBRA' },
    { label: '020a - ISBN', value: rec.isbn },
    { label: '245a - Título', value: rec.titulo_principal },
    { label: '245b - Subtítulo', value: rec.subtitulo },
    { label: '100a - Autor Principal', value: rec.autor_principal },
    { label: '700a - Colaboradores', value: joinMarcValues(rec.colaboradores || rec.autores_secundarios) },
    { type: 'spacer' },
    { type: 'section', label: 'PUBLICACIÓN Y DESCRIPCIÓN FÍSICA' },
    { label: '260a - Lugar de Publicación', value: rec.lugar_publicacion },
    { label: '260b - Editorial', value: rec.editorial },
    { label: '260c - Año de Publicación', value: rec.anio_publicacion },
    { label: '300a - Descripción Física', value: formatPhysicalDescription(physical) },
    { label: '500a - Notas Físicas', value: rec.notas_fisicas },
    { label: 'Naturaleza - Tipo de Material', value: formatMaterialForFicha(rec.tipo_material) },
    { type: 'spacer' },
    { type: 'section', label: 'INDEXACIÓN Y CLASIFICACIÓN' },
    { label: '650a - Temas', value: joinMarcValues(rec.temas_controlados || rec.temas, true) },
    { label: '084a - Clasificación', value: rec.clasificacion },
    { label: '520a - Resumen', value: rec.resumen },
    { type: 'spacer' },
    { type: 'section', label: 'TABLA DE CONTENIDOS' },
    ...buildTableOfContentsFichaRows(rec.tabla_contenidos),
    { type: 'spacer' },
    { type: 'section', label: 'RECURSO DIGITAL KOHA' },
    { label: '856u - Enlace al Documento', value: resourceUrl },
    { type: 'spacer' }
  ];
}

function buildTableOfContentsFichaRows(value) {
  const lines = splitContentLines(value);
  if (!lines.length) return [{ label: '505a - Índice', value: '' }];
  return lines.map((line, index) => ({
    label: index === 0 ? '505a - Índice' : '',
    value: line
  }));
}

function buildBibliographicFichaRowXml(row) {
  if (row.type === 'spacer') {
    return '   <Row ss:AutoFitHeight="0" ss:Height="8"><Cell ss:MergeAcross="1" ss:StyleID="Spacer"><Data ss:Type="String"></Data></Cell></Row>\n';
  }
  if (row.type === 'section') {
    return `   <Row ss:AutoFitHeight="1"><Cell ss:MergeAcross="1" ss:StyleID="Section"><Data ss:Type="String">${excelXmlText(row.label)}</Data></Cell></Row>\n`;
  }
  const labelStyle = row.type === 'title' ? 'TitleLabel' : 'Field';
  const valueStyle = row.type === 'title' ? 'TitleValue' : 'Value';
  return `   <Row ss:AutoFitHeight="1"><Cell ss:StyleID="${labelStyle}"><Data ss:Type="String">${excelXmlText(row.label)}</Data></Cell><Cell ss:StyleID="${valueStyle}"><Data ss:Type="String">${excelXmlText(row.value)}</Data></Cell></Row>\n`;
}

function formatPhysicalDescription(physical) {
  return [physical.extent, physical.support, physical.dimensions]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatMaterialForFicha(value) {
  const normalized = normalizeKohaItemType(value);
  if (normalized === CIESPAL_KOHA_PROFILE.itemType) return 'Texto';
  return value || normalized;
}

function excelXmlText(value) {
  return xmlEscape(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '&#10;');
}

async function downloadKohaMARCXML() {
  const record = getActiveExportRecord();
  if (!record) {
    alert('No hay registros para exportar.');
    return;
  }

  const xml = buildMARCXMLCollection([record]);
  downloadTextFile(xml, `${getRecordExportBaseName(record)}.xml`, 'application/marcxml+xml');
}

function buildMARCXMLCollection(records) {
  const recordsXml = records.map(buildMARCXMLRecord).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<collection xmlns="http://www.loc.gov/MARC21/slim">\n${recordsXml}\n</collection>\n`;
}

function buildMARCXMLRecord(rec) {
  const id = xmlEscape(rec.id || 'ciespal_' + Date.now().toString(36));
  const year = extractYear(rec.anio_publicacion);
  const control008 = buildControl008(year);
  const resourceUrl = rec.url_recurso_en_linea || rec.enlace_documento || '';
  const itemType = normalizeKohaItemType(rec.tipo_material);

  const fields = [
    '  <record>',
    '    <leader>00000nam a2200000 i 4500</leader>',
    `    <controlfield tag="001">${id}</controlfield>`,
    `    <controlfield tag="003">${xmlEscape(buildControl003(rec))}</controlfield>`,
    `    <controlfield tag="005">${buildControl005()}</controlfield>`,
    `    <controlfield tag="008">${xmlEscape(control008)}</controlfield>`,
    datafieldXml('020', [['a', rec.isbn]]),
    datafieldXml('040', [['c', 'CIESPAL.']]),
    datafieldXml('084', [['a', rec.clasificacion]]),
    datafieldXml('100', [['a', rec.autor_principal]], '1', ' '),
    datafieldXml('245', [['a', rec.titulo_principal], ['b', rec.subtitulo]], '1', '0'),
    datafieldXml('260', [['a', rec.lugar_publicacion], ['b', rec.editorial], ['c', rec.anio_publicacion]]),
    datafieldXml('300', physicalMarcSubfields(rec)),
    datafieldXml('500', [['a', rec.notas_fisicas]]),
    ...splitContentLines(rec.tabla_contenidos).map(line => datafieldXml('505', [['a', line]], '0', ' ')),
    datafieldXml('520', [['a', rec.resumen]]),
    ...splitMarcValues(rec.temas_controlados || rec.temas, true).map(subject => datafieldXml('650', [['a', subject]], ' ', '4')),
    ...splitMarcValues(rec.descriptores_libres || rec.palabras_clave, true).map(subject => datafieldXml('653', [['a', subject]])),
    ...splitMarcValues(rec.colaboradores || rec.autores_secundarios).map(person => datafieldXml('700', [['a', person]], '1', ' ')),
    datafieldXml('856', [['y', resourceUrl ? CIESPAL_KOHA_PROFILE.resourceLabel : ''], ['u', resourceUrl]], '4', '0'),
    datafieldXml('942', [['2', CIESPAL_KOHA_PROFILE.classificationSource], ['c', itemType]]),
    CIESPAL_KOHA_PROFILE.includeItemFields
      ? datafieldXml('952', [
          ['a', CIESPAL_KOHA_PROFILE.branchId],
          ['b', CIESPAL_KOHA_PROFILE.branchId],
          ['y', itemType],
          ['o', rec.clasificacion],
          ['u', resourceUrl]
        ])
      : '',
    '  </record>'
  ];

  return fields.filter(Boolean).join('\n');
}

function datafieldXml(tag, subfields, ind1 = ' ', ind2 = ' ') {
  const cleanSubfields = subfields
    .map(([code, value]) => [code, value === null || value === undefined ? '' : String(value).trim()])
    .filter(([, value]) => value.length > 0);
  if (cleanSubfields.length === 0) return '';

  const body = cleanSubfields
    .map(([code, value]) => `      <subfield code="${xmlEscape(code)}">${xmlEscape(value)}</subfield>`)
    .join('\n');
  return `    <datafield tag="${xmlEscape(tag)}" ind1="${xmlEscape(ind1)}" ind2="${xmlEscape(ind2)}">\n${body}\n    </datafield>`;
}

function buildControl005() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds())
  ].join('') + '.0';
}

function buildControl008(year) {
  const now = new Date();
  const entered = String(now.getUTCFullYear()).slice(-2) +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0');
  return `${entered}b${year || '    '}    ec ||||| |||| 00| 0 spa d`;
}

function buildControl003(rec) {
  return String(rec.codigo_control || rec.clasificacion || 'CIESPAL').trim();
}

function physicalMarcParts(rec) {
  const parts = inferPhysicalParts(rec, 0);
  return {
    extent: parts.extent || rec.numero_paginas || rec.descripcion_fisica || '',
    support: parts.support || rec.soporte_fisico || '',
    dimensions: parts.dimensions || rec.dimensiones || ''
  };
}

function physicalMarcSubfields(rec) {
  const physical = physicalMarcParts(rec);
  return [
    ['a', physical.extent],
    ['b', physical.support],
    ['c', physical.dimensions]
  ];
}

function splitContentLines(value) {
  if (!value) return [];
  return String(value)
    .split(/\r?\n|\s*\|\s*/)
    .map(v => v.trim().replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

function extractYear(value) {
  const match = String(value || '').match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return match ? match[1] : '';
}

function splitMarcValues(value, splitCommas = false) {
  if (!value) return [];
  const pattern = splitCommas ? /\s*[|;,]\s*/ : /\s*[|;]\s*/;
  return String(value).split(pattern).map(v => v.trim()).filter(Boolean);
}

function joinMarcValues(value, splitCommas = false) {
  return splitMarcValues(value, splitCommas).join(' | ');
}

function getExportBaseName(record = null) {
  return getRecordExportBaseName(record || getActiveExportRecord());
}

function getRecordExportBaseName(record = null) {
  const raw = record?.titulo_principal
    || record?.enlace_documento
    || record?.url_recurso_en_linea
    || 'Documento_CIESPAL';
  return sanitizeFilename(String(raw).replace(/\.[a-z0-9]+$/i, ''));
}

function downloadTextFile(content, filename, mimeType) {
  const utf8Bytes = new TextEncoder().encode(content);
  let binary = '';
  for (let i = 0; i < utf8Bytes.byteLength; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  triggerAndroidSystemDownload(btoa(binary), filename, mimeType);
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
