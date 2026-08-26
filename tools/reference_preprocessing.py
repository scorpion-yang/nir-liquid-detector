"""Emit the original V8 Python preprocessing result for JS parity testing."""

import json
import sys
from pathlib import Path

sys.path.insert(0, r"E:\Python Project\NIR_Liquid\V8-浓度检测")

from data_utils import load_csv_inputs  # noqa: E402


features, alignment = load_csv_inputs(
    Path(sys.argv[1]),
    224,
    use_cache=False,
    preprocessing="sg_smooth",
    alignment_mode="ch3_reference_independent_edge_warp_v1",
)
print(
    json.dumps(
        {
            "features": features.reshape(-1).tolist(),
            "boundaries": alignment.boundaries,
            "ch2Boundaries": alignment.ch2_boundaries,
            "periodSamples": alignment.period_samples,
            "anchorOriginalIndex": alignment.anchor_original_index,
        }
    )
)
