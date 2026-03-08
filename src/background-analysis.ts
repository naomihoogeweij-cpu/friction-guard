// ──────────────────────────────────────────────
// Background analysis process for friction-guard
//
// Runs periodically (cron, idle-hook, or manual trigger).
// Takes unresolved incident fragments and:
// 1. Clusters temporally adjacent fragments
// 2. Escalates: multiple level-1 in short window → level-2
// 3. De-escalates: isolated markers that didn't recur
// 4. Detects co-occurrence patterns across markers
// 5. Updates signature scores based on cluster analysis
//
// No LLM required. Deterministic heuristics only.
// ──────────────────────────────────────────────

import {
  readLog,
  writeLog,
  getUnresolved,
  getFragmentsSince,
  markResolved,
  type IncidentFragment,
} from "./incident-log";

import {
  readProfile,
  writeProfile,
  inferConstraints,
  clamp01,
  type UserProfile,
  type FrictionLevel,
  type Signature,
  type Constraint,
} from "./friction-policy";

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────

/** Window in ms for temporal clustering (10 minutes) */
const CLUSTER_WINDOW_MS = 10 * 60 * 1000;

/** Number of level-1 fragments in cluster window that triggers escalation to level-2 */
const ESCALATION_COUNT = 3;

/** Hours after which an unresolved fragment with no neighbors is considered isolated */
const ISOLATION_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Signature decay applied to isolated (non-recurring) incidents */
const ISOLATION_DECAY = 0.02;

/** Signature boost applied to confirmed clusters */
const CLUSTER_BOOST = 0.06;

// ──────────────────────────────────────────────
// Temporal clustering
// ──────────────────────────────────────────────

interface Cluster {
  key: string;
  fragments: IncidentFragment[];
  startTime: number;
  endTime: number;
  maxLevel: FrictionLevel;
  effectiveLevel: FrictionLevel;
  markers: Set<string>;
  coOccurrence: Map<string, number>;
}

function clusterFragments(fragments: IncidentFragment[]): Cluster[] {
  if (fragments.length === 0) return [];

  // Sort by timestamp
  const sorted = [...fragments].sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const clusters: Cluster[] = [];
  let current: Cluster = {
    key: `cluster-${Date.now()}-0`,
    fragments: [sorted[0]],
    startTime: new Date(sorted[0].timestamp).getTime(),
    endTime: new Date(sorted[0].timestamp).getTime(),
    maxLevel: sorted[0].level,
    effectiveLevel: sorted[0].level,
    markers: new Set(sorted[0].markers),
    coOccurrence: new Map(),
  };

  for (let i = 1; i < sorted.length; i++) {
    const fragTime = new Date(sorted[i].timestamp).getTime();

    if (fragTime - current.endTime <= CLUSTER_WINDOW_MS) {
      // Same cluster
      current.fragments.push(sorted[i]);
      current.endTime = fragTime;
      if (sorted[i].level > current.maxLevel) {
        current.maxLevel = sorted[i].level as FrictionLevel;
      }
      for (const m of sorted[i].markers) {
        current.markers.add(m);
      }
    } else {
      // New cluster
      clusters.push(current);
      current = {
        key: `cluster-${Date.now()}-${i}`,
        fragments: [sorted[i]],
        startTime: fragTime,
        endTime: fragTime,
        maxLevel: sorted[i].level,
        effectiveLevel: sorted[i].level,
        markers: new Set(sorted[i].markers),
        coOccurrence: new Map(),
      };
    }
  }
  clusters.push(current);

  // Post-process: compute effective level and co-occurrence
  for (const cluster of clusters) {
    // Escalation: multiple level-1 fragments → level-2
    const level1Count = cluster.fragments.filter((f) => f.level === 1).length;
    if (level1Count >= ESCALATION_COUNT && cluster.maxLevel < 2) {
      cluster.effectiveLevel = 2;
    } else {
      cluster.effectiveLevel = cluster.maxLevel;
    }

    // Co-occurrence: count how often markers appear together
    for (const frag of cluster.fragments) {
      for (const m of frag.markers) {
        cluster.coOccurrence.set(
          m,
          (cluster.coOccurrence.get(m) || 0) + 1
        );
      }
    }
  }

  return clusters;
}

// ──────────────────────────────────────────────
// Co-occurrence pattern detection
// ──────────────────────────────────────────────

interface CoOccurrencePattern {
  markers: string[];
  frequency: number;
  suggestedSignature: Signature;
}

/**
 * Detect markers that frequently co-occur across clusters.
 * This reveals compound friction patterns that individual
 * marker detection misses.
 */
