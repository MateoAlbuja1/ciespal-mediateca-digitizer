import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.endpoints import router as api_router

app = FastAPI(
    title="Mediateca CIESPAL - Backend de Digitalización & IA MARC21",
    description="API REST para procesamiento OCR, estructuración bibliográfica e integración con Koha ILS",
    version="1.0.0"
)

# Configuración CORS para permitir conexiones desde la app móvil o frontend local
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Montar carpeta de subidas estáticas
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# Incluir rutas API
app.include_router(api_router)

@app.get("/")
def read_root():
    return {
        "status": "online",
        "system": "Mediateca CIESPAL Digitizer API",
        "koha_marc21_compatible": True,
        "endpoints": {
            "scan": "/api/v1/scan",
            "records": "/api/v1/records",
            "export_csv": "/api/v1/export/csv",
            "export_marcxml": "/api/v1/export/marcxml"
        }
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
