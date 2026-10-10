#!/usr/bin/env python3
"""
Playlist generator for the pairwise video-quality study.

INPUT CSVs (UTF-8, with a header row):
  pairs.csv      columns: left,right[,id]          -> the pairs you want rated
  golden.csv     columns: left,right,correct       -> correct is "left" or "right"
  attention.csv  columns: left,right               -> any two clips; the page
                                                      asks for Video A (left)

OUTPUT:
  out/playlists/playlist_0.json ...   PUBLIC  (goes to GitHub Pages)
  out/private/trials_master.csv       PRIVATE (answer key + every trial's metadata)
  out/private/summary.txt             PRIVATE (counts and warnings)

By default the public JSON files do NOT contain the "correct" field, so nobody
can read the answers from your page source. Score golden/attention trials
offline using trials_master.csv. Use --embed-answers to include "correct".

USAGE:
  python make_playlists.py --pairs pairs.csv --golden golden.csv \
      --attention attention.csv --out out --seed 42
"""
import argparse
import csv
import json
import math
import os
import random
import sys


def read_csv(path, required):
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit(f"ERROR: {path} is empty")
    missing = [c for c in required if c not in rows[0]]
    if missing:
        sys.exit(f"ERROR: {path} is missing column(s): {missing}")
    return [{k.strip(): (v or "").strip() for k, v in r.items()} for r in rows]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pairs", required=True)
    ap.add_argument("--golden", required=True)
    ap.add_argument("--attention", required=True)
    ap.add_argument("--out", default="out")
    ap.add_argument("--n-new", type=int, default=36, help="new pairs per playlist")
    ap.add_argument("--n-golden", type=int, default=5)
    ap.add_argument("--n-repeat", type=int, default=5)
    ap.add_argument("--n-attn", type=int, default=2)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--start-index", type=int, default=0,
                    help="first playlist number (use a new range for each wave)")
    ap.add_argument("--wave", default="w1", help="wave label, used in trial ids")
    ap.add_argument("--embed-answers", action="store_true",
                    help="include the 'correct' field in the public JSON")
    ap.add_argument("--video-dir", default=None,
                    help="if given, check that every referenced file exists there")
    args = ap.parse_args()

    rng = random.Random(args.seed)

    pairs = read_csv(args.pairs, ["left", "right"])
    golden = read_csv(args.golden, ["left", "right", "correct"])
    attn = read_csv(args.attention, ["left", "right"])

    for g in golden:
        if g["correct"] not in ("left", "right"):
            sys.exit(f"ERROR: golden 'correct' must be left/right, got {g['correct']!r}")
    if len(golden) < args.n_golden:
        sys.exit(f"ERROR: need >= {args.n_golden} golden pairs, have {len(golden)}")
    if len(attn) < args.n_attn:
        sys.exit(f"ERROR: need >= {args.n_attn} attention pairs, have {len(attn)}")
    if args.n_repeat > args.n_new:
        sys.exit("ERROR: --n-repeat cannot exceed --n-new")

    # Stable pair ids
    for i, p in enumerate(pairs):
        if not p.get("id"):
            p["id"] = f"{args.wave}_p{i + 1:05d}"
    ids = [p["id"] for p in pairs]
    if len(set(ids)) != len(ids):
        sys.exit("ERROR: duplicate pair ids in pairs.csv")
    seen = set()
    for p in pairs:
        key = frozenset((p["left"], p["right"]))
        if key in seen:
            print(f"WARNING: duplicate pair {p['left']} / {p['right']}", file=sys.stderr)
        seen.add(key)

    # Optional file existence check
    if args.video_dir:
        every = {v for r in pairs + golden + attn for v in (r["left"], r["right"])}
        absent = sorted(v for v in every
                        if not os.path.exists(os.path.join(args.video_dir, v)))
        if absent:
            sys.exit("ERROR: missing video files:\n  " + "\n  ".join(absent[:30]))

    # Split new pairs across playlists (each pair appears in exactly one playlist)
    shuffled = pairs[:]
    rng.shuffle(shuffled)
    n_lists = math.ceil(len(shuffled) / args.n_new)
    chunks = [shuffled[i * args.n_new:(i + 1) * args.n_new] for i in range(n_lists)]

    pub_dir = os.path.join(args.out, "playlists")
    prv_dir = os.path.join(args.out, "private")
    os.makedirs(pub_dir, exist_ok=True)
    os.makedirs(prv_dir, exist_ok=True)

    master = []
    notes = []

    for li, chunk in enumerate(chunks):
        pl = args.start_index + li
        trials = []

        # --- new pairs, with randomised left/right ---
        for p in chunk:
            swap = rng.random() < 0.5
            l, r = (p["right"], p["left"]) if swap else (p["left"], p["right"])
            trials.append(dict(id=p["id"], kind="new", left=l, right=r,
                               correct="", repeat_of="", swapped=int(swap)))
        new_trials = list(trials)

        # --- repeats: sides flipped relative to the original presentation ---
        for k, orig in enumerate(rng.sample(new_trials, min(args.n_repeat, len(new_trials)))):
            trials.append(dict(id=f"{args.wave}_pl{pl}_r{k + 1:02d}", kind="repeat",
                               left=orig["right"], right=orig["left"], correct="",
                               repeat_of=orig["id"], swapped=1 - orig["swapped"]))

        # --- golden pairs (random side placement; correct adjusted) ---
        for k, g in enumerate(rng.sample(golden, args.n_golden)):
            swap = rng.random() < 0.5
            l, r = (g["right"], g["left"]) if swap else (g["left"], g["right"])
            corr = g["correct"]
            if swap:
                corr = "left" if corr == "right" else "right"
            trials.append(dict(id=f"{args.wave}_pl{pl}_g{k + 1:02d}", kind="golden",
                               left=l, right=r, correct=corr, repeat_of="", swapped=int(swap)))

        # --- attention checks: page asks for Video A, so correct is always left ---
        for k, a in enumerate(rng.sample(attn, args.n_attn)):
            swap = rng.random() < 0.5
            l, r = (a["right"], a["left"]) if swap else (a["left"], a["right"])
            trials.append(dict(id=f"{args.wave}_pl{pl}_a{k + 1:02d}", kind="attention",
                               left=l, right=r, correct="left", repeat_of="", swapped=int(swap)))

        rng.shuffle(trials)

        # --- write public JSON ---
        public = []
        for t in trials:
            row = {"id": t["id"], "kind": t["kind"], "left": t["left"], "right": t["right"]}
            if t["repeat_of"]:
                row["repeat_of"] = t["repeat_of"]
            if args.embed_answers and t["correct"]:
                row["correct"] = t["correct"]
            public.append(row)
        with open(os.path.join(pub_dir, f"playlist_{pl}.json"), "w", encoding="utf-8") as f:
            json.dump(public, f, indent=1)

        for pos, t in enumerate(trials):
            master.append({"playlist": pl, "wave": args.wave, "order_in_file": pos, **t})

        if len(chunk) < args.n_new:
            notes.append(f"playlist_{pl}: only {len(chunk)} new pairs (short last list)")

    # --- private master file ---
    cols = ["playlist", "wave", "order_in_file", "id", "kind", "left", "right",
            "correct", "repeat_of", "swapped"]
    with open(os.path.join(prv_dir, "trials_master.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(master)

    per_list = args.n_new + args.n_repeat + args.n_golden + args.n_attn
    summary = [
        f"Playlists written:      {n_lists} (numbers {args.start_index}..{args.start_index + n_lists - 1})",
        f"New pairs total:        {len(pairs)}",
        f"Trials per full list:   {per_list} "
        f"({args.n_new} new + {args.n_repeat} repeat + {args.n_golden} golden + {args.n_attn} attention)",
        f"Places needed for 5 votes per pair: {5 * n_lists} (5 per playlist)",
        "Public answers embedded: " + ("YES" if args.embed_answers else "no"),
    ] + notes
    with open(os.path.join(prv_dir, "summary.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(summary) + "\n")
    print("\n".join(summary))
    print(f"\nPublic:  {pub_dir}/   (upload to GitHub Pages)")
    print(f"Private: {prv_dir}/   (keep OFF GitHub)")


if __name__ == "__main__":
    main()
