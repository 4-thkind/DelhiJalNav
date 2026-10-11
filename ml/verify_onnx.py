"""Confirm the exported ONNX matches what app/src/detector.ts assumes.

The TypeScript decoder hardcodes the YOLOv8 head layout - [1, 4 + classes,
anchors] with boxes as cx,cy,w,h in input pixels. If an export ever changes that
(a different opset, `nms=True`, a different task), the app silently draws boxes
in the wrong places. This catches it on the desktop instead of on the bike.
"""
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).resolve().parent
MODEL = ROOT.parent / "app" / "public" / "models" / "pothole-yolov8n.onnx"
CLASSES = 1  # keep in sync with CLASS_NAMES in app/src/types.ts

session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
inp = session.get_inputs()[0]
_, channels, size, _ = inp.shape
print(f"input  {inp.name} {inp.shape} {inp.type}")
assert channels == 3, f"expected 3 input channels, got {channels}"

# letterbox a real validation image the same way the app does
images = sorted((ROOT / "data" / "val" / "images").glob("*"))
assert images, "no validation images - run ml/prepare_data.py"
src = Image.open(images[0]).convert("RGB")
scale = min(size / src.width, size / src.height)
resized = src.resize((round(src.width * scale), round(src.height * scale)))
canvas = Image.new("RGB", (size, size), (114, 114, 114))
canvas.paste(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
tensor = np.asarray(canvas, np.float32).transpose(2, 0, 1)[None] / 255.0

out = session.run(None, {inp.name: tensor})[0]
print(f"output {session.get_outputs()[0].name} {out.shape}")

assert out.ndim == 3 and out.shape[0] == 1, f"decoder expects [1, C, anchors], got {out.shape}"
assert out.shape[1] == 4 + CLASSES, (
    f"decoder expects 4 box + {CLASSES} class channels, got {out.shape[1]}."
    " Update CLASS_NAMES in app/src/types.ts if the class count changed."
)

boxes, scores = out[0, :4], out[0, 4:]
assert (boxes[:2].max() <= size * 1.5) and boxes[2:].min() >= 0, (
    "boxes do not look like cx,cy,w,h in input pixels - the decoder would misplace them"
)
assert 0 <= scores.min() and scores.max() <= 1.001, "class scores are not probabilities"

hits = int((scores.max(axis=0) > 0.4).sum())
print(f"\nOK - layout matches app/src/detector.ts")
print(f"     {hits} raw detections above 0.40 on {images[0].name} (pre-NMS)")
if hits == 0:
    print("     note: no hits on this image; not an error, just a clean frame", file=sys.stderr)
