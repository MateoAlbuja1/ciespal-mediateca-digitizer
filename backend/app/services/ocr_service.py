import io
import re
from PIL import Image, ImageEnhance, ImageFilter

class OCRService:
    """
    Servicio de Reconocimiento Óptico de Caracteres (OCR)
    Aplica preprocesamiento de imágenes (escala de grises, umbralización y nitidez)
    y extracción de texto para páginas de portadas y derechos.
    """
    def __init__(self):
        self.tesseract_available = False
        try:
            import pytesseract
            self.tesseract_available = True
            self.pytesseract = pytesseract
        except ImportError:
            self.tesseract_available = False

    def preprocess_image(self, image_bytes: bytes) -> Image.Image:
        """Mejora la legibilidad de la imagen para maximizar la tasa de acierto del OCR."""
        img = Image.open(io.BytesIO(image_bytes))
        
        # 1. Convertir a escala de grises
        img = img.convert('L')
        
        # 2. Aumentar el contraste
        enhancer = ImageEnhance.Contrast(img)
        img = enhancer.enhance(1.8)
        
        # 3. Aumentar nitidez
        img = img.filter(ImageFilter.SHARPEN)
        
        return img

    def extract_text(self, image_bytes: bytes) -> str:
        """Extrae el texto bruto utilizando Tesseract OCR o fallback inteligente."""
        try:
            processed_img = self.preprocess_image(image_bytes)
            
            if self.tesseract_available:
                # Usar Tesseract en español e inglés
                text = self.pytesseract.image_to_string(processed_img, lang='spa+eng')
                if text and len(text.strip()) > 10:
                    return text.strip()

            # Sin binario de Tesseract no hay OCR real; DeepSeek Vision seguirá usando la imagen.
            return self._intelligent_fallback_ocr(image_bytes)
        except Exception as e:
            return self._intelligent_fallback_ocr(image_bytes)

    def _intelligent_fallback_ocr(self, image_bytes: bytes) -> str:
        """Fallback seguro: no devuelve datos de ejemplo para evitar registros falsos."""
        return ""

ocr_service = OCRService()
