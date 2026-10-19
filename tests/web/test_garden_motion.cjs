const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const contourModule=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../web/garden-island-contours.js'),'utf8').replace(/export /g,'')+';({buildIslandContours,createIslandContourCache})');

const hillModule=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../web/garden-plot-hills.js'),'utf8').replace(/export /g,'')+';({createPlotHills,hillDepth})');

// These camera/inspection fixtures hold weather idle; dedicated tests cover arrivals.
function createContext(values) {
  const context=vm.createContext({
    ...hillModule,plotHills:hillModule.createPlotHills(),performance,DPR:1,paintHillTree:(c,box,masks,dpr,draw)=>draw(c),
    ...contourModule,islandContours:contourModule.createIslandContourCache(),targetContours:contourModule.createIslandContourCache(),lastRebuildMs:0,vectorFading:false,rasterPending:0,
    cloudArrivals: { active: false, sync() {}, advance() {}, entries: () => [] },
    cloudTextureRequested: true,
    spawnShots: {size:0,ids:()=>[],sync(){},cancel(){}}, queueArrival(){},
    playback:{state:()=>({playing:true})},orbitLastTime:0,
    centralOrbitFraming:()=>({center:{x:0,y:0},zoom:1}),
    fitFollower:{active:false,reset(){},pose:null},cloudFitIds:null,fitHandoff:false,drone:{ready:false,resume(){},step:()=>null},ensureDronePath:()=>false,orbitBasePose:()=>({center:{x:0,y:0},zoom:1}),droneFlying:false,droneAfter:0,lastCameraInputAt:-Infinity,driftUserOff:false,DRONE_IDLE_RESUME_MS:12000,DRONE_INPUT_HOLD_MS:4000,resumeAmbientCamera(){},
    showcase:null,pointerGesture:null,spinCoast:false,
    baseCamera:{yaw:0},robotTime:0,spawnReturn:null,idleStop:0,idleFocus:null,idleZoom:1,
    $:()=>({hidden:true}),W:800,H:600,viewRect:()=>({w:736,h:480}),
    shownLayout:()=>({plots:[],outline:square()}),
    liveMode:false,
    ...values,
  });
  vm.runInContext(robotSource.replace(/export (function|const) /g, "$1 "),context);
  vm.runInContext("var gardenOrbit=createGardenOrbit();",context);
  context.activeCameraMove=()=>context.showcase||context.arrival;
  context.activeOrbitFraming=()=>context.centralOrbitFraming();
  vm.runInContext(functionSource("treeElevation"),context);
  return context;
}

const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname,
    '../../web/canvas-garden.js'), 'utf8');
const flightSource = fs.readFileSync(path.join(__dirname,
    '../../web/garden-flight.js'), 'utf8');
const cameraMotionSource = fs.readFileSync(path.join(__dirname,
    '../../web/garden-camera-motion.js'), 'utf8');

const robotSource=fs.readFileSync(path.join(__dirname,"../../web/garden-robot-camera.js"),"utf8");

function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    const next = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, next < 0 ? undefined : next);
}

function square(size = 300) {
    const half = size / 2;
    return [
        { x: -half, y: -half }, { x: half, y: -half },
        { x: half, y: half }, { x: -half, y: half },
    ];
}

function harness() {
    let now = 0;
    let score = 3;
    const camera = { x: 0, y: 0, zoom: 1, auto: true };
    const context = createContext({
        camera,
        baseCamera: { ...camera },
        W: 800,
        H: 600,
        scale: 1,
        fitScale: 1,
        gardenLayout: { outline: square(), bounds: { x: -150, y: -150, w: 300, h: 300 } },
        hitBounds: new Map(),
        fitBounds: new Map(),
        flight: null,
        tour: null,
        spotlight: null,
        arrival: null,
        overviewFit: null,
        layoutMotion: { active: false },
        driftBase: null,
        idleAfter: 0,
        hoverSession: null,
        hoverProject: null,
        mapSession: null,
        pinnedMap: null,
        scrubbing: false,
        motion: true,
        motionPreference: { matches: false },
        growthDay: 2,
        work: () => score,
        displayedTrees: () => [{ s: { id: 'tree-a' }, x: 0, y: 0, lift: 0 }],
        botanical: {
            profile: () => ({ family: 'rounded' }),
            settledBounds: (s, origin) => ({ bounds: {
                x: origin.x - 30, y: origin.y - (score > 20 ? 520 : 180), w: 60, h: score > 20 ? 520 : 180,
            } }),
        },
        performance: { now: () => now },
        requestCameraDraw() {},
        point(x, y, z = 0) {
            return {
                x: 400 + ((x - y) - camera.x) * camera.zoom,
                y: 300 + ((x + y) * .43 - z - camera.y) * camera.zoom,
            };
        },
    });
    vm.runInContext(flightSource.replace(/export function /g, 'function '), context);
    vm.runInContext(`${functionSource('viewRect')}\n${functionSource('groundPolygon')}\n${functionSource('settledTreeFitBounds')}\n${functionSource('fitVisibleGarden')}`, context);
    return {
        context,
        setScore(value) { score = value; },
        setTime(value) { now = value; },
        fit() { vm.runInContext('fitVisibleGarden()', context); },
        camera,
    };
}

