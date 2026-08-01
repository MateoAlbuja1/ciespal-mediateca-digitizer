from pydantic import BaseModel, Field
from typing import Optional

class MARC21Record(BaseModel):
    id: Optional[str] = Field(default=None, description="Identificador único del registro")
    isbn: Optional[str] = Field(default="", description="020 $a / 022 $a - ISBN, ISSN o DOI")
    titulo_principal: str = Field(..., description="245 $a - Título exacto de la obra")
    subtitulo: Optional[str] = Field(default="", description="245 $b - Subtítulo o información secundaria")
    autor_principal: str = Field(..., description="100 $a - Apellidos, Nombres del autor principal")
    autores_secundarios: Optional[str] = Field(default="", description="700 $a - Coautores, editores, traductores")
    lugar_publicacion: Optional[str] = Field(default="", description="264 $a / 260 $a - Ciudad / País")
    editorial: Optional[str] = Field(default="", description="264 $b / 260 $b - Entidad responsable / Editorial")
    anio_publicacion: Optional[str] = Field(default="", description="264 $c / 260 $c - Fecha / Año de edición")
    numero_paginas: Optional[str] = Field(default="", description="300 $a - Extensión física total (ej. 248 p.)")
    palabras_clave: Optional[str] = Field(default="", description="650 $a - Descriptores temáticos separados por comas")
    resumen: Optional[str] = Field(default="", description="520 $a - Síntesis generada por la IA (Abstract)")
    enlace_documento: Optional[str] = Field(default="", description="856 $u - URL o ruta del PDF digitalizado")
    imagen_portada: Optional[str] = Field(default="", description="URL o base64 de la portada escaneada")
    fecha_creacion: Optional[str] = Field(default=None)

class ProcessImageResponse(BaseModel):
    success: bool
    message: str
    record: MARC21Record
    raw_ocr_text: str
    confidence_score: float
