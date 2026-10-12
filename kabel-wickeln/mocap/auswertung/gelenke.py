"""Die 68 Gelenke des Take-Formats (FORMAT.md), ihre Knochen und die Zuordnung der Modell-Keypoints."""

COCO = ["nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder", "left_elbow",
        "right_elbow", "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle",
        "right_ankle"]
FEET = ["left_big_toe", "left_small_toe", "left_heel", "right_big_toe", "right_small_toe", "right_heel"]
HAND = ["wrist", "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip", "index_mcp", "index_pip", "index_dip", "index_tip",
        "middle_mcp", "middle_pip", "middle_dip", "middle_tip", "ring_mcp", "ring_pip", "ring_dip", "ring_tip",
        "pinky_mcp", "pinky_pip", "pinky_dip", "pinky_tip"]
EXTRA = ["pelvis", "neck", "head"]
JOINTS = COCO + FEET + [f"left_hand_{n}" for n in HAND] + [f"right_hand_{n}" for n in HAND] + EXTRA
J = len(JOINTS)  # 68
IDX = {n: i for i, n in enumerate(JOINTS)}
BODY17 = list(range(17))
MEASURED = list(range(65))  # alles außer den abgeleiteten pelvis, neck, head


def mirror_name(n):
    if n.startswith("left_"):
        return "right_" + n[5:]
    if n.startswith("right_"):
        return "left_" + n[6:]
    return n


# Index des gleichen Punkts auf der anderen Körperseite (für die Spiegel-Mittelung)
FLIP = [IDX[mirror_name(n)] for n in JOINTS]

# ------------------------------------------------------------------ Zuordnung der Modelle

# COCO-17 (YOLO-Pose, ViTPose): Modellindex k -> unser Index k
COCO_TO_OURS = list(range(17))

# Sapiens2 / Goliath (308 Keypoints, sapiens2 keypoints308.py "goliath"): unser Gelenk -> Goliath-Index.
# Körper: 0-8 Gesicht, Schultern, Ellbogen wie COCO; Handgelenke 62 (links) und 41 (rechts); Hüften 9/10,
# Knie 11/12, Knöchel 13/14. Füße 15-20 (big_toe_tip, small_toe_tip, heel; links, dann rechts).
# Hände: 21-41 rechts, 42-62 links; je Finger tip, first_joint (DIP, Daumen IP), second_joint (PIP, Daumen MCP),
# third_joint (MCP, Daumen CMC), dann das Handgelenk. Die Knochen laufen wrist -> third -> second -> first -> tip.
GOLIATH_NECK = 69


def _goliath_hand(base, wrist):
    # base = Index des Daumen-Tips; je Finger 4 Punkte: tip, first, second, third
    out = {"wrist": wrist}
    for f, finger in enumerate(["thumb", "index", "middle", "ring", "pinky"]):
        tip, first, second, third = base + 4 * f, base + 4 * f + 1, base + 4 * f + 2, base + 4 * f + 3
        if finger == "thumb":
            out.update({"thumb_cmc": third, "thumb_mcp": second, "thumb_ip": first, "thumb_tip": tip})
        else:
            out.update({f"{finger}_mcp": third, f"{finger}_pip": second, f"{finger}_dip": first, f"{finger}_tip": tip})
    return out


SAPIENS = {n: k for k, n in enumerate(["nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder",
                                       "right_shoulder", "left_elbow", "right_elbow"])}
SAPIENS.update({"left_wrist": 62, "right_wrist": 41, "left_hip": 9, "right_hip": 10, "left_knee": 11, "right_knee": 12,
                "left_ankle": 13, "right_ankle": 14, "left_big_toe": 15, "left_small_toe": 16, "left_heel": 17,
                "right_big_toe": 18, "right_small_toe": 19, "right_heel": 20})
SAPIENS.update({f"right_hand_{k}": v for k, v in _goliath_hand(21, 41).items()})
SAPIENS.update({f"left_hand_{k}": v for k, v in _goliath_hand(42, 62).items()})
# unsere Indizes und die Goliath-Indizes in derselben Reihenfolge (65 Punkte)
SAPIENS_OURS = [IDX[n] for n in JOINTS if n in SAPIENS]
SAPIENS_PICK = [SAPIENS[n] for n in JOINTS if n in SAPIENS]

# ------------------------------------------------------------------ Gruppen und Konstanten

def group(n):
    if "_hand_" in n:
        return "hand"
    if n in ("nose", "left_eye", "right_eye", "left_ear", "right_ear", "head"):
        return "face"
    if n.endswith(("toe", "heel")):
        return "foot"
    if n.endswith(("shoulder", "hip")) or n in ("pelvis", "neck"):
        return "torso"
    return "limb"


GROUP = [group(n) for n in JOINTS]

