"""Tests for grade_transcript.grade()."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "grade_transcript",
    Path(__file__).parent / "grade-transcript.py",
)
grade_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grade_mod)
grade = grade_mod.grade


def _ref(entries):
    return {"url": "x", "anchor_sec": 0, "entries": entries}


def test_clean_single_speaker_finals_zero_bleed():
    transcript = [
        {"seq": 1, "text": "a", "speaker_id": "S1", "t_start_ms": 0, "t_end_ms": 1000},
        {"seq": 2, "text": "b", "speaker_id": "S1", "t_start_ms": 1000, "t_end_ms": 2000},
    ]
    reference = _ref([
        {"speaker": "Lex", "t_start_sec": 0.0, "t_end_sec": 2.0, "text": "ground"},
    ])
    r = grade(transcript, reference)
    assert r["summary"]["bleed_finals"] == 0
    assert r["summary"]["gradeable_finals"] == 2
    assert r["summary"]["bleed_rate"] == 0.0


def test_two_speaker_overlap_counts_as_bleed():
    transcript = [
        {"seq": 1, "text": "compute. Yes.", "speaker_id": "S1",
         "t_start_ms": 0, "t_end_ms": 1300},
    ]
    reference = _ref([
        {"speaker": "Lex",   "t_start_sec": 0.0, "t_end_sec": 0.4, "text": "compute."},
        {"speaker": "Dario", "t_start_sec": 0.5, "t_end_sec": 1.3, "text": "Yes."},
    ])
    r = grade(transcript, reference)
    assert r["summary"]["bleed_finals"] == 1
    assert r["summary"]["gradeable_finals"] == 1
    assert r["summary"]["bleed_rate"] == 1.0
    assert sorted(r["bleeds"][0]["ref_speakers"]) == ["Dario", "Lex"]


def test_off_script_finals_excluded_from_denominator():
    transcript = [
        {"seq": 1, "text": "ad break", "speaker_id": "S1",
         "t_start_ms": 5000, "t_end_ms": 6000},
        {"seq": 2, "text": "real", "speaker_id": "S1",
         "t_start_ms": 0, "t_end_ms": 500},
    ]
    reference = _ref([
        {"speaker": "Lex", "t_start_sec": 0.0, "t_end_sec": 1.0, "text": "x"},
    ])
    r = grade(transcript, reference)
    assert r["summary"]["off_script_finals"] == 1
    assert r["summary"]["gradeable_finals"] == 1
    assert r["summary"]["bleed_finals"] == 0


def test_anchor_sec_offset_applied():
    transcript = [
        {"seq": 1, "text": "x", "speaker_id": "S1",
         "t_start_ms": 0, "t_end_ms": 1000},
    ]
    reference = {
        "url": "x", "anchor_sec": 194,
        "entries": [
            {"speaker": "Lex", "t_start_sec": 194.0, "t_end_sec": 195.0, "text": "x"},
        ],
    }
    r = grade(transcript, reference)
    assert r["summary"]["gradeable_finals"] == 1
    assert r["summary"]["bleed_finals"] == 0
