import os
import uuid
from typing import List
from fastapi import APIRouter, UploadFile, File, HTTPException, Response, Form
from fastapi.responses import FileResponse

from app.schemas.marc21 import MARC21Record, ProcessImageResponse
from app.services.ocr_service import ocr_service
from app.services.ai_service import ai_service
from app.services.marc21_service import marc21_exporter
from app.services.pdf_service import pdf_service

router = APIRouter(prefix="/api/v1")

# Base de datos en memoria
db_records: List[MARC21Record] = [
    MARC21Record(
        id="c1a2b3",
        codigo_control="CIESPAL",
        isbn="978-9978-55-214-8",
        titulo_principal="Medios Masivos y Sociedad en América Latina",
        subtitulo="Transformaciones y Desafíos de la Comunicación Popular",
        autor_principal="Benavides, Gabriel",
        autores_secundarios="Restrepo, María Paula",
        lugar_publicacion="Quito, Ecuador",
        editorial="CIESPAL Editorial",
        anio_publicacion="2023",
        numero_paginas="342 p.",
        soporte_fisico="Libro digitalizado",
        dimensiones="27 cm",
        tipo_material="BK",
        descriptores_libres="Comunicación, Medios, Ecuador, CIESPAL, Periodismo",
        resumen="Estudio crítico sobre las políticas de comunicación en la región andina y la digitalización del archivo histórico.",
        enlace_documento="http://localhost:8000/uploads/pdfs/Medios_Masivos_y_Sociedad_en_América_Latina.pdf",
        fecha_creacion="2026-08-01 10:15:00"
    )
]

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "uploads")
PDF_DIR = os.path.join(UPLOAD_DIR, "pdfs")
os.makedirs(PDF_DIR, exist_ok=True)

@router.post("/scan-multipage", response_model=ProcessImageResponse)
async def scan_multipage_document(files: List[UploadFile] = File(...)):
    """
    Endpoint para recibir de 1 a 70+ imágenes pertenecientes a un mismo libro.
    1. Ejecuta OCR + IA sobre la portada y derechos (primeras fotos).
    2. Ensambla un único archivo PDF con todas las 70+ páginas.
    3. Nombra automáticamente el PDF con el título exacto del libro (MARC 245a).
    4. Vincula la URL del PDF en el campo MARC 856 $u.
    """
    if not files:
        raise HTTPException(status_code=400, detail="Debe subir al menos una imagen.")

    image_bytes_list = []
    for f in files:
        contents = await f.read()
        image_bytes_list.append(contents)

    # 1. Ejecutar OCR sobre la portada como respaldo y texto de diagnóstico
    portada_bytes = image_bytes_list[0]
    ocr_text = ocr_service.extract_text(portada_bytes)

    # 2. Generar metadatos MARC21 con DeepSeek Vision desde las páginas recibidas
    record = ai_service.parse_marc21_metadata(
        raw_text=ocr_text,
        image_bytes_list=image_bytes_list
    )
    
    # Actualizar número de páginas con el recuento real si se escanearon múltiples fotos
    if len(files) > 1 and not record.numero_paginas:
        record.numero_paginas = f"{len(files)} p."
    if not record.descripcion_fisica:
        record.descripcion_fisica = record.numero_paginas or f"{len(files)} p."

    # 3. Compilar todas las 70+ fotos en un único PDF nombrado con el título del libro
    pdf_info = pdf_service.create_pdf_from_images(
        image_bytes_list=image_bytes_list,
        book_title=record.titulo_principal,
        output_dir=PDF_DIR
    )

    # 4. Asignar el enlace al documento PDF en MARC21 856 $u
    pdf_filename = pdf_info["filename"]
    public_base_url = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
    record.enlace_documento = f"{public_base_url}/uploads/pdfs/{pdf_filename}"
    record.url_recurso_en_linea = record.enlace_documento
    
    db_records.append(record)

    return ProcessImageResponse(
        success=True,
        message=f"Se compilaron {pdf_info['total_pages']} páginas en un PDF nombrado '{pdf_filename}'.",
        record=record,
        raw_ocr_text=ocr_text,
        confidence_score=0.98
    )

@router.post("/scan", response_model=ProcessImageResponse)
async def scan_document_image(file: UploadFile = File(...)):
    """Escaneo simple de 1 imagen."""
    return await scan_multipage_document(files=[file])

@router.get("/records", response_model=List[MARC21Record])
def get_all_records():
    return db_records

@router.post("/records", response_model=MARC21Record)
def save_or_update_record(record: MARC21Record):
    for idx, existing in enumerate(db_records):
        if existing.id == record.id:
            db_records[idx] = record
            return record
    db_records.append(record)
    return record

@router.get("/export/csv")
def export_koha_csv():
    csv_content = marc21_exporter.generate_koha_csv(db_records)
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=ciespal_koha_marc21_export.csv"
        }
    )

@router.get("/export/marcxml")
def export_koha_marcxml():
    marcxml_content = marc21_exporter.generate_marcxml(db_records)
    return Response(
        content=marcxml_content,
        media_type="application/marcxml+xml",
        headers={
            "Content-Disposition": "attachment; filename=ciespal_koha_marc21_export.xml"
        }
    )

@router.get("/download/pdf/{filename}")
def download_compiled_pdf(filename: str):
    filepath = os.path.join(PDF_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Archivo PDF no encontrado.")
    return FileResponse(filepath, media_type="application/pdf", filename=filename)
