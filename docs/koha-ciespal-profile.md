# Perfil Koha CIESPAL observado

Inspección realizada por SSH en modo solo lectura.

## Servidor

- Host: `mediateca.server404.cloud`
- Puerto SSH: `2272`
- Instancia Koha: `library`
- Versión instalada: `23.05.01-1`
- OPAC local observado: `http://127.0.0.1:90`
- Biblioteca pública visible por API: `BIB1` / `Mediateca Ciespal`

## API Koha

La API REST local responde en:

- `http://127.0.0.1:90/api/v1/`
- `GET /api/v1/public/libraries` funciona sin autenticación.
- `GET /api/v1/public/biblios/{biblio_id}` permite consultar registros públicos.
- Los endpoints administrativos como `/api/v1/biblios` requieren autenticación y permisos Koha.

El OpenAPI local indica que `POST /biblios` recibe registros bibliográficos en:

- `application/marcxml+xml`
- `application/marc-in-json`
- `application/marc`

Para insertar registros reales hará falta un token/usuario Koha con permiso `editcatalogue`.

## Campos MARC usados en registros públicos

Los registros MARCXML públicos revisados usan este perfil base:

- `003`: código local/signatura observada.
- `008`: idioma `spa`; fechas y país dependen del libro.
- `040$c`: `CIESPAL.`
- `084$a`: clasificación/signatura local.
- `100$a`: autor principal.
- `245$a`, `245$b`: título y subtítulo.
- `260$a`, `260$b`, `260$c`: lugar, editorial, año.
- `300$a`, `300$b`, `300$c`: extensión, soporte físico, dimensiones.
- `500$a`: notas físicas o generales.
- `505$a` / `505$t`: tabla de contenidos.
- `520$a`: resumen.
- `650$a`: materias controladas.
- `653$a`: descriptores libres.
- `700$a`: colaboradores.
- `856$y`: `Recuperar PDF`.
- `856$u`: URL del PDF.
- `942$2`: `ddc`.
- `942$c`: `BK`.

No conviene generar `999$c` ni `999$d`; Koha los asigna internamente.

## Pendiente para integración directa

El usuario SSH de lectura no puede acceder a `/etc/koha/sites/library/koha-conf.xml` ni usar `koha-mysql`, por lo que no fue posible validar desde base de datos:

- frameworks bibliográficos activos;
- valores autorizados completos;
- itemtypes completos;
- subcampos obligatorios de ítems;
- reglas locales de importación.

Para cerrar esa parte, pedir a administración una de estas opciones:

- token API Koha con permisos de catálogo para pruebas;
- usuario Koha técnico con permisos `catalogue` y `editcatalogue`;
- export CSV de `itemtypes`, `branches`, `biblio_framework` y `marc_subfield_structure`;
- o agregar temporalmente el usuario SSH al grupo con lectura de configuración Koha.