function detectCoOccurrencePatterns(
  clusters: Cluster[]
): CoOccurrencePattern[] {
  // Count pair co-occurrences across all clusters
  const pairCounts = new Map<string, number>();

  for (const cluster of clusters) {
    const markerList = [...cluster.markers];
    for (let i = 0; i < markerList.length; i++) {
      for (let j = i + 1; j < markerList.length; j++) {
        const pair = [markerList[i], markerList[j]].sort().join("+");
        pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
      }
    }
  }

  const patterns: CoOccurrencePattern[] = [];

  for (const [pair, count] of pairCounts) {
    if (count < 2) continue; // needs to recur
    const markers = pair.split("+");

    // Map known co-occurrence patterns to signatures
    let sig: Signature = "helpdesk_tone"; // default
    if (
      markers.includes("L2-001") && markers.includes("L2-002") // negation + correction
    ) {
      sig = "repetition";
    }
    if (
      markers.includes("L2-003") && markers.includes("L2-005") // imperative + exasperation
    ) {
      sig = "helpdesk_tone";
    }
    if (
      markers.includes("L1-001") && markers.includes("L2-006") // shortening + disengagement
    ) {
      sig = "over_explain";
    }

    patterns.push({ markers, frequency: count, suggestedSignature: sig });
  }

  return patterns;
}

// ──────────────────────────────────────────────
// Profile updates from analysis
// ──────────────────────────────────────────────

function applyClusterToProfile(
  cluster: Cluster,
  profile: UserProfile,
  patterns: CoOccurrencePattern[]
): void {
  // Boost signatures based on cluster effective level
  const boost =
    cluster.effectiveLevel >= 2
      ? CLUSTER_BOOST * 1.5
      : CLUSTER_BOOST;

  // Map cluster markers to signatures
  for (const marker of cluster.markers) {
    if (marker.startsWith("L2-001") || marker.startsWith("L2-002")) {
      profile.signatures.repetition = clamp01(
        profile.signatures.repetition + boost
      );
    }
    if (marker.startsWith("L2-003") || marker.startsWith("L3-")) {
      profile.signatures.helpdesk_tone = clamp01(
        profile.signatures.helpdesk_tone + boost
      );
    }
    if (marker.startsWith("L2-004")) {
      profile.signatures.cliche_empathy = clamp01(
        profile.signatures.cliche_empathy + boost
      );
    }
    if (marker.startsWith("L2-005")) {
      profile.signatures.over_explain = clamp01(
        profile.signatures.over_explain + boost
      );
    }
  }

  // Apply co-occurrence pattern boosts
  for (const pattern of patterns) {
    const allPresent = pattern.markers.every((m) => cluster.markers.has(m));
    if (allPresent) {
      profile.signatures[pattern.suggestedSignature] = clamp01(
        profile.signatures[pattern.suggestedSignature] + boost * 0.5
      );
    }
  }
}

function applyIsolationDecay(
  fragment: IncidentFragment,
  profile: UserProfile
): void {
  // Isolated incident: mild decay on related signatures
  for (const marker of fragment.markers) {
    if (marker.startsWith("L1-")) {
      // Level 1 isolated markers: decay everything slightly
      for (const sig of Object.keys(profile.signatures) as Signature[]) {
        profile.signatures[sig] = clamp01(
          profile.signatures[sig] - ISOLATION_DECAY * 0.5
        );
      }
    }
  }
}

// ──────────────────────────────────────────────
// Main analysis function
// ──────────────────────────────────────────────

export interface AnalysisResult {
  clustersFound: number;
  escalations: number;
  deEscalations: number;
  patternsDetected: CoOccurrencePattern[];
  fragmentsProcessed: number;
}

export function runBackgroundAnalysis(userId: string): AnalysisResult {
  const unresolved = getUnresolved(userId);
  const profile = readProfile(userId);

  if (unresolved.length === 0) {
    return {
      clustersFound: 0,
      escalations: 0,
      deEscalations: 0,
      patternsDetected: [],
      fragmentsProcessed: 0,
    };
  }

  // Step 1: Cluster unresolved fragments
  const clusters = clusterFragments(unresolved);

  // Step 2: Detect co-occurrence patterns
  const patterns = detectCoOccurrencePatterns(clusters);

  let escalations = 0;
  let deEscalations = 0;

  for (const cluster of clusters) {
    // Step 3: Escalation — multiple mild signals → stronger response
    if (cluster.effectiveLevel > cluster.maxLevel) {
      escalations++;
      for (const frag of cluster.fragments) {
        markResolved(
          userId,
          frag.id,
          cluster.key,
          cluster.effectiveLevel,
          `Escalated: ${cluster.fragments.length} fragments in ${Math.round((cluster.endTime - cluster.startTime) / 1000)}s window`
        );
      }
    }

    // Step 4: De-escalation — single isolated fragment, old enough
    else if (
      cluster.fragments.length === 1 &&
      Date.now() - cluster.endTime > ISOLATION_THRESHOLD_MS &&
      cluster.maxLevel <= 1
    ) {
      deEscalations++;
      applyIsolationDecay(cluster.fragments[0], profile);
      markResolved(
        userId,
        cluster.fragments[0].id,
        undefined,
        0 as FrictionLevel,
        "De-escalated: isolated level-1 fragment, no recurrence"
      );
    }

    // Step 5: Normal cluster — apply to profile and resolve
    else {
      applyClusterToProfile(cluster, profile, patterns);
      for (const frag of cluster.fragments) {
        markResolved(userId, frag.id, cluster.key);
      }
    }
  }

  // Step 6: Re-infer constraints from updated signatures
  inferConstraints(profile);
  writeProfile(profile);

  return {
    clustersFound: clusters.length,
    escalations,
    deEscalations,
    patternsDetected: patterns,
    fragmentsProcessed: unresolved.length,
  };
}
