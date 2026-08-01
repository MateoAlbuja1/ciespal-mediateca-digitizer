import csv
import io
from typing import List
from app.schemas.marc21 import MARC21Record

class MARC21Exporter:
    """
    Servicio de Exportación a Koha (MARC21 / ISBD)
    Genera el archivo CSV estructurado listo para la herramienta de importación masiva de Koha.
    """
    
    # Encabezados estandarizados MARC21 para Koha
    KOHA_MARC21_HEADERS = [
        "020a",  # ISBN / Identificador
        "100a",  # Autor Principal
        "245a",  # Título Principal
        "245b",  # Subtítulo
        "700a",  # Autores Secundarios
        "264a",  # Lugar de Publicación
        "264b",  # Editorial
        "264c",  # Año de Publicación
        "300a",  # Extensión física / Páginas
        "520a",  # Resumen / Abstract
        "650a",  # Palabras Clave / Descriptores
        "856u"   # Enlace al documento PDF
    ]

    def generate_koha_csv(self, records: List[MARC21Record]) -> str:
        """Genera el contenido de un archivo CSV compatible con Koha ILS."""
        output = io.StringIO()
        writer = csv.writer(output, quoting=csv.QUOTE_MINIMAL)
        
        # Escribir encabezados MARC21
        writer.writerow(self.KOHA_MARC21_HEADERS)
        
        # Escribir registros
        for rec in records:
            writer.writerow([
                rec.isbn or "",
                rec.autor_principal or "",
                rec.titulo_principal or "",
                rec.subtitulo or "",
                rec.autores_secundarios or "",
                rec.lugar_publicacion or "",
                rec.editorial or "",
                rec.anio_publicacion or "",
                rec.numero_paginas or "",
                rec.resumen or "",
                rec.palabras_clave or "",
                rec.enlace_documento or ""
            ])
            
        return output.getvalue()

marc21_exporter = MARC21Exporter()
