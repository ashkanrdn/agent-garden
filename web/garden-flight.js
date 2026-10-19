/** Camera paths stay in the garden's existing isometric projection. */
export function sampleFlight(from, to, progress, lift = 0) {
    const t = Math.max(0, Math.min(1, progress));
    if (t === 0) return { ...from };
    if (t === 1) return { ...to };
    const ease = t * t * t * (t * (t * 6 - 15) + 10);
    // A small pullback reveals the paths between lots before settling in.
    const arc = Math.sin(Math.PI * ease);
    return {
        x: from.x + (to.x - from.x) * ease,
        y: from.y + (to.y - from.y) * ease - arc * lift,
        zoom: Math.exp(Math.log(from.zoom) + Math.log(to.zoom / from.zoom) * ease) * (1 - .1 * arc),
        auto: t >= 1 ? to.auto : t <= 0 ? from.auto : false
    };
}

const smooth = value => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * t * (t * (t * 6 - 15) + 10);
};

/** A card click takes a short scenic route, scaled to the visible distance. */
export function cardFlightPlan(from, to, viewport) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const nearZoom = Math.max(.006, Math.min(from.zoom, to.zoom));
    const pixels = distance * nearZoom;
    const travel = Math.min(1, pixels / Math.max(1, viewport.w * .8));
    const zoomChange = Math.abs(Math.log(to.zoom / from.zoom));
    const energy = Math.min(1, pixels / 160 + zoomChange / 2);
    return {
        duration: Math.min(2200, 1100 + travel * 600 + Math.min(3, zoomChange) * 150),
        cruiseZoom: Math.max(.006, nearZoom * (1 - .2 * travel)),
        liftPixels: Math.min(54, viewport.h * .09) * energy,
        bendPixels: Math.min(36, pixels * .1),
        landingZoom: Math.min(3, to.zoom * (1 + .025 * energy)),
    };
}

/** Pull back, sweep toward the tree, then ease out of a small landing push. */
export function sampleCardFlight(from, to, progress, plan) {
    const t = Math.max(0, Math.min(1, progress));
    if (t === 0) return { ...from };
    if (t === 1) return { ...to };
    const zoomBetween = (a, b, phase) => Math.exp(Math.log(a) + Math.log(b / a) * smooth(phase));
    const zoom = t < .2 ? zoomBetween(from.zoom, plan.cruiseZoom, t / .2)
        : t < .84 ? zoomBetween(plan.cruiseZoom, plan.landingZoom, (t - .2) / .64)
        : zoomBetween(plan.landingZoom, to.zoom, (t - .84) / .16);
    const travel = smooth(t / .84), arc = Math.sin(Math.PI * travel) ** 2;
    const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy) || 1;
    // Screen-sized curvature stays gentle at both overview and close zoom.
    return {
        ...from,
        x: from.x + dx * travel - dy / distance * plan.bendPixels * arc / zoom,
        y: from.y + dy * travel + (dx / distance * plan.bendPixels - plan.liftPixels) * arc / zoom,
        zoom,
        auto: false,
    };
}

/** Fit measured crowns as well as the ground, keeping root positions in world space. */
export function fitCameraToScreenBounds(camera, bounds, viewport, center = { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 }) {
    const factor = Math.min(1, viewport.w / Math.max(1, bounds.w), viewport.h / Math.max(1, bounds.h));
    if (bounds.x >= viewport.x - 1 && bounds.y >= viewport.y - 1 &&
        bounds.x + bounds.w <= viewport.x + viewport.w + 1 &&
        bounds.y + bounds.h <= viewport.y + viewport.h + 1) return camera;
    return {
        ...camera,
        x: camera.x + (bounds.x + bounds.w / 2 - center.x) / camera.zoom - (viewport.x + viewport.w / 2 - center.x) / (camera.zoom * factor),
        y: camera.y + (bounds.y + bounds.h / 2 - center.y) / camera.zoom - (viewport.y + viewport.h / 2 - center.y) / (camera.zoom * factor),
        zoom: camera.zoom * factor,
    };
}
