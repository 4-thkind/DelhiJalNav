"""Fine-tune YOLOv8n on the merged pothole dataset and export it for the PWA.

Exports ONNX without built-in NMS - the web app runs NMS in TypeScript so it can
apply its own per-class thresholds.
"""
import argparse, shutil
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "data.yaml"
WEB_MODEL = ROOT.parent / "app" / "public" / "models" / "pothole-yolov8n.onnx"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--imgsz", type=int, default=416)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default="0")
    ap.add_argument("--data", default=str(DATA), help="dataset yaml; ml/hazards4.yaml for the 4-class target")
    args = ap.parse_args()

    data = Path(args.data)
    if not data.exists():
        raise SystemExit(f"{data} not found - run `python ml/prepare_data.py` first")

    model = YOLO("yolov8n.pt")
    model.train(
        data=str(data),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        project=str(ROOT / "runs"),
        name="pothole-yolov8n",
        exist_ok=True,
        patience=25,
        # handheld phone footage: dim, shaky, and never mirrored
        degrees=5.0, translate=0.1, scale=0.4, fliplr=0.5, flipud=0.0,
        hsv_h=0.015, hsv_s=0.7, hsv_v=0.5, mosaic=1.0, erasing=0.2,
    )

    best = ROOT / "runs" / "pothole-yolov8n" / "weights" / "best.pt"
    onnx = Path(YOLO(str(best)).export(format="onnx", imgsz=args.imgsz, opset=12, simplify=True, dynamic=False))
    WEB_MODEL.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(onnx, WEB_MODEL)
    print(f"\nmodel ready for the app: {WEB_MODEL}")


if __name__ == "__main__":
    main()