test('auto-fit ignores crown growth bounds during one tree emergence', () => {
    const h = harness();
    h.fit();
    const before = { ...h.camera };
    const initialFit = h.context.overviewFit;

    // This is the same tree at two growth samples. Its root is stable, but
    // botanical bounds expand as the crown unfolds.
    h.context.hitBounds.set('tree-a', { x: 340, y: 30, w: 36, h: 40 });
    h.setTime(33);
    h.fit();

    assert.deepEqual(h.camera, before,
        'camera must stay stable while an existing tree only grows');
    assert.equal(h.context.overviewFit, initialFit,
        'crown growth must not schedule a second camera fit');
});

test('auto-fit has no pullback pulse when the target zoom is unchanged', () => {
    const context = createContext({});
    vm.runInContext(cameraMotionSource.replace(/export function /g, 'function '), context);
    const from = { x: 20, y: -40, zoom: .8, auto: true };
    const to = { x: 80, y: 30, zoom: .8, auto: true };
    const fit = vm.runInContext('sampleAutoFit', context);
    assert.equal(typeof fit, 'function', 'auto-fit must have its own monotonic sampler');
    for (const progress of [0, .25, .5, .75, 1]) {
        const camera = fit(from, to, progress);
        assert.equal(camera.zoom, .8, `equal zoom changed at ${progress}`);
    }
});

test('an interrupted fit starts from the displayed camera', () => {
    const context = createContext({});
    vm.runInContext(cameraMotionSource.replace(/export function /g, 'function '), context);
    const fit = vm.runInContext('sampleAutoFit', context);
    const from = { x: 0, y: 0, zoom: 1, auto: true };
    const firstTarget = { x: 120, y: 50, zoom: .8, auto: true };
    const displayed = fit(from, firstTarget, .4);
    const secondTarget = { x: 40, y: 90, zoom: .7, auto: true };
    assert.deepEqual(fit(displayed, secondTarget, 0), displayed,
        'retargeting an active fit must preserve the displayed first frame');
});

test('settled crown envelopes still trigger a smooth fit for larger trees', () => {
    const h = harness();
    h.setScore(40);
    h.fit();
    assert.ok(h.context.overviewFit, 'an enlarged settled crown must remain contained');
    for (const field of ['x', 'y', 'zoom', 'auto']) {
        assert.equal(h.context.overviewFit.from[field], h.camera[field],
            `fit must start from displayed camera (${field})`);
    }
    assert.ok(h.context.overviewFit.to.zoom < h.camera.zoom,
        'a crown outside the viewport must reduce zoom smoothly');
});

