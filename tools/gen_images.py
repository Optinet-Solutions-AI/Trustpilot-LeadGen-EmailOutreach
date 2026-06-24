"""
AI image generator for the OptiRate marketing sites.
Uses the Gemini / Generative Language API (Imagen 4 fast) via stdlib only,
because the project venv's Python 3.14 has a broken stdlib (missing email.parser).
Run with the SYSTEM python:  py tools/gen_images.py [--test]
"""
import os, sys, json, base64, urllib.request, urllib.error

ROOT = r"C:\Users\User\Desktop\TRUSPILOT LEAD GEN AND EMAIL OUTREACH"
ENV  = os.path.join(ROOT, ".env")
OUT  = os.path.join(ROOT, "brand", "sites", "site-a", "assets", "img")
MODEL = "imagen-4.0-fast-generate-001"

os.makedirs(OUT, exist_ok=True)

key = None
with open(ENV, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line.startswith("NEXT_PUBLIC_GEMINI_API_KEY="):
            key = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
if not key:
    sys.exit("NEXT_PUBLIC_GEMINI_API_KEY not found in .env")

STYLE = (", modern premium 3D render, clean minimalist composition, soft studio lighting, "
         "emerald green and white color palette, glossy tasteful, high-end marketing aesthetic, "
         "centered, generous negative space, no text, no words, no letters, no watermark")

IMAGES = [
    ("hero",        "16:9", "Abstract business-growth concept: smooth ascending 3D bars, an upward arrow, and a subtle glowing checkmark badge"),
    ("svc-seo",     "4:3",  "A glossy 3D map location pin and a magnifying glass hovering over a stylized minimal city map, representing local search visibility"),
    ("svc-leads",   "4:3",  "A clean 3D funnel channelling small glowing green spheres downward into a magnet, representing lead generation"),
    ("svc-reputation","4:3","Five glossy 3D stars rising in an upward arc with a small glowing rating badge, representing five-star reviews and reputation"),
    ("svc-web",     "4:3",  "A sleek modern responsive website shown on a floating 3D laptop and smartphone, minimal UI, representing web design"),
    ("svc-ads",     "4:3",  "A glossy 3D target bullseye with a dart in the centre beside a small rising performance chart, representing paid advertising"),
    ("svc-social",  "4:3",  "A 3D network of connected glowing nodes with floating heart and chat-bubble icons, representing social media engagement"),
    ("about",       "16:9", "An abstract 3D growth engine of interlocking gears merging into a single upward arrow, representing a unified marketing team"),
]

def gen(name, ar, prompt):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:predict?key={key}"
    body = json.dumps({
        "instances": [{"prompt": prompt + STYLE}],
        "parameters": {"sampleCount": 1, "aspectRatio": ar}
    }).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        print(f"[FAIL] {name}: HTTP {e.code} -> {e.read().decode()[:400]}")
        return False
    except Exception as e:
        print(f"[FAIL] {name}: {e}")
        return False
    preds = data.get("predictions", [])
    if not preds:
        print(f"[FAIL] {name}: no predictions -> {str(data)[:300]}")
        return False
    b64 = preds[0].get("bytesBase64Encoded") or preds[0].get("bytes_base64_encoded")
    if not b64:
        print(f"[FAIL] {name}: no image bytes -> keys={list(preds[0].keys())}")
        return False
    path = os.path.join(OUT, name + ".png")
    with open(path, "wb") as out:
        out.write(base64.b64decode(b64))
    print(f"[OK]   {name:14s} -> assets/img/{name}.png  ({round(len(b64)*0.75/1024)} KB)")
    return True

items = IMAGES[:1] if "--test" in sys.argv else IMAGES
for n, ar, p in items:
    gen(n, ar, p)
print("DONE")
