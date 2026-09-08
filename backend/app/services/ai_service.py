import base64
import io
import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests
from PIL import Image, ImageOps

from app.schemas.marc21 import MARC21Record

try:
    from dotenv import load_dotenv

    ENV_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".env"))
    load_dotenv(ENV_PATH)
except Exception:
    pass


class AIService:
    """
    Servicio de extracción bibliográfica con DeepSeek.
    Usa visión cuando recibe imágenes y conserva un fallback local para demos sin API key.
    """

    def __init__(self):
        self.api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
        self.api_url = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions").strip()
        self.vision_model = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash-vision-exp").strip()
        self.text_model = os.getenv("DEEPSEEK_TEXT_MODEL", "deepseek-v4-flash").strip()
        self.max_pages = self._get_int_env("DEEPSEEK_MAX_PAGES", 80)

    def _get_int_env(self, name: str, default: int) -> int:
        try:
            return int(os.getenv(name, str(default)))
        except ValueError:
            return default

    def parse_marc21_metadata(
        self,
        raw_text: str = "",
        image_url: str = "",
        image_bytes_list: Optional[List[bytes]] = None,
    ) -> MARC21Record:
        """Extrae campos MARC21/Koha desde páginas escaneadas o texto OCR."""
        if self.api_key and image_bytes_list:
            try:
                extracted = self._parse_images_with_deepseek(image_bytes_list, raw_text=raw_text)
                return self._record_from_extracted(extracted, total_pages=len(image_bytes_list), image_url=image_url)
            except Exception as exc:
                print(f"DeepSeek vision no disponible, usando fallback OCR: {exc}")

        if self.api_key and raw_text.strip():
            try:
                extracted = self._parse_text_with_deepseek(raw_text)
                return self._record_from_extracted(extracted, image_url=image_url)
            except Exception as exc:
                print(f"DeepSeek texto no disponible, usando regex local: {exc}")

        return self._regex_fallback_record(raw_text, image_url=image_url)

    def _parse_images_with_deepseek(self, image_bytes_list: List[bytes], raw_text: str = "") -> Dict[str, Any]:
        selected_images = image_bytes_list[: self.max_pages]
        parts: List[Dict[str, Any]] = [{"type": "text", "text": self._extraction_prompt(len(image_bytes_list))}]

        for img_bytes in selected_images:
            parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": self._image_bytes_to_data_url(img_bytes),
                        "detail": "high",
                    },
                }
            )

        if len(image_bytes_list) > len(selected_images):
            parts.append(
                {
                    "type": "text",
                    "text": (
                        f"Nota: se recibieron {len(image_bytes_list)} páginas, pero se enviaron "
                        f"{len(selected_images)} por límite de configuración. No inventes datos de páginas no vistas."
                    ),
                }
            )

        if raw_text.strip():
            parts.append(
                {
                    "type": "text",
                    "text": (
                        "Texto OCR de apoyo. Puede contener errores; úsalo solo si coincide con lo visible "
                        f"en las imágenes y deja vacío cualquier dato dudoso:\n{raw_text[:6000]}"
                    ),
                }
            )

        messages = [
            {
                "role": "system",
                "content": "Eres un catalogador experto MARC21 para una mediateca. Responde solo JSON válido.",
            },
            {"role": "user", "content": parts},
        ]
        return self._call_deepseek(messages, model=self.vision_model)

    def _parse_text_with_deepseek(self, raw_text: str) -> Dict[str, Any]:
        messages = [
            {
                "role": "system",
                "content": "Eres un catalogador experto MARC21 para una mediateca. Responde solo JSON válido.",
            },
            {"role": "user", "content": f"{self._extraction_prompt(0)}\n\nTexto OCR:\n{raw_text}"},
        ]
        return self._call_deepseek(messages, model=self.text_model)

    def _call_deepseek(self, messages: List[Dict[str, Any]], model: str) -> Dict[str, Any]:
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0,
            "max_tokens": 8192,
            "response_format": {"type": "json_object"},
            "thinking": {"type": "disabled"},
        }

        response = requests.post(
            self.api_url,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=180,
        )

        if not response.ok:
            try:
                detail = response.json().get("error", {}).get("message", response.text)
            except Exception:
                detail = response.text
            raise RuntimeError(f"DeepSeek {response.status_code}: {detail[:500]}")

        data = response.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return self._extract_json(content)

    def _image_bytes_to_data_url(self, image_bytes: bytes) -> str:
        img = Image.open(io.BytesIO(image_bytes))
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA", "P"):
            rgba = img.convert("RGBA")
            background = Image.new("RGB", rgba.size, (255, 255, 255))
            background.paste(rgba, mask=rgba.split()[-1])
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")

        img.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        img.save(output, format="JPEG", quality=78, optimize=True)
        b64 = base64.b64encode(output.getvalue()).decode("utf-8")
        return f"data:image/jpeg;base64,{b64}"

    def _extract_json(self, text: str) -> Dict[str, Any]:
        cleaned = (text or "").strip()
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```\s*$", "", cleaned)
        try:
            parsed = json.loads(cleaned)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            match = re.search(r"\{[\s\S]*\}", cleaned)
            if match:
                parsed = json.loads(match.group(0))
                return parsed if isinstance(parsed, dict) else {}
        return {}

    def _extraction_prompt(self, total_pages: int) -> str:
        page_text = f"Se proporcionan {total_pages} páginas escaneadas." if total_pages else "Se proporciona texto OCR."
        return f"""
Eres un bibliotecario experto en catalogación MARC21/Koha para la Mediateca CIESPAL. {page_text}

Extrae metadatos bibliográficos reales usando solo texto visible en las imágenes o en el OCR de apoyo. Si un dato no aparece claramente, deja el campo vacío. No inventes ISBN, editorial, autores, año, capítulos, clasificación ni materias por contexto.

Perfil Koha observado para CIESPAL:
- Clasificación/signatura local: 084 $a. No uses 090 salvo que el catalogador lo pida después.
- Publicación: 260 $a, 260 $b, 260 $c.
- Descripción física: separa extensión 300 $a, soporte/detalle 300 $b y dimensiones 300 $c.
- Materias controladas: 650 $a solo si aparecen explícitas o son muy evidentes.
- Descriptores libres: 653 $a para palabras clave sugeridas por IA.
- Recurso digital: 856 $y debe decir "Recuperar PDF" y 856 $u debe contener la URL del PDF.
- Tipo local Koha para libros: 942 $c = "BK".

REGLAS PARA tabla_contenidos:
1. Busca páginas tituladas "ÍNDICE", "INDICE", "CONTENIDO", "TABLA DE CONTENIDOS", "SUMARIO", "INDEX" o "TABLE OF CONTENTS".
2. Si existe índice, transcríbelo exactamente línea por línea.
3. Si no existe índice visible, resume solo títulos o secciones visibles; si no hay base suficiente, deja vacío.

Devuelve SOLO JSON válido con esta forma:
{{
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
}}
""".strip()

    def _record_from_extracted(
        self,
        extracted: Dict[str, Any],
        total_pages: int = 0,
        image_url: str = "",
    ) -> MARC21Record:
        titulo = self._pick(extracted, "titulo", "titulo_principal") or "Documento Digitalizado CIESPAL"
        autor = self._pick(extracted, "autor_principal", "autor")
        colaboradores = self._pick(extracted, "colaboradores", "autores_secundarios")
        numero_paginas = self._pick(extracted, "numero_paginas")
        descripcion = self._pick(extracted, "descripcion_fisica") or numero_paginas
        if not numero_paginas and total_pages:
            numero_paginas = f"{total_pages} p."
        if not descripcion:
            descripcion = numero_paginas
        soporte_fisico = self._pick(extracted, "soporte_fisico", "detalle_fisico")
        dimensiones = self._pick(extracted, "dimensiones")
        temas_controlados = self._pick(extracted, "temas_controlados", "temas")
        descriptores_libres = self._pick(extracted, "descriptores_libres", "palabras_clave", "keywords")
        enlace = self._pick(extracted, "url_recurso_en_linea", "enlace_documento")
        tipo_material = (
            self._pick(extracted, "tipo_material")
            or os.getenv("KOHA_DEFAULT_ITEM_TYPE", "BK").strip()
            or "BK"
        )

        return MARC21Record(
            id=str(uuid.uuid4())[:8],
            codigo_control=self._pick(extracted, "codigo_control") or self._pick(extracted, "clasificacion"),
            isbn=self._pick(extracted, "isbn"),
            titulo_principal=titulo,
            subtitulo=self._pick(extracted, "subtitulo"),
            autor_principal=autor,
            autores_secundarios=colaboradores,
            colaboradores=colaboradores,
            lugar_publicacion=self._pick(extracted, "lugar_publicacion"),
            editorial=self._pick(extracted, "editorial"),
            anio_publicacion=self._pick(extracted, "anio_publicacion", "anio"),
            numero_paginas=numero_paginas,
            descripcion_fisica=descripcion,
            soporte_fisico=soporte_fisico,
            dimensiones=dimensiones,
            notas_fisicas=self._pick(extracted, "notas_fisicas"),
            tipo_material=tipo_material,
            palabras_clave=descriptores_libres or temas_controlados,
            temas=temas_controlados,
            temas_controlados=temas_controlados,
            descriptores_libres=descriptores_libres,
            clasificacion=self._pick(extracted, "clasificacion"),
            resumen=self._pick(extracted, "resumen"),
            tabla_contenidos=self._pick(extracted, "tabla_contenidos"),
            enlace_documento=enlace,
            url_recurso_en_linea=enlace,
            imagen_portada=image_url,
            fecha_creacion=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )

    def _pick(self, data: Dict[str, Any], *keys: str) -> str:
        for key in keys:
            value = data.get(key)
            text = self._to_text(value)
            if text:
                return text
        return ""

    def _to_text(self, value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, list):
            return " | ".join(self._to_text(item) for item in value if self._to_text(item))
        if isinstance(value, dict):
            return json.dumps(value, ensure_ascii=False)
        return str(value).strip()

    def _regex_fallback_record(self, raw_text: str, image_url: str = "") -> MARC21Record:
        """Fallback de baja confianza para que la app siga funcionando sin DeepSeek."""
        raw_text = raw_text or ""

        isbn_match = re.search(r"(?:ISBN(?:-13|-10)?:?\s*)([0-9Xx\-]{10,17})", raw_text, re.IGNORECASE)
        if not isbn_match:
            isbn_match = re.search(r"([0-9]{3}-[0-9]{1,5}-[0-9]{1,7}-[0-9]{1,7}-[0-9Xx])", raw_text)
        isbn = isbn_match.group(1).strip() if isbn_match else ""

        titulo = "Documento Digitalizado CIESPAL"
        lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
        excluded = ["isbn", "autor", "edición", "edicion", "copyright", "derechos", "páginas", "paginas", "quito"]
        for line in lines:
            if len(line) > 8 and not any(word in line.lower() for word in excluded):
                titulo = line
                break

        autor = ""
        autor_match = re.search(r"Autor(?:es)?:?\s*([^\n]+)", raw_text, re.IGNORECASE)
        if autor_match:
            raw_autor = autor_match.group(1).strip()
            autor = re.split(r"\s+(?:&|y)\s+", raw_autor)[0].strip()

        lugar = ""
        lugar_match = re.search(
            r"(Quito|Guayaquil|Cuenca|Bogotá|Bogota|Lima|Madrid|México|Mexico),?\s*(Ecuador|Colombia|Perú|Peru|España|Mexico|México)?",
            raw_text,
            re.IGNORECASE,
        )
        if lugar_match:
            lugar = lugar_match.group(0).strip()

        editorial = ""
        ed_match = re.search(r"(?:Edici[oó]n|Editorial):?\s*([^\n]+)", raw_text, re.IGNORECASE)
        if ed_match:
            editorial = ed_match.group(1).strip()

        anio = ""
        anio_match = re.search(r"\b(19[0-9]\d|20[0-9]\d)\b", raw_text)
        if anio_match:
            anio = anio_match.group(1)

        paginas = ""
        pag_match = re.search(r"(\d+)\s*(?:págs?\.?|pags?\.?|páginas|paginas|p\.)", raw_text, re.IGNORECASE)
        if pag_match:
            paginas = f"{pag_match.group(1)} p."

        return MARC21Record(
            id=str(uuid.uuid4())[:8],
            codigo_control="",
            isbn=isbn,
            titulo_principal=titulo,
            subtitulo="",
            autor_principal=autor,
            autores_secundarios="",
            colaboradores="",
            lugar_publicacion=lugar,
            editorial=editorial,
            anio_publicacion=anio,
            numero_paginas=paginas,
            descripcion_fisica=paginas,
            soporte_fisico="",
            dimensiones="",
            notas_fisicas="",
            tipo_material=os.getenv("KOHA_DEFAULT_ITEM_TYPE", "BK").strip() or "BK",
            palabras_clave="",
            temas="",
            temas_controlados="",
            descriptores_libres="",
            clasificacion="",
            resumen="",
            tabla_contenidos="",
            enlace_documento="",
            url_recurso_en_linea="",
            imagen_portada=image_url,
            fecha_creacion=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


ai_service = AIService()