# Wie weit die Gelenkmitte hinter der Haut liegt, die die Tiefe sieht (mm, entlang der Sichtlinie).
# Anatomische Richtwerte; die synthetische Figur liegt ähnlich (Schulter 40-60, Hüfte 90-120, Knie ~60,
# Knöchel ~50, Handgelenk ~25, Fingergelenke ~10).
def _radius(n):
    if "_hand_" in n:
        if n.endswith("wrist"):
            return 25.0
        if n.endswith("tip"):
            return 0.0
        if n.endswith("thumb_cmc"):
            return 15.0
        return 10.0
    table = {"nose": 0, "left_eye": 0, "right_eye": 0, "left_ear": 20, "right_ear": 20, "shoulder": 50, "elbow": 40,
             "wrist": 25, "hip": 90, "knee": 55, "ankle": 45, "big_toe": 5, "small_toe": 10, "heel": 20}
    for k, v in table.items():
        if n == k or n.endswith("_" + k):
            return float(v)
    return 0.0


RADIUS = [_radius(n) for n in JOINTS]

# Elternteil für die Knochenlängen (Baum von den Schultern aus). Gesicht: kein Elternteil (eigene Regel).
PARENT = {
    "left_hip": "left_shoulder", "right_hip": "right_shoulder",
    "left_elbow": "left_shoulder", "right_elbow": "right_shoulder",
    "left_wrist": "left_elbow", "right_wrist": "right_elbow",
    "left_knee": "left_hip", "right_knee": "right_hip",
    "left_ankle": "left_knee", "right_ankle": "right_knee",
    "left_big_toe": "left_ankle", "left_small_toe": "left_ankle", "left_heel": "left_ankle",
    "right_big_toe": "right_ankle", "right_small_toe": "right_ankle", "right_heel": "right_ankle",
}
for side in ("left", "right"):
    for finger in ("thumb", "index", "middle", "ring", "pinky"):
        chain = (["thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip"] if finger == "thumb"
                 else [f"{finger}_{p}" for p in ("mcp", "pip", "dip", "tip")])
        prev = f"{side}_wrist"
        for c in chain:
            PARENT[f"{side}_hand_{c}"] = prev
            prev = f"{side}_hand_{c}"

# Reihenfolge der Bearbeitung: Eltern vor Kindern
ORDER = ["left_shoulder", "right_shoulder", "left_hip", "right_hip", "left_elbow", "right_elbow", "left_wrist",
         "right_wrist", "left_knee", "right_knee", "left_ankle", "right_ankle"] + FEET + \
        [f"{s}_hand_{n}" for s in ("left", "right") for n in HAND[1:]] + \
        ["nose", "left_eye", "right_eye", "left_ear", "right_ear"]

# Knochen mit fester Länge (für die Schätzung der Längen), zusätzlich zu PARENT
EXTRA_BONES = [("left_shoulder", "right_shoulder"), ("left_hip", "right_hip")]
BONES = [(PARENT[c], c) for c in JOINTS if c in PARENT] + EXTRA_BONES

# Skelett zum Zeichnen
DRAW = [("left_shoulder", "right_shoulder"), ("left_hip", "right_hip"), ("left_shoulder", "left_hip"),
        ("right_shoulder", "right_hip"), ("left_shoulder", "left_elbow"), ("left_elbow", "left_wrist"),
        ("right_shoulder", "right_elbow"), ("right_elbow", "right_wrist"), ("left_hip", "left_knee"),
        ("left_knee", "left_ankle"), ("right_hip", "right_knee"), ("right_knee", "right_ankle"),
        ("left_ankle", "left_heel"), ("left_ankle", "left_big_toe"), ("left_big_toe", "left_small_toe"),
        ("right_ankle", "right_heel"), ("right_ankle", "right_big_toe"), ("right_big_toe", "right_small_toe"),
        ("neck", "head"), ("nose", "left_eye"), ("nose", "right_eye"), ("left_eye", "left_ear"),
        ("right_eye", "right_ear")]
DRAW += [(PARENT[c], c) for c in JOINTS if "_hand_" in c and c in PARENT]

GERMAN = {"nose": "Nase", "left_eye": "linkes Auge", "right_eye": "rechtes Auge", "left_ear": "linkes Ohr",
          "right_ear": "rechtes Ohr", "left_shoulder": "linke Schulter", "right_shoulder": "rechte Schulter",
          "left_elbow": "linker Ellbogen", "right_elbow": "rechter Ellbogen", "left_wrist": "linkes Handgelenk",
          "right_wrist": "rechtes Handgelenk", "left_hip": "linke Hüfte", "right_hip": "rechte Hüfte",
          "left_knee": "linkes Knie", "right_knee": "rechtes Knie", "left_ankle": "linker Knöchel",
          "right_ankle": "rechter Knöchel"}
