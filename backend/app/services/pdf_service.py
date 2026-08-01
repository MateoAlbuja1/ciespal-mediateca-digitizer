import os
import re
import io
from typing import List
from PIL import Image

class PDFService:
    """
    Servicio de Ensamblaje de PDF Multipágina y Nombramiento Autogenerado
    Compila lotes de imágenes (hasta 70+ páginas) en un único archivo PDF
    y lo nombra con el título extraído de la obra (MARC 245 $a).
    """
    
    def sanitize_filename(self, title: str) -> str:
        """Limpia el título del libro para convertirlo en un nombre de archivo válido."""
        if not title or len(title.strip()) == 0:
            title = "Documento_Digitalizado_CIESPAL"
            
        # Reemplazar caracteres no permitidos en nombres de archivo
        sanitized = re.sub(r'[\\/*?:"<>|]', '', title)
        # Reemplazar espacios múltiples por guiones bajos
        sanitized = re.sub(r'\s+', '_', sanitized.strip())
        # Limitar longitud para evitar rutas demasiado largas
        return sanitized[:80]

    def create_pdf_from_images(self, image_bytes_list: List[bytes], book_title: str, output_dir: str) -> dict:
        """
        Convierte una lista de imágenes (de 1 a 70+ páginas) en un único PDF.
        Retorna la ruta y el nombre final del archivo generado.
        """
        os.makedirs(output_dir, exist_ok=True)
        
        # Generar nombre del PDF basado en el título del libro
        clean_title = self.sanitize_filename(book_title)
        filename = f"{clean_title}.pdf"
        filepath = os.path.join(output_dir, filename)

        # Si no hay imágenes, crear un PDF vacío estructurado
        if not image_bytes_list:
            # Fallback seguro
            img = Image.new('RGB', (1240, 1754), color=(255, 255, 255))
            img.save(filepath, "PDF", resolution=100.0)
            return {
                "filename": filename,
                "filepath": filepath,
                "total_pages": 1
            }

        pil_images = []
        for img_bytes in image_bytes_list:
            try:
                img = Image.open(io.BytesIO(img_bytes))
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                pil_images.append(img)
            except Exception as e:
                print(f"Error procesando imagen para PDF: {e}")

        if not pil_images:
            img = Image.new('RGB', (1240, 1754), color=(255, 255, 255))
            pil_images.append(img)

        # Guardar la primera imagen y anexar el resto (hasta 70+ páginas) como un único PDF
        first_img = pil_images[0]
        rest_imgs = pil_images[1:] if len(pil_images) > 1 else []
        
        first_img.save(
            filepath,
            "PDF",
            resolution=150.0,
            save_all=True,
            append_images=rest_imgs
        )

        return {
            "filename": filename,
            "filepath": filepath,
            "total_pages": len(pil_images)
        }

pdf_service = PDFService()
