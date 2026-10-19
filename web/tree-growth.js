/** Wall-clock presentation only. Recorded work and historical dates stay unchanged. */
export const TREE_EMERGENCE_MS = 1000;
export const TREE_WORK_GROWTH_MS = 320;
const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const sizeForWork = score => Math.max(.23, Math.min(1.3, .24 + score / 7));
const settled = { trunk: 1, branches: 1, crown: 1, size: 1, active: false };

export function createTreeGrowth() {
    const trees = new Map();
    function scoreAt(tree, now) {
        const t = ease((now - tree.changedAt) / TREE_WORK_GROWTH_MS);
        return tree.fromScore + (tree.score - tree.fromScore) * t;
    }
    return {
        sync(items, now, { animate = true, reset = false } = {}) {
            if (reset) trees.clear();
            const visible = new Set(items.map(item => item.id));
            for (const id of trees.keys()) if (!visible.has(id)) trees.delete(id);
            const arriving = items.filter(item => !trees.has(item.id)).map(item => item.id).sort();
            const arrivalOrder = new Map(arriving.map((id, index) => [id, Math.min(600, index * 100)]));
            for (const { id, score } of items) {
                const current = trees.get(id);
                if (!current || !animate) {
                    trees.set(id, { score, fromScore: score, changedAt: now - TREE_WORK_GROWTH_MS,
                        bornAt: animate ? now + arrivalOrder.get(id) : now - TREE_EMERGENCE_MS });
                } else if (current.score !== score) {
                    current.fromScore = scoreAt(current, now);
                    current.score = score;
                    current.changedAt = now;
                }
            }
        },
        sample(id, now, animate = true) {
            const tree = trees.get(id);
            if (!tree || !animate) return settled;
            const age = clamp((now - tree.bornAt) / TREE_EMERGENCE_MS);
            const trunk = ease(age / .72);
            const branches = ease((age - .18) / .64);
            const crown = ease((age - .42) / .58);
            return { trunk, branches, crown,
                size: sizeForWork(scoreAt(tree, now)) / sizeForWork(tree.score),
                active: age < 1 || now - tree.changedAt < TREE_WORK_GROWTH_MS };
        },
        settle(ids = null) {
            const selected = ids === null ? trees.values() : ids.map(id => trees.get(id)).filter(Boolean);
            for (const tree of selected) {
                tree.bornAt = -Infinity;
                tree.changedAt = -Infinity;
                tree.fromScore = tree.score;
            }
        },
        has(id) { return trees.has(id); },
        /** Restart the emergence clock of trees that were held back, keeping their work score. */
        restart(ids, now) {
            for (const id of ids) {
                const tree = trees.get(id);
                if (tree) tree.bornAt = now;
            }
        },
        clear() { trees.clear(); },
    };
}

/**
 * New trees are planted only once the lot layout has stopped morphing. While the layout moves the
 * ground under a spawn (hill peak, lot lift, planting polygon) changes every frame, so a tree shown
 * then would slide. The hold hides them; release() returns the ids whose growth should now begin,
 * at which point the shown surface is the final one and the tree's first visible frame is on it.
 */
export function createSpawnHold() {
    const ids = new Set();
    return {
        hold(newIds, layoutActive) { if (layoutActive) for (const id of newIds) ids.add(id); },
        has(id) { return ids.has(id); },
        forget(visible) { for (const id of ids) if (!visible.has(id)) ids.delete(id); },
        release(layoutActive) {
            if (layoutActive || !ids.size) return [];
            const released = [...ids];
            ids.clear();
            return released;
        },
        get size() { return ids.size; },
        clear() { ids.clear(); },
    };
}