test('automatic fit leaves a quiet grace before starting idle orbit', () => {
    const context = createContext({
        camera: { x: 0, y: 0, zoom: 1, auto: true },
        overviewFit: {
            from: { x: 0, y: 0, zoom: 1, auto: true },
            to: { x: 120, y: -30, zoom: .7, auto: true },
            fromFitScale: 1, toFitScale: .7, start: 0,
        },
        fitScale: 1,
        scale: 1,
        driftBase: null,
        driftStart: 0,
        idleAfter: 0,
        arrival: null,
        driftEnabled: true,
        ambientSuspended: false,
        motion: true,
        motionPreference: { matches: false },
        flight: null, tour: null, spotlight: null,
        hoverSession: null, hoverProject: null, mapSession: null,
        pinnedMap: null, scrubbing: false,
        layoutMotion: { active: false }, spawnHold: { size: 0 },
        lastSceneTime: 0,
        rebuild() {}, updateMap() {}, drawArcs() {},
    });
    vm.runInContext(cameraMotionSource.replace(/export function /g, 'function '), context);
    vm.runInContext(`${functionSource('advanceVisualScene')}`, context);
    vm.runInContext('advanceVisualScene(310)', context);
    assert.equal(context.camera.auto, true, 'automatic fit keeps overview ownership while moving');
    assert.ok(context.fitScale < 1 && context.fitScale > .7,
        'fit scale follows the displayed camera during the fit');
    const displayed = { ...context.camera };
    context.overviewFit = {
        from: displayed, to: { x: 40, y: 20, zoom: .8, auto: true },
        fromFitScale: context.fitScale, toFitScale: .8, start: 310,
    };
    vm.runInContext('advanceVisualScene(310)', context);
    assert.deepEqual({ x: context.camera.x, y: context.camera.y, zoom: context.camera.zoom },
        { x: displayed.x, y: displayed.y, zoom: displayed.zoom },
        'retargeting at the interruption frame preserves the displayed camera');
    vm.runInContext('advanceVisualScene(930)', context);
    assert.equal(context.overviewFit, null, 'completed fit releases ownership');
    assert.equal(context.driftBase, null, 'the completed fit stays still during idle grace');
    vm.runInContext('advanceVisualScene(3930)', context);
    assert.equal(context.driftBase.x, context.camera.x, 'drift starts from completed camera x');
    assert.equal(context.driftBase.y, context.camera.y, 'drift starts from completed camera y');
    assert.equal(context.driftBase.zoom, context.camera.zoom, 'drift starts from completed camera zoom');
});

function lifecycleHarness() {
    let now = 100;
    const tree = { s: { id: 'tree-edge' }, x: 600, y: -600, plotId: 'lot', lift: 0 };
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { textContent: '', value: '', hidden: false });
        return nodes.get(id);
    };
    const context = createContext({
        camera: { x: 0, y: 0, zoom: 1, auto: true },
        baseCamera: { x: 0, y: 0, zoom: 1, auto: true },
        W: 800, H: 600, scale: 1, fitScale: 1,
        gardenLayout: { outline: square(), bounds: { x: -150, y: -150, w: 300, h: 300 }, plots: [] },
        treePlacements: [tree], displayScene: null,
        projects: [], sessions: [], visibleSessions: [], selected: null,
        day: 1, maxDay: 2, startTime: 0, DAY: 86400000, growthDay: 0,
        motion: true, motionPreference: { matches: false },
        document: { hidden: false },
        hoverSession: null, hoverProject: null, hoverPath: null,
        mapSession: null, pinnedMap: null, pinnedPath: null, scrubbing: false,
        flight: null, tour: null, spotlight: null, overviewFit: null,
        arrival: null, idleAfter: 0,
        driftBase: null, driftStart: 0, driftEnabled: true, ambientSuspended: false,
        lastSceneTime: 0, dirty: false,
        layoutMotion: {
            active: false,
            retarget(layout, trees) { context.displayScene = { layout, trees, active: false }; return context.displayScene; },
            sample() { return context.displayScene; },
            settle() { return context.displayScene; },
        },
        spawnHold:{size:0,has:()=>false,hold(){},release:()=>[]},treeGrowth:{has:()=>true,restart(){},sync() {}, settle() {} },
        botanical: { settledBounds: (s, origin, z = 1) => ({ bounds: {
            x: origin.x - 20 * z, y: origin.y - 140 * z, w: 40 * z, h: 140 * z,
        } }) },
        performance: { now: () => now },
        documentElement: {},
        $: id => id === 'spawn-cards' ? {hidden:true} : node(id),
        point(x, y, z = 0) {
            return { x: 400 + ((x - y) - context.camera.x) * context.scale,
                y: 300 + ((x + y) * .43 - z - context.camera.y) * context.scale };
        },
        prepareWorld() {}, syncSpawnCards() {}, buildWorldScene() {}, syncCommitPulses() {},
        rebuild() {}, updateCard() {}, renderProjectSelect() {}, updateMap() {}, drawArcs() {},
        files() { return []; },
        syncTour() {},
        work() { return 3; },
        syncPlaybackControls() {},
    });
    vm.runInContext(cameraMotionSource.replace(/export function /g, 'function '), context);
    vm.runInContext([
        'point', 'viewRect', 'projectedBounds', 'fitWorldBounds', 'setCameraForBounds',
        'destinationForBounds', 'displayedTrees', 'settledTreeFitBounds', 'updateDay', 'orbitRebuildDue', 'advanceVisualScene',
    ].map(functionSource).join('\n'), context);
    return {
        context,
        setNow(value) { now = value; },
        tree,
    };
}

