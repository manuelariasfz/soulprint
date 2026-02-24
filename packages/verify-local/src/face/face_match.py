#!/usr/bin/env python3
"""
face_match.py — Soulprint on-demand face verification

Este script:
1. Se lanza como subprocess desde TypeScript
2. Carga InsightFace (500MB, ~4s)
3. Compara selfie vs foto de documento
4. Imprime resultado JSON por stdout
5. TERMINA — la memoria se libera completamente

No hay proceso persistente. Cada verificación es un proceso nuevo.
"""

import sys
import json
import argparse
import os

# Silenciar warnings de TensorFlow/ONNX antes de importar
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["ONNXRUNTIME_LOG_LEVEL"] = "3"


def eprint(*args):
    """Logs al stderr para no contaminar stdout (que es el canal JSON)"""
    print(*args, file=sys.stderr)


def load_models():
    """Carga InsightFace on-demand. Solo se llama una vez por proceso."""
    try:
        import insightface
        from insightface.app import FaceAnalysis

        eprint("[soulprint] Cargando modelo de reconocimiento facial...")
        app = FaceAnalysis(
            name="buffalo_sc",        # modelo ligero (~50MB vs buffalo_l 500MB)
            providers=["CPUExecutionProvider"],
            allowed_modules=["detection", "recognition"],
        )
        app.prepare(ctx_id=0, det_size=(320, 320))  # resolución reducida = más rápido
        eprint("[soulprint] Modelo listo")
        return app
    except ImportError as e:
        print(json.dumps({
            "match": False,
            "similarity": 0,
            "errors": [f"InsightFace no disponible: {e}. Instala con: pip install insightface"],
        }))
        sys.exit(1)


def get_face_embedding(app, image_path: str):
    """Extrae el embedding de la cara principal en una imagen."""
    import cv2
    import numpy as np

    img = cv2.imread(image_path)
    if img is None:
        return None, f"No se pudo leer la imagen: {image_path}"

    faces = app.get(img)
    if not faces:
        return None, "No se detectó ninguna cara en la imagen"

    # Tomar la cara más grande (la principal)
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))

    return face.embedding, None


def cosine_similarity(a, b) -> float:
    """Similitud coseno entre dos embeddings. Rango: -1 a 1."""
    import numpy as np
    a = a / (np.linalg.norm(a) + 1e-8)
    b = b / (np.linalg.norm(b) + 1e-8)
    return float(np.dot(a, b))


def quantize_embedding(embedding, precision: int = 2):
    """
    Cuantiza el embedding para derivar nullifier determinístico.
    Misma cara en diferentes fotos → mismo embedding cuantizado.
    """
    import numpy as np
    factor = 10 ** precision
    return (np.round(embedding * factor) / factor).tolist()


def check_liveness(app, image_path: str) -> bool:
    """
    Detección básica de 'foto de foto':
    - Verifica que el contraste y nitidez son de foto real
    - No es antispoof completo, pero filtra ataques básicos
    """
    import cv2
    import numpy as np

    img = cv2.imread(image_path)
    if img is None:
        return False

    gray     = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    laplacian = cv2.Laplacian(gray, cv2.CV_64F).var()

    # Fotos de pantalla tienen banding y menor nitidez
    # Umbral empírico — ajustar con más datos reales
    return laplacian > 80.0


def main():
    parser = argparse.ArgumentParser(description="Soulprint face match")
    parser.add_argument("--selfie",    required=True, help="Path selfie del usuario")
    parser.add_argument("--document",  required=True, help="Path foto del documento")
    parser.add_argument("--min-sim",   type=float, default=0.65, help="Similitud mínima")
    parser.add_argument("--liveness",  action="store_true", help="Verificar liveness")
    args = parser.parse_args()

    # Verificar que los archivos existen
    for path in [args.selfie, args.document]:
        if not os.path.exists(path):
            print(json.dumps({
                "match": False, "similarity": 0,
                "errors": [f"Archivo no encontrado: {path}"]
            }))
            sys.exit(0)

    # Cargar modelo (on-demand, solo este proceso)
    app = load_models()

    # Extraer embeddings
    selfie_emb, err1 = get_face_embedding(app, args.selfie)
    if err1:
        print(json.dumps({"match": False, "similarity": 0, "errors": [f"Selfie: {err1}"]}))
        sys.exit(0)

    doc_emb, err2 = get_face_embedding(app, args.document)
    if err2:
        print(json.dumps({"match": False, "similarity": 0, "errors": [f"Documento: {err2}"]}))
        sys.exit(0)

    # Calcular similitud
    similarity = cosine_similarity(selfie_emb, doc_emb)
    match      = similarity >= args.min_sim

    # Liveness check (opcional)
    liveness = None
    if args.liveness:
        liveness = check_liveness(app, args.selfie)

    # Embedding cuantizado para derivar nullifier (determinístico)
    quantized = quantize_embedding(selfie_emb, precision=2)

    result = {
        "match":      match,
        "similarity": round(similarity, 4),
        "embedding":  quantized,   # para nullifier — NO es el embedding raw
        "errors":     [],
    }

    if liveness is not None:
        result["liveness"] = liveness

    if not match:
        result["errors"].append(
            f"Similitud insuficiente ({similarity:.2f} < {args.min_sim}). "
            "Usa una foto clara de frente con buena iluminación."
        )

    # Imprimir resultado por stdout (único canal con el proceso padre)
    print(json.dumps(result))

    # El proceso termina aquí → InsightFace se descarga de memoria automáticamente


if __name__ == "__main__":
    main()
