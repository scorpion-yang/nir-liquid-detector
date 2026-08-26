"""Export the selected five-fold V8 concentration ensemble to browser ONNX files."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch


SOURCE_ROOT = Path(r"E:\Python Project\NIR_Liquid\V8-浓度检测")
RUN_DIR = SOURCE_ROOT / "runs" / "20260815_215317"
SITE_DIR = Path(__file__).resolve().parents[1]
MODEL_DIR = SITE_DIR / "model"

sys.path.insert(0, str(SOURCE_ROOT))

from data_utils import load_csv_inputs  # noqa: E402
from model import NIRV8ConcentrationModel  # noqa: E402


def load_checkpoint(path: Path) -> dict:
    try:
        return torch.load(path, map_location="cpu", weights_only=True)
    except TypeError:
        return torch.load(path, map_location="cpu")


def export_fold(fold_index: int) -> dict:
    fold_dir = RUN_DIR / f"fold_{fold_index:02d}"
    checkpoint_path = next(fold_dir.glob("*_best_model.pt"))
    checkpoint = load_checkpoint(checkpoint_path)
    model = NIRV8ConcentrationModel(**checkpoint["model_config"])
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()

    output_path = MODEL_DIR / f"concentration_fold_{fold_index:02d}.onnx"
    dummy = torch.zeros(
        1,
        int(checkpoint["model_config"]["seq_len"]),
        int(checkpoint["model_config"]["input_channels"]),
        dtype=torch.float32,
    )
    with torch.no_grad():
        torch.onnx.export(
            model,
            dummy,
            output_path,
            input_names=["features"],
            output_names=["normalized_concentration"],
            opset_version=17,
            do_constant_folding=True,
        )

    graph = onnx.load(output_path)
    onnx.checker.check_model(graph)
    session = ort.InferenceSession(str(output_path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(20260815 + fold_index)
    test_input = rng.normal(size=dummy.shape).astype(np.float32)
    with torch.no_grad():
        torch_output = model(torch.from_numpy(test_input)).cpu().numpy()
    ort_output = session.run(None, {"features": test_input})[0]
    max_difference = float(np.max(np.abs(torch_output - ort_output)))
    if max_difference > 1e-4:
        raise RuntimeError(
            f"Fold {fold_index} ONNX mismatch: max absolute difference {max_difference:g}"
        )

    normalization = checkpoint["normalization"]
    return {
        "fold": fold_index,
        "modelPath": f"./model/{output_path.name}",
        "normalization": {
            "mean": normalization["mean"],
            "std": normalization["std"],
        },
        "bestEpoch": checkpoint.get("best_epoch"),
        "bestScore": checkpoint.get("best_score"),
        "onnxMaxAbsDifference": max_difference,
    }


def verify_real_sample(metadata: dict) -> dict:
    data_dir = Path(json.loads((RUN_DIR / "config.json").read_text(encoding="utf-8"))["data_dir"])
    csv_path = next(data_dir.rglob("*.csv"))
    features, alignment = load_csv_inputs(
        csv_path,
        int(metadata["seqLen"]),
        preprocessing=metadata["preprocessing"],
        alignment_mode=metadata["alignmentMode"],
    )
    predictions = []
    for fold in metadata["folds"]:
        mean = np.asarray(fold["normalization"]["mean"], dtype=np.float32)
        std = np.asarray(fold["normalization"]["std"], dtype=np.float32)
        normalized = ((features - mean) / std)[None].astype(np.float32)
        session = ort.InferenceSession(
            str(SITE_DIR / fold["modelPath"].lstrip("./")),
            providers=["CPUExecutionProvider"],
        )
        raw = float(session.run(None, {"features": normalized})[0].squeeze())
        predictions.append(float(np.clip(raw, 0.0, 1.0) * 100.0))
    return {
        "csv": str(csv_path),
        "periodSamples": alignment.period_samples,
        "foldPredictions": predictions,
        "ensembleMean": float(np.mean(predictions)),
    }


def main() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    config = json.loads((RUN_DIR / "config.json").read_text(encoding="utf-8"))
    folds = [export_fold(index) for index in range(1, 6)]
    metadata = {
        "modelName": "NIR V8 five-fold concentration ensemble 20260815_215317",
        "modelFormat": "ONNX",
        "sourceRun": str(RUN_DIR),
        "task": "regression",
        "seqLen": int(config["seq_len"]),
        "inputChannels": len(config["feature_names"]),
        "sampleRateHz": float(config["sample_rate_hz"]),
        "windowSeconds": 1.5,
        "features": config["feature_names"],
        "preprocessing": config["preprocessing"],
        "alignmentMode": config["filter_alignment"]["alignment_mode"],
        "alignedFilterLengths": config["filter_alignment"]["aligned_filter_lengths"],
        "targetMin": float(config["target_min"]),
        "targetMax": float(config["target_max"]),
        "unit": "%",
        "ensemble": "arithmetic_mean_of_five_clamped_fold_predictions",
        "folds": folds,
    }
    metadata["verification"] = verify_real_sample(metadata)
    (MODEL_DIR / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(metadata["verification"], ensure_ascii=False, indent=2))
    for fold in folds:
        print(
            f"fold {fold['fold']}: {fold['modelPath']} "
            f"max_diff={fold['onnxMaxAbsDifference']:.3g}"
        )


if __name__ == "__main__":
    main()