test('forward update retargets from sampled camera and contains an offscreen settled tree', () => {
    const h = lifecycleHarness();
    vm.runInContext('updateDay({cause:"playback"})', h.context);
    assert.ok(h.context.overviewFit, 'forward playback starts an automatic fit');
    vm.runInContext('advanceVisualScene(410)', h.context);
    const displayed = { ...h.context.camera };
    const displayedFitScale = h.context.fitScale;

    h.tree.x = 700;
    h.tree.y = -700;
    h.context.day = 2;
    h.setNow(500);
    vm.runInContext('updateDay({cause:"playback"})', h.context);
    assert.equal(h.context.camera.auto, true, 'automatic camera keeps fit ownership');
    for (const field of ['x', 'y', 'zoom']) {
        assert.equal(h.context.overviewFit.from[field], displayed[field],
            `retarget starts at displayed camera ${field}`);
    }
    assert.equal(h.context.overviewFit.fromFitScale, displayedFitScale,
        'retarget starts at displayed fit scale');
    vm.runInContext('advanceVisualScene(1120)', h.context);
    assert.equal(h.context.overviewFit, null, 'fit completes once');
    assert.equal(h.context.driftBase, null, 'idle grace follows the fit');
    vm.runInContext('advanceVisualScene(4120)', h.context);
    assert.equal(h.context.driftBase.x, h.context.camera.x, 'drift owns final camera x');
    assert.equal(h.context.driftBase.y, h.context.camera.y, 'drift owns final camera y');
    assert.equal(h.context.driftBase.zoom, h.context.camera.zoom, 'drift owns final camera zoom');
    const bounds = vm.runInContext('settledTreeFitBounds(treePlacements[0])', h.context);
    assert.ok(bounds.x >= 32 && bounds.y >= 32 && bounds.x + bounds.w <= 768 && bounds.y + bounds.h <= 512,
        `settled edge crown remains in the view: ${JSON.stringify(bounds)}`);
});

test('arrivals preserve continuous orbit, freeze on pause, and never restore a stale heading', () => {
    const h=lifecycleHarness();
    vm.runInContext('updateDay({cause:"playback"}); advanceVisualScene(720); advanceVisualScene(4000); advanceVisualScene(4033)',h.context);
    const initial={...h.context.camera};
    h.context.arrival={kind:'dive',anchorId:'tree-edge',subjectIds:['tree-edge'],elapsed:100,phase:'Gather'};
    vm.runInContext('advanceVisualScene(4066)',h.context);
    assert.ok(h.context.camera.yaw>initial.yaw,'rotation continues through spawn');
    h.context.playback={state:()=>({playing:false})};
    const paused={...h.context.camera};
    vm.runInContext('advanceVisualScene(4200)',h.context);
    assert.deepEqual({...h.context.camera},paused,'pause freezes active arrival camera');
    h.context.playback={state:()=>({playing:true})};
    h.context.arrival.elapsed=14000;
    vm.runInContext('advanceVisualScene(4233)',h.context);
    assert.equal(h.context.arrival,null);
    assert.ok(h.context.camera.yaw>paused.yaw,'arrival completion never rewinds the view');
    const beforeUpdate={...h.context.camera};
    h.context.day=2;h.setNow(4250);
    vm.runInContext('updateDay({cause:"playback"})',h.context);
    assert.equal(h.context.overviewFit,null,'new day does not take control from orbit');
    assert.deepEqual({...h.context.camera},beforeUpdate,'new day preserves the displayed pose');
});

test('completed dive clears even when Orbit is disabled', () => {
    const h=lifecycleHarness();
    h.context.arrival={kind:'dive',anchorId:'tree-edge',subjectIds:['tree-edge'],elapsed:14000,phase:'Settled'};
    h.context.driftEnabled=false;h.context.ambientSuspended=true;
    vm.runInContext('advanceVisualScene(200)',h.context);
    assert.equal(h.context.arrival,null,'elapsed completion cannot depend on orbit eligibility');
});

