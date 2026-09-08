import csv
import io
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Iterable, List

from app.schemas.marc21 import MARC21Record

MARC_NS = "http://www.loc.gov/MARC21/slim"
ET.register_namespace("", MARC_NS)


class MARC21Exporter:
    """
    Exporta registros CIESPAL a una tabla CSV de revisión y a MARCXML para Koha.
    Koha importa bibliográficos por API/lote como registros MARC, no como CSV plano.
    """

    KOHA_MARC21_HEADERS = [
        "001",
        "003",
        "020$a",
        "040$c",
        "084$a",
        "100$a",
        "245$a",
        "245$b",
        "700$a",
        "260$a",
        "260$b",
        "260$c",
        "300$a",
        "300$b",
        "300$c",
        "500$a",
        "505$a",
        "520$a",
        "650$a",
        "653$a",
        "856$y",
        "856$u",
        "942$2",
        "942$c",
        "952$a",
        "952$b",
        "952$y",
        "952$o",
        "952$u",
    ]

    def generate_koha_csv(self, records: List[MARC21Record]) -> str:
        """Genera CSV UTF-8 para revisión humana o conversión posterior a MARC."""
        output = io.StringIO()
        writer = csv.writer(output, quoting=csv.QUOTE_MINIMAL)
        writer.writerow(self.KOHA_MARC21_HEADERS)

        for rec in records:
            physical = self._physical_subfields(rec)
            item_type = self._item_type(rec)
            resource_url = rec.url_recurso_en_linea or rec.enlace_documento or ""
            writer.writerow(
                [
                    rec.id or "",
                    self._control_003(rec),
                    rec.isbn or "",
                    "CIESPAL.",
                    rec.clasificacion or "",
                    rec.autor_principal or "",
                    rec.titulo_principal or "",
                    rec.subtitulo or "",
                    self._join_values(rec.colaboradores or rec.autores_secundarios),
                    rec.lugar_publicacion or "",
                    rec.editorial or "",
                    rec.anio_publicacion or "",
                    self._physical_value(physical, "a"),
                    self._physical_value(physical, "b"),
                    self._physical_value(physical, "c"),
                    rec.notas_fisicas or "",
                    rec.tabla_contenidos or "",
                    rec.resumen or "",
                    self._join_values(rec.temas_controlados or rec.temas, split_commas=True),
                    self._join_values(rec.descriptores_libres or rec.palabras_clave, split_commas=True),
                    "Recuperar PDF" if resource_url else "",
                    resource_url,
                    self._classification_source(),
                    item_type,
                    self._home_branch(),
                    self._holding_branch(),
                    item_type,
                    rec.clasificacion or "",
                    resource_url,
                ]
            )

        return output.getvalue()

    def generate_marcxml(self, records: List[MARC21Record]) -> str:
        """Genera colección MARCXML lista para Stage MARC records o API de Koha."""
        collection = ET.Element(self._tag("collection"))
        for rec in records:
            collection.append(self._record_to_marcxml(rec))

        xml_bytes = ET.tostring(collection, encoding="utf-8", xml_declaration=True)
        return xml_bytes.decode("utf-8")

    def _record_to_marcxml(self, rec: MARC21Record) -> ET.Element:
        record = ET.Element(self._tag("record"))
        self._control(record, "leader", "00000nam a2200000 i 4500", is_leader=True)
        self._control(record, "001", rec.id or "")
        self._control(record, "003", self._control_003(rec))
        self._control(record, "005", datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S.0"))
        self._control(record, "008", self._control_008(rec.anio_publicacion))

        self._field(record, "020", [("a", rec.isbn)])
        self._field(record, "040", [("c", "CIESPAL.")])
        self._field(record, "084", [("a", rec.clasificacion)])
        self._field(record, "100", [("a", rec.autor_principal)], ind1="1")
        self._field(record, "245", [("a", rec.titulo_principal), ("b", rec.subtitulo)], ind1="1", ind2="0")
        self._field(
            record,
            "260",
            [("a", rec.lugar_publicacion), ("b", rec.editorial), ("c", rec.anio_publicacion)],
        )
        self._field(record, "300", self._physical_subfields(rec))
        self._field(record, "500", [("a", rec.notas_fisicas)])

        for content_line in self._split_lines(rec.tabla_contenidos):
            self._field(record, "505", [("a", content_line)], ind1="0")

        self._field(record, "520", [("a", rec.resumen)])

        for subject in self._split_values(rec.temas_controlados or rec.temas, split_commas=True):
            self._field(record, "650", [("a", subject)], ind2="4")

        for descriptor in self._split_values(rec.descriptores_libres or rec.palabras_clave, split_commas=True):
            self._field(record, "653", [("a", descriptor)])

        for contributor in self._split_values(rec.colaboradores or rec.autores_secundarios):
            self._field(record, "700", [("a", contributor)], ind1="1")

        resource_url = rec.url_recurso_en_linea or rec.enlace_documento
        self._field(
            record,
            "856",
            [("y", "Recuperar PDF" if resource_url else ""), ("u", resource_url)],
            ind1="4",
            ind2="0",
        )

        item_type = self._item_type(rec)
        if item_type:
            self._field(record, "942", [("2", self._classification_source()), ("c", item_type)])

        if not self._include_item_fields():
            return record

        item_subfields = [
            ("a", self._home_branch()),
            ("b", self._holding_branch()),
            ("y", item_type),
            ("o", rec.clasificacion),
            ("u", resource_url),
        ]
        if any(value for _, value in item_subfields):
            self._field(record, "952", item_subfields)

        return record

    def _control_003(self, rec: MARC21Record) -> str:
        return (rec.codigo_control or rec.clasificacion or "CIESPAL").strip()

    def _classification_source(self) -> str:
        return os.getenv("KOHA_CLASSIFICATION_SOURCE", "ddc").strip() or "ddc"

    def _home_branch(self) -> str:
        return os.getenv("KOHA_HOME_BRANCH", "BIB1").strip() or "BIB1"

    def _holding_branch(self) -> str:
        return os.getenv("KOHA_HOLDING_BRANCH", "BIB1").strip() or "BIB1"

    def _item_type(self, rec: MARC21Record) -> str:
        env_value = os.getenv("KOHA_DEFAULT_ITEM_TYPE", "").strip()
        local_value = (rec.tipo_material or "").strip()
        value = env_value or local_value or "BK"
        if value.lower() in {"texto", "text", "libro", "book"}:
            return "BK"
        return value

    def _include_item_fields(self) -> bool:
        return os.getenv("KOHA_INCLUDE_ITEM_FIELDS", "false").strip().lower() in {"1", "true", "yes", "si", "sí"}

    def _physical_subfields(self, rec: MARC21Record) -> List[tuple[str, str]]:
        description = rec.descripcion_fisica or ""
        dimensions = (rec.dimensiones or self._extract_dimensions(description)).strip()
        extent = (rec.numero_paginas or self._extract_extent(description) or description).strip()
        support = (rec.soporte_fisico or self._extract_support(description, extent, dimensions)).strip()
        return [("a", extent), ("b", support), ("c", dimensions)]

    def _physical_value(self, subfields: List[tuple[str, str]], code: str) -> str:
        for subfield_code, value in subfields:
            if subfield_code == code:
                return value
        return ""

    def _extract_extent(self, text: str) -> str:
        match = re.search(
            r"\b\d+\s*(?:p\.|p[aá]g\.?|p[aá]gs\.?|p[aá]ginas|pages?)\b",
            text or "",
            re.IGNORECASE,
        )
        return match.group(0).strip() if match else ""

    def _extract_dimensions(self, text: str) -> str:
        match = re.search(r"\b\d+(?:[.,]\d+)?\s*cm\b", text or "", re.IGNORECASE)
        return match.group(0).strip() if match else ""

    def _extract_support(self, text: str, extent: str, dimensions: str) -> str:
        support = text or ""
        for value in (extent, dimensions):
            if value:
                support = support.replace(value, "")
        support = re.sub(r"\s+", " ", support).strip(" .;,-")
        return support

    def _split_lines(self, value: str) -> List[str]:
        if not value:
            return []
        lines = re.split(r"\r?\n|\s*\|\s*", value)
        return [line.strip(" .") for line in lines if line.strip(" .")]

    def _control(self, record: ET.Element, tag: str, value: str, is_leader: bool = False) -> None:
        value = (value or "").strip()
        if not value:
            return
        if is_leader:
            node = ET.SubElement(record, self._tag("leader"))
        else:
            node = ET.SubElement(record, self._tag("controlfield"), {"tag": tag})
        node.text = value

    def _field(
        self,
        record: ET.Element,
        tag: str,
        subfields: Iterable[tuple[str, str]],
        ind1: str = " ",
        ind2: str = " ",
    ) -> None:
        clean_subfields = [(code, (value or "").strip()) for code, value in subfields if (value or "").strip()]
        if not clean_subfields:
            return

        datafield = ET.SubElement(record, self._tag("datafield"), {"tag": tag, "ind1": ind1, "ind2": ind2})
        for code, value in clean_subfields:
            node = ET.SubElement(datafield, self._tag("subfield"), {"code": code})
            node.text = value

    def _control_008(self, year: str) -> str:
        entered = datetime.now(timezone.utc).strftime("%y%m%d")
        match = re.search(r"\b(1[5-9]\d{2}|20\d{2})\b", year or "")
        pub_year = match.group(1) if match else "    "
        return f"{entered}b{pub_year}    ec ||||| |||| 00| 0 spa d"

    def _split_values(self, value: str, split_commas: bool = False) -> List[str]:
        if not value:
            return []
        pattern = r"\s*[|;]\s*"
        if split_commas:
            pattern = r"\s*[|;,]\s*"
        return [item.strip() for item in re.split(pattern, value) if item.strip()]

    def _join_values(self, value: str, split_commas: bool = False) -> str:
        return " | ".join(self._split_values(value, split_commas=split_commas))

    def _tag(self, name: str) -> str:
        return f"{{{MARC_NS}}}{name}"


marc21_exporter = MARC21Exporter()
