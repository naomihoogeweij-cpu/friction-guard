#!/usr/bin/env python3
"""
Semantic expansion for friction-guard v4.0.

Embeds banned phrases and miner n-grams via OpenAI,
clusters semantically similar patterns, and expands
ban lists with concrete variants.

Runs as subprocess from friction-guard's background cycle.
Results cached in memory/semantic/ for synchronous access.

Usage:
  python3 semantic-expansion.py expand-bans
  python3 semantic-expansion.py cluster-ngrams [--min-count 3]
  python3 semantic-expansion.py refresh
  python3 semantic-expansion.py state-summary
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

# Paths
WORKSPACE = os.path.expanduser("~/.openclaw/workspace")
MEMORY_DIR = os.path.join(WORKSPACE, "memory")
SEMANTIC_DIR = os.path.join(MEMORY_DIR, "semantic")
CONFIG_PATH = os.path.expanduser("~/.openclaw/openclaw.json")

EMBEDDING_CACHE_PATH = os.path.join(SEMANTIC_DIR, "embedding-cache.json")
NGRAM_CLUSTERS_PATH = os.path.join(SEMANTIC_DIR, "ngram-clusters.json")
EXPANDED_BANS_PATH = os.path.join(SEMANTIC_DIR, "expanded-bans.json")
META_PATH = os.path.join(SEMANTIC_DIR, "meta.json")
STATE_MD_PATH = os.path.join(MEMORY_DIR, "friction-guard-state.md")

CLASSIFIER_STATE_PATH = os.path.join(MEMORY_DIR, "classifier", "classifier-state.json")
MINER_STATE_PATH = os.path.join(MEMORY_DIR, "pattern-miner", "miner-state.json")
REGISTRY_PATH = os.path.join(WORKSPACE, "interaction", "agent-irritation-registry.json")
PROFILES_DIR = os.path.join(MEMORY_DIR, "interaction-profiles")

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS = 1536

# Thresholds
CLUSTER_SIMILARITY_THRESHOLD = 0.80
BAN_EXPANSION_THRESHOLD = 0.82
MIN_NGRAM_WORDS_CLUSTER = 4
MIN_NGRAM_WORDS_EXPAND = 3
MAX_EMBEDDINGS_PER_RUN = 200
MAX_VARIANTS_PER_BAN = 8


def get_openai_key():
    with open(CONFIG_PATH) as f:
        cfg = json.load(f)
    try:
        return cfg["agents"]["defaults"]["memorySearch"]["remote"]["apiKey"]
    except (KeyError, TypeError):
        pass
    try:
        return cfg["plugins"]["entries"]["memory-lancedb"]["config"]["embedding"]["apiKey"]
    except (KeyError, TypeError):
        pass
    raise RuntimeError("No OpenAI API key found")


def embed_batch(texts, api_key):
    if not texts:
        return []
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=json.dumps({"model": EMBEDDING_MODEL, "input": texts}).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    sorted_data = sorted(data["data"], key=lambda x: x["index"])
    return [item["embedding"] for item in sorted_data]


def cosine_similarity(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def load_embedding_cache():
    if os.path.exists(EMBEDDING_CACHE_PATH):
        try:
            return json.load(open(EMBEDDING_CACHE_PATH))
        except Exception:
            pass
    return {"model": EMBEDDING_MODEL, "embeddings": {}}


def save_embedding_cache(cache):
    os.makedirs(SEMANTIC_DIR, exist_ok=True)
    with open(EMBEDDING_CACHE_PATH, "w") as f:
        json.dump(cache, f, ensure_ascii=False)


def ensure_embedded(texts, cache, api_key):
    uncached = [t for t in texts if t not in cache["embeddings"]]
    if uncached:
        for i in range(0, min(len(uncached), MAX_EMBEDDINGS_PER_RUN), 100):
            batch = uncached[i:i + 100]
            vectors = embed_batch(batch, api_key)
            for text, vec in zip(batch, vectors):
                cache["embeddings"][text] = vec
        save_embedding_cache(cache)
    return {t: cache["embeddings"][t] for t in texts if t in cache["embeddings"]}


def load_classifier_state():
    if os.path.exists(CLASSIFIER_STATE_PATH):
        try:
            return json.load(open(CLASSIFIER_STATE_PATH))
        except Exception:
            pass
    return {"promotedBans": [], "candidates": []}


def load_miner_state():
    if os.path.exists(MINER_STATE_PATH):
        try:
            return json.load(open(MINER_STATE_PATH))
        except Exception:
            pass
    return {"ngramStats": {}, "promotedPatterns": []}


def load_registry():
    if os.path.exists(REGISTRY_PATH):
        try:
            return json.load(open(REGISTRY_PATH))
        except Exception:
            pass
    return {"categories": {}}


def load_profiles():
    profiles = []
    if os.path.exists(PROFILES_DIR):
        for f in os.listdir(PROFILES_DIR):
            if f.endswith(".json"):
                try:
                    profiles.append(json.load(open(os.path.join(PROFILES_DIR, f))))
                except Exception:
                    pass
    return profiles


def cmd_cluster_ngrams(args):
    miner = load_miner_state()
    ngram_stats = miner.get("ngramStats", {})
    min_count = args.min_count if hasattr(args, "min_count") else 3
    candidates = {}
    for ngram, stats in ngram_stats.items():
        if len(ngram.split()) < MIN_NGRAM_WORDS_CLUSTER:
            continue
        if stats["totalCount"] < min_count:
            continue
        candidates[ngram] = stats

    if not candidates:
        print(f"Geen n-grams met >={MIN_NGRAM_WORDS_CLUSTER} woorden en >={min_count} observaties.")
        return

    print(f"Clustering {len(candidates)} kandidaat-n-grams...")
    api_key = get_openai_key()
    cache = load_embedding_cache()
    texts = list(candidates.keys())
    embeddings = ensure_embedded(texts, cache, api_key)

    clustered = set()
    clusters = []
    embedded_texts = [t for t in texts if t in embeddings]

    for i, text_a in enumerate(embedded_texts):
        if text_a in clustered:
            continue
        cluster = [text_a]
        clustered.add(text_a)
        for text_b in embedded_texts[i + 1:]:
            if text_b in clustered:
                continue
            sim = cosine_similarity(embeddings[text_a], embeddings[text_b])
            if sim >= CLUSTER_SIMILARITY_THRESHOLD:
                cluster.append(text_b)
                clustered.add(text_b)
        if len(cluster) > 1:
            total_friction = sum(candidates[ng]["frictionCount"] for ng in cluster)
            total_calm = sum(candidates[ng]["calmCount"] for ng in cluster)
            total_count = sum(candidates[ng]["totalCount"] for ng in cluster)
            friction_rate = total_friction / total_count if total_count > 0 else 0
            clusters.append({
                "id": f"cluster-{len(clusters)}", "ngrams": cluster, "size": len(cluster),
                "aggregated": {"frictionCount": total_friction, "calmCount": total_calm,
                               "totalCount": total_count, "frictionRate": round(friction_rate, 3)},
            })

    os.makedirs(SEMANTIC_DIR, exist_ok=True)
    result = {"generatedAt": datetime.now(timezone.utc).isoformat(), "model": EMBEDDING_MODEL,
              "threshold": CLUSTER_SIMILARITY_THRESHOLD, "inputNgrams": len(candidates),
              "clustersFormed": len(clusters), "clusters": clusters}
    with open(NGRAM_CLUSTERS_PATH, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    promotable = [c for c in clusters if c["aggregated"]["totalCount"] >= 5 and c["aggregated"]["frictionRate"] >= 0.6]
    print(f"Clusters gevormd: {len(clusters)}")
    print(f"Promoteerbaar (>=5 obs, >=60% frictie): {len(promotable)}")
    for c in promotable[:5]:
        agg = c["aggregated"]
        print(f"  [{agg['frictionRate']:.0%} frictie, {agg['totalCount']}x] {c['ngrams'][:3]}")


def cmd_expand_bans(args):
    classifier = load_classifier_state()
    miner = load_miner_state()
    profiles = load_profiles()
    all_bans = set()
    all_bans.update(classifier.get("promotedBans", []))
    all_bans.update(miner.get("promotedPatterns", []))
    for profile in profiles:
        for ban in profile.get("bannedPhrases", []):
            if datetime.fromisoformat(ban["expiresAt"].replace("Z", "+00:00")) > datetime.now(timezone.utc):
                all_bans.add(ban["phrase"])

    if not all_bans:
        print("Geen actieve bans om uit te breiden.")
        os.makedirs(SEMANTIC_DIR, exist_ok=True)
        with open(EXPANDED_BANS_PATH, "w") as f:
            json.dump({"generatedAt": datetime.now(timezone.utc).isoformat(), "expansions": {}, "model": EMBEDDING_MODEL}, f)
        return

    print(f"Uitbreiden van {len(all_bans)} banned phrases...")
    api_key = get_openai_key()
    cache = load_embedding_cache()
    registry = load_registry()
    corpus = set()
    for cat_data in registry.get("categories", {}).values():
        for lang_patterns in cat_data.get("patterns", {}).values():
            corpus.update(lang_patterns)
    miner_state = load_miner_state()
    for ngram in miner_state.get("ngramStats", {}):
        if len(ngram.split()) >= MIN_NGRAM_WORDS_EXPAND:
            corpus.add(ngram)
    corpus -= all_bans
    corpus_list = list(corpus)
    if not corpus_list:
        print("Geen corpus beschikbaar voor uitbreiding.")
        return

    print(f"Corpus: {len(corpus_list)} patronen (registry + miner)")
    all_texts = list(all_bans) + corpus_list
    embeddings = ensure_embedded(all_texts, cache, api_key)

    expansions = {}
    for ban in all_bans:
        if ban not in embeddings:
            continue
        variants = []
        for corpus_phrase in corpus_list:
            if corpus_phrase not in embeddings:
                continue
            sim = cosine_similarity(embeddings[ban], embeddings[corpus_phrase])
            if sim >= BAN_EXPANSION_THRESHOLD:
                variants.append({"phrase": corpus_phrase, "similarity": round(sim, 3)})
        variants.sort(key=lambda x: -x["similarity"])
        variants = variants[:MAX_VARIANTS_PER_BAN]
        if variants:
            expansions[ban] = variants

    os.makedirs(SEMANTIC_DIR, exist_ok=True)
    result = {"generatedAt": datetime.now(timezone.utc).isoformat(), "model": EMBEDDING_MODEL,
              "threshold": BAN_EXPANSION_THRESHOLD, "bansExpanded": len(expansions),
              "totalVariants": sum(len(v) for v in expansions.values()), "expansions": expansions}
    with open(EXPANDED_BANS_PATH, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"Bans uitgebreid: {len(expansions)}")
    for ban, variants in list(expansions.items())[:3]:
        print(f"  \"{ban}\" → {len(variants)} varianten:")
        for v in variants[:3]:
            print(f"    {v['similarity']:.0%} \"{v['phrase']}\"")


def cmd_state_summary(args):
    classifier = load_classifier_state()
    miner = load_miner_state()
    profiles = load_profiles()
    expansions = {}
    if os.path.exists(EXPANDED_BANS_PATH):
        try:
            expansions = json.load(open(EXPANDED_BANS_PATH)).get("expansions", {})
        except Exception:
            pass
    clusters = []
    if os.path.exists(NGRAM_CLUSTERS_PATH):
        try:
            clusters = json.load(open(NGRAM_CLUSTERS_PATH)).get("clusters", [])
        except Exception:
            pass

    lines = ["# friction-guard state", f"*Bijgewerkt: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}*", ""]
    promoted = classifier.get("promotedBans", [])
    miner_promoted = miner.get("promotedPatterns", [])
    all_promoted = list(set(promoted + miner_promoted))
    if all_promoted:
        lines.append("## Actieve bans (gepromoveerd)")
        for ban in all_promoted:
            variants = expansions.get(ban, [])
            if variants:
                variant_str = ", ".join(f'"{v["phrase"]}"' for v in variants[:3])
                lines.append(f"- \"{ban}\" + {len(variants)} varianten: {variant_str}")
            else:
                lines.append(f"- \"{ban}\"")
        lines.append("")
    candidates = classifier.get("candidates", [])
    if candidates:
        top = sorted(candidates, key=lambda c: -c.get("observedCount", 0))[:10]
        lines.append("## Classifier-kandidaten (nog niet gepromoveerd)")
        for c in top:
            lines.append(f"- {c['observedCount']}x \"{c['phrase']}\" ({c['category']}, severity {c.get('severity', 0):.2f})")
        lines.append("")
    promotable = [c for c in clusters if c["aggregated"]["totalCount"] >= 5 and c["aggregated"]["frictionRate"] >= 0.6]
    if promotable:
        lines.append("## Semantische clusters (promoteerbaar)")
        for c in promotable[:5]:
            agg = c["aggregated"]
            ngrams_str = ", ".join(f'"{ng}"' for ng in c["ngrams"][:4])
            lines.append(f"- [{agg['frictionRate']:.0%} frictie, {agg['totalCount']}x]: {ngrams_str}")
        lines.append("")
    if profiles:
        lines.append("## Profielen")
        for p in profiles:
            uid = p.get("userId", "?")
            level = p.get("currentFrictionLevel", 0)
            sigs = p.get("signatures", {})
            active_constraints = [c["id"] for c in p.get("constraints", []) if c.get("enabled")]
            active_bans = [b["phrase"] for b in p.get("bannedPhrases", [])
                          if datetime.fromisoformat(b["expiresAt"].replace("Z", "+00:00")) > datetime.now(timezone.utc)]
            top_sigs = sorted(sigs.items(), key=lambda x: -x[1])[:3]
            sig_str = ", ".join(f"{k} {v:.2f}" for k, v in top_sigs if v > 0)
            lines.append(f"### {uid[:20]}...")
            lines.append(f"- Frictieniveau: {level}")
            if sig_str:
                lines.append(f"- Top signatures: {sig_str}")
            if active_constraints:
                lines.append(f"- Actieve constraints: {', '.join(active_constraints)}")
            if active_bans:
                lines.append(f"- Temporele bans: {', '.join(active_bans[:5])}")
            lines.append("")
    ngram_count = len(miner.get("ngramStats", {}))
    if ngram_count > 0:
        lines.append("## Miner")
        lines.append(f"- N-grams getrackt: {ngram_count}")
        lines.append(f"- Gepromoveerd: {len(miner_promoted)}")
        if clusters:
            lines.append(f"- Semantische clusters: {len(clusters)} (waarvan {len(promotable)} promoteerbaar)")
        lines.append("")
    with open(STATE_MD_PATH, "w") as f:
        f.write("\n".join(lines))
    print(f"State summary geschreven naar {STATE_MD_PATH}")


def cmd_refresh(args):
    cmd_cluster_ngrams(args)
    cmd_expand_bans(args)
    cmd_state_summary(args)
    os.makedirs(SEMANTIC_DIR, exist_ok=True)
    meta = {"lastRefresh": datetime.now(timezone.utc).isoformat(), "embeddingModel": EMBEDDING_MODEL,
            "clusterThreshold": CLUSTER_SIMILARITY_THRESHOLD, "banExpansionThreshold": BAN_EXPANSION_THRESHOLD}
    with open(META_PATH, "w") as f:
        json.dump(meta, f, indent=2)
    print("Refresh compleet.")


def main():
    parser = argparse.ArgumentParser(description="Semantic expansion for friction-guard")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("expand-bans")
    p_cluster = sub.add_parser("cluster-ngrams")
    p_cluster.add_argument("--min-count", type=int, default=3)
    sub.add_parser("refresh")
    sub.add_parser("state-summary")
    args = parser.parse_args()
    if not args.cmd:
        parser.print_help()
        return
    {"expand-bans": cmd_expand_bans, "cluster-ngrams": cmd_cluster_ngrams,
     "refresh": cmd_refresh, "state-summary": cmd_state_summary}[args.cmd](args)


if __name__ == "__main__":
    main()
