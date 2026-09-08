from pydantic import BaseModel, Field
from typing import Optional

class MARC21Record(BaseModel):
    id: Optional[str] = Field(default=None, description="Identificador único del registro")
    codigo_control: Optional[str] = Field(default="", description="003 - Código local observado en Koha CIESPAL")
    isbn: Optional[str] = Field(default="", description="020 $a / 022 $a - ISBN, ISSN o DOI")
    titulo_principal: str = Field(..., description="245 $a - Título exacto de la obra")
    subtitulo: Optional[str] = Field(default="", description="245 $b - Subtítulo o información secundaria")
    autor_principal: str = Field(..., description="100 $a - Apellidos, Nombres del autor principal")
    autores_secundarios: Optional[str] = Field(default="", description="700 $a - Coautores, editores, traductores")
    colaboradores: Optional[str] = Field(default="", description="700 $a - Alias frontend para colaboradores")
    lugar_publicacion: Optional[str] = Field(default="", description="260 $a - Ciudad / País")
    editorial: Optional[str] = Field(default="", description="260 $b - Entidad responsable / Editorial")
    anio_publicacion: Optional[str] = Field(default="", description="260 $c - Fecha / Año de edición")
    numero_paginas: Optional[str] = Field(default="", description="300 $a - Extensión física total (ej. 248 p.)")
    descripcion_fisica: Optional[str] = Field(default="", description="300 $a - Alias frontend para descripción física")
    soporte_fisico: Optional[str] = Field(default="", description="300 $b - Soporte o detalle físico (ej. Libro rústico)")
    dimensiones: Optional[str] = Field(default="", description="300 $c - Dimensiones (ej. 27 cm)")
    notas_fisicas: Optional[str] = Field(default="", description="500 $a - Notas físicas o del ejemplar")
    tipo_material: Optional[str] = Field(default="BK", description="942 $c - Tipo de material local Koha")
    palabras_clave: Optional[str] = Field(default="", description="653 $a - Descriptores libres separados por comas o barras")
    temas: Optional[str] = Field(default="", description="650 $a - Materias controladas visibles en Koha")
    temas_controlados: Optional[str] = Field(default="", description="650 $a - Alias explícito para materias controladas")
    descriptores_libres: Optional[str] = Field(default="", description="653 $a - Palabras clave no controladas")
    clasificacion: Optional[str] = Field(default="", description="084 $a - Signatura o clasificación local")
    resumen: Optional[str] = Field(default="", description="520 $a - Síntesis generada por la IA (Abstract)")
    tabla_contenidos: Optional[str] = Field(default="", description="505 $a - Índice o tabla de contenidos")
    enlace_documento: Optional[str] = Field(default="", description="856 $u - URL o ruta del PDF digitalizado")
    url_recurso_en_linea: Optional[str] = Field(default="", description="856 $u - Alias frontend para URL del recurso")
    imagen_portada: Optional[str] = Field(default="", description="URL o base64 de la portada escaneada")
    fecha_creacion: Optional[str] = Field(default=None)

class ProcessImageResponse(BaseModel):
    success: bool
    message: str
    record: MARC21Record
    raw_ocr_text: str
    confidence_score: float
