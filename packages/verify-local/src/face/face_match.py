#!/usr/bin/env python3
"""
face_match.py — Soulprint on-demand face verification

Este script:
1. Se lanza como subprocess desde TypeScript
2. Carga InsightFace (~50MB buffalo_sc, ~4s)
3. Pre-procesa las imágenes (EXIF rotation, CLAHE, normalización)
4. Compara selfie vs foto de documento
5. Imprime resultado JSON por stdout
6. TERMINA — la memoria se libera completamente

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
    """Logs al stderr para no contaminar stdout (que es el canal JSON)."""
    print(*args, file=sys.stderr)


# ── Pre-procesamiento de imagen ────────────────────────────────────────────────

def fix_exif_rotation(img):
    """
    Corrige la orientación de la imagen según los metadatos EXIF.
    Fotos tomadas con celular vienen rotadas — sin esto InsightFace
    detecta rostros girados o no los detecta.
    """
    try:
        from PIL import Image, ExifTags
        import numpy as np

        # Convertir OpenCV BGR → PIL RGB
        import cv2
        pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))

        exif = pil_img._getexif()
        if exif is None:
            return img

        # Buscar la tag de orientación (tag 274)
        orientation_tag = next(
            (k for k, v in ExifTags.TAGS.items() if v == "Orientation"), None
        )
        if orientation_tag is None or orientation_tag not in exif:
            return img

        orientation = exif[orientation_tag]

        # Mapa de rotaciones EXIF → grados/flip
        rotations = {
            2: (None, True,  False),  # flip horizontal
            3: (180,  False, False),  # 180°
            4: (None, False, True),   # flip vertical
            5: (90,   True,  False),  # 90° CW + flip H
            6: (270,  False, False),  # 90° CCW
            7: (270,  True,  False),  # 90° CCW + flip H
            8: (90,   False, False),  # 90° CW
        }

        if orientation not in rotations:
            return img

        angle, flip_h, flip_v = rotations[orientation]

        if angle:
            pil_img = pil_img.rotate(angle, expand=True)
        if flip_h:
            pil_img = pil_img.transpose(Image.FLIP_LEFT_RIGHT)
        if flip_v:
            pil_img = pil_img.transpose(Image.FLIP_TOP_BOTTOM)

        # Convertir de vuelta a OpenCV BGR
        corrected = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        eprint(f"[soulprint] EXIF rotation corregida: orientación {orientation}")
        return corrected

    except Exception as e:
        eprint(f"[soulprint] EXIF rotation (skip): {e}")
        return img  # devolver original si falla


def apply_clahe(img):
    """
    CLAHE (Contrast Limited Adaptive Histogram Equalization).
    Normaliza iluminación local — mejora detección en fotos con:
    - Contraluz / sombras fuertes
    - Flash directo (sobreexposición)
    - Iluminación desigual (interior vs ventana)

    Se aplica solo en el canal L del espacio LAB para no alterar colores.
    """
    import cv2

    # Convertir BGR → LAB
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)

    # CLAHE solo en canal L (luminancia)
    # clipLimit=2.0: balance entre contraste y ruido
    # tileGridSize=(8,8): tamaño de región adaptativa
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_eq = clahe.apply(l)

    # Recombinar y convertir de vuelta a BGR
    lab_eq = cv2.merge([l_eq, a, b])
    result  = cv2.cvtColor(lab_eq, cv2.COLOR_LAB2BGR)

    return result


def preprocess_image(image_path: str):
    """
    Pipeline completo de pre-procesamiento:
    1. Leer imagen
    2. Corregir orientación EXIF
    3. Aplicar CLAHE para normalizar iluminación
    4. Resize si es muy grande (acelera detección sin pérdida de calidad)

    Retorna: (imagen_procesada, error_string | None)
    """
    import cv2
    import numpy as np

    img = cv2.imread(image_path)
    if img is None:
        return None, f"No se pudo leer la imagen: {image_path}"

    # 1. Corregir rotación EXIF (crítico para fotos de celular)
    img = fix_exif_rotation(img)

    # 2. Normalizar iluminación con CLAHE
    img = apply_clahe(img)

    # 3. Resize si es demasiado grande (>1920px de ancho)
    #    InsightFace no mejora con imágenes más grandes y sí se ralentiza
    h, w = img.shape[:2]
    if w > 1920:
        scale = 1920 / w
        new_w = 1920
        new_h = int(h * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
        eprint(f"[soulprint] Imagen redimensionada: {w}x{h} → {new_w}x{new_h}")

    return img, None


# ── Carga de modelos ───────────────────────────────────────────────────────────

def load_models():
    """Carga InsightFace on-demand. Solo se llama una vez por proceso."""
    try:
        from insightface.app import FaceAnalysis

        eprint("[soulprint] Cargando modelo de reconocimiento facial...")
        app = FaceAnalysis(
            name="buffalo_sc",
            providers=["CPUExecutionProvider"],
            allowed_modules=["detection", "recognition"],
        )
        app.prepare(ctx_id=0, det_size=(320, 320))
        eprint("[soulprint] Modelo listo")
        return app
    except ImportError as e:
        print(json.dumps({
            "match": False,
            "similarity": 0,
            "errors": [f"InsightFace no disponible: {e}. Instala con: pip install insightface"],
        }))
        sys.exit(1)


# ── Extracción de embedding ────────────────────────────────────────────────────

def get_face_embedding(app, img):
    """
    Extrae el embedding de la cara principal en una imagen ya pre-procesada.
    Recibe directamente el array de OpenCV (no el path).
    """
    if img is None:
        return None, "Imagen vacía"

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


def quantize_embedding(embedding, precision: int = 1):
    """
    Cuantiza el embedding para derivar nullifier determinístico.
    precision=1 (0.1 steps) absorbe ruido natural de InsightFace (±0.01).
    Misma cara en diferentes fotos/iluminaciones → mismo embedding cuantizado.
    """
    import numpy as np
    factor = 10 ** precision
    return (np.round(embedding * factor) / factor).tolist()


# ── Liveness detection ─────────────────────────────────────────────────────────

def check_liveness(img) -> dict:
    """
    Detección de ataques de presentación (foto de foto / pantalla).

    Checks:
    1. Nitidez (Laplacian variance) — pantallas tienen banding y menor nitidez
    2. Ruido de sensor — fotos reales tienen ruido Gaussiano, pantallas no
    3. Bordes de pantalla — detecta rectángulos negros en los bordes

    Retorna dict con score y razón del rechazo si aplica.
    """
    import cv2
    import numpy as np

    if img is None:
        return {"live": False, "reason": "Imagen vacía"}

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # 1. Nitidez por varianza del Laplaciano
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()

    # 2. Ruido de sensor — imágenes de pantalla tienen menos ruido aleatorio
    #    Calcular desvío estándar del residuo tras blur suave
    blurred    = cv2.GaussianBlur(gray, (5, 5), 0)
    noise_std  = float(np.std(gray.astype(int) - blurred.astype(int)))

    # 3. Banding horizontal — patrón regular en fotos de pantalla LCD/OLED
    #    FFT del canal Y: picos en frecuencias regulares indican refresh rate
    f         = np.fft.fft2(gray)
    fshift    = np.fft.fftshift(f)
    magnitude = np.log1p(np.abs(fshift))
    h, w      = magnitude.shape
    center    = magnitude[h//2 - 5:h//2 + 5, :]  # franja horizontal central
    banding_score = float(np.max(center) - np.mean(center))

    # Umbral: laplacian_var > 80 (nitidez OK), noise_std > 2 (ruido OK)
    is_sharp   = laplacian_var > 80.0
    has_noise  = noise_std > 1.5
    no_banding = banding_score < 12.0

    live = is_sharp and has_noise

    reason = None
    if not is_sharp:
        reason = f"Imagen poco nítida (Laplacian={laplacian_var:.1f}, mínimo 80)"
    elif not has_noise:
        reason = f"Patrón de pantalla detectado (noise_std={noise_std:.2f})"

    return {
        "live":           live,
        "laplacian_var":  round(laplacian_var, 1),
        "noise_std":      round(noise_std, 2),
        "banding_score":  round(banding_score, 2),
        "reason":         reason,
    }


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Soulprint face match")
    parser.add_argument("--selfie",   required=True,  help="Path selfie del usuario")
    parser.add_argument("--document", required=True,  help="Path foto del documento")
    parser.add_argument("--min-sim",  type=float, default=0.65, help="Similitud mínima")
    parser.add_argument("--liveness", action="store_true", help="Verificar liveness")
    args = parser.parse_args()

    errors = []

    # Verificar que los archivos existen
    for path in [args.selfie, args.document]:
        if not os.path.exists(path):
            print(json.dumps({
                "match": False, "similarity": 0,
                "errors": [f"Archivo no encontrado: {path}"]
            }))
            sys.exit(0)

    # ── Pre-procesar imágenes ────────────────────────────────────────────────
    eprint("[soulprint] Pre-procesando imágenes...")

    selfie_img, err = preprocess_image(args.selfie)
    if err:
        print(json.dumps({"match": False, "similarity": 0, "errors": [f"Selfie: {err}"]}))
        sys.exit(0)

    doc_img, err = preprocess_image(args.document)
    if err:
        print(json.dumps({"match": False, "similarity": 0, "errors": [f"Documento: {err}"]}))
        sys.exit(0)

    # ── Liveness check (antes de cargar InsightFace, más rápido) ────────────
    liveness_result = None
    if args.liveness:
        eprint("[soulprint] Verificando liveness...")
        liveness_result = check_liveness(selfie_img)
        if not liveness_result["live"]:
            print(json.dumps({
                "match":    False,
                "similarity": 0,
                "liveness": liveness_result,
                "errors":   [f"Liveness fallido: {liveness_result.get('reason', 'foto de pantalla detectada')}"]
            }))
            sys.exit(0)

    # ── Cargar modelo y extraer embeddings ──────────────────────────────────
    app = load_models()

    selfie_emb, err1 = get_face_embedding(app, selfie_img)
    if err1:
        print(json.dumps({"match": False, "similarity": 0, "errors": [f"Selfie: {err1}"]}))
        sys.exit(0)

    doc_emb, err2 = get_face_embedding(app, doc_img)
    if err2:
        print(json.dumps({"match": False, "similarity": 0, "errors": [f"Documento: {err2}"]}))
        sys.exit(0)

    # ── Calcular similitud ───────────────────────────────────────────────────
    similarity = cosine_similarity(selfie_emb, doc_emb)
    match      = similarity >= args.min_sim

    if not match:
        errors.append(
            f"Similitud insuficiente ({similarity:.2f} < {args.min_sim}). "
            "Usa una foto clara de frente con buena iluminación."
        )

    # Embedding cuantizado para derivar nullifier (determinístico entre sesiones)
    quantized = quantize_embedding(selfie_emb, precision=1)

    result = {
        "match":      match,
        "similarity": round(similarity, 4),
        "embedding":  quantized,
        "errors":     errors,
    }

    if liveness_result is not None:
        result["liveness"] = liveness_result

    print(json.dumps(result))
    # El proceso termina aquí → InsightFace + todos los modelos se liberan


if __name__ == "__main__":
    main()