test('pointerdown records the Orbit toggle without mutating camera motion', () => {
    const bind=functionSource('bindCamera');
    const down=bind.slice(bind.indexOf("world.addEventListener('pointerdown'"),bind.indexOf("world.addEventListener('pointermove'",bind.indexOf("world.addEventListener('pointerdown'")));
    assert.match(down,/orbitEnabled:driftEnabled/);
    assert.doesNotMatch(down,/stopFlight\(|driftEnabled\s*=|ambientSuspended\s*=/);
});

test('shift-drag pan stays manual and the Orbit control resumes it', () => {
    const bind=functionSource('bindCamera');
    const finish=bind.slice(bind.indexOf('function finish('),bind.indexOf("world.addEventListener('pointerup'"));
    const drift=bind.slice(bind.indexOf("$('drift')?.addEventListener"),bind.indexOf("$('spotlight')?.addEventListener"));
    assert.match(finish,/driftEnabled=gesture\.orbitEnabled/,
        'pan release must preserve the Orbit toggle');
    assert.match(finish,/else\{camera\.auto=false;ambientSuspended=true/,
        'pan release must retain manual camera ownership');
    assert.doesNotMatch(finish,/else if\(gesture\.orbitEnabled\)\{camera\.auto=true/,
        'pan release must not restore automatic framing');
    assert.match(drift,/driftEnabled&&ambientSuspended/,
        'the Orbit control must resume a suspended enabled orbit');
    assert.match(drift,/if\(gardenOrbit\.active\)gardenOrbit\.rebase\(camera\)/,
        'Orbit resume must start from the displayed panned pose');
});

test('an unchanged daily fit leaves the idle grace intact', () => {
    const h = lifecycleHarness();
    vm.runInContext('updateDay({cause:"playback"})', h.context);
    vm.runInContext('advanceVisualScene(720)', h.context);
    const idleAfter = h.context.idleAfter;
    h.context.day = 2;
    h.setNow(1000);
    vm.runInContext('updateDay({cause:"playback"})', h.context);
    assert.equal(h.context.overviewFit, null);
    assert.equal(h.context.idleAfter, idleAfter);
    assert.equal(h.context.driftBase, null);
});

test('growth updates existing target geometry after layout motion settles', () => {
    const context = createContext({
        baseCamera: { zoom: 1 }, scale: 1, motion: true, day: 0, treeSize: 2.8, treeYScale: 1,
        forestCache: null, forestCanvas: {width:800,height:600},
        forestArt: {globalAlpha:1,save(){},restore(){},setTransform(){},clearRect(){}},
        motionPreference: { matches: false }, projectFilter: '', searchFilter: '',
        matchingIds: new Set(['tree-a']), flight: null, tour: null,
        renderedTrees: [{ s: { id: 'tree-a', agents: [] }, x: 0, y: 0,
            screen: { x: 100, y: 120 }, detailed: true, opacity: 1 }],
        anchorsOnScreen: new Map(), hitBounds: new Map(), targetButtons: new Map(),
        targetsDirty: false, metadataDirty: false, specimenVisualGeneration: 0,
        treeGrowth: { sample(id, now) { return { trunk: Math.min(1, now / 900), branches: 1, crown: 1, size: 1, active: now < 1140 }; } },
        botanical: { beginFrame() {}, usesVector: () => false, shadow() {}, stats: () => ({ bytes: 0, limit: 32 * 1024 * 1024, hits: 0, misses: 0 }) }, drawArcs() {},
        $: () => ({ dataset: {} }),
        canvas: { dataset: {} },
        drawTree(c, s, x, y, growth, origin) {
            const width = 20 + growth.trunk * 40;
            context.anchorsOnScreen.set(s.id, { x: origin.x, y: origin.y });
            context.hitBounds.set(s.id, { x: origin.x - width / 2, y: origin.y - width, w: width, h: width });
        },
    });
    const helperStart = source.indexOf('const MOTION_SETTLE_MS'), helperEnd = source.indexOf('\n', source.indexOf('function invalidateRects'));
    Object.assign(context, { flight: null, spotlight: null, overviewFit: null, layoutMotion: { active: false }, pointerGesture: null });
    vm.runInContext(source.slice(helperStart, helperEnd), context);
    vm.runInContext(`${functionSource('boundsChanged')}\n${functionSource('updateTargetGeometry')}\n${functionSource('drawForest')}`, context);
    const button = { dataset: {}, style: {} };
    context.targetButtons.set('tree-a', button);
    const ctx = { save() {}, restore() {}, drawImage() {}, globalAlpha: 1 };
    context.ctx = ctx;
    for (const now of [650, 850, 1140]) {
        vm.runInContext(`drawForest(ctx, ${now})`, context);
        assert.equal(button.style.width, `${20 + Math.min(1, now / 900) * 40}px`, `target width follows growth at ${now}ms`);
        assert.equal(context.metadataDirty, false, 'growth geometry must not force metadata rebuild');
    }
});
