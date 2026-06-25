// ── Constants ─────────────────────────────────────────────────────────────────
const FLOOR_ORDER = { B2: -2, B1: -1, G: 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6 };
const FLOORS = ["G", "1", "2", "3", "4", "5"];

// Floorplan polygon styling by Type
const TYPE_STYLE = {
    Shop:           { color: "#b9c6d6", weight: 1, fillColor: "#e8eef5", fillOpacity: 0.9 },
    Walkway:        { color: "#e7dcc2", weight: 1, fillColor: "#faf6ea", fillOpacity: 0.9 },
    Courtyard:      { color: "#e7dcc2", weight: 1, fillColor: "#faf6ea", fillOpacity: 0.9 },
    Toilet:         { color: "#9cc3d8", weight: 1, fillColor: "#d8ecf5", fillOpacity: 0.9 },
    "Nursing Room": { color: "#d8a9c8", weight: 1, fillColor: "#f5e1ee", fillOpacity: 0.9 },
    Surau:          { color: "#a9c8b0", weight: 1, fillColor: "#e1f0e6", fillOpacity: 0.9 },
    Lift:           { color: "#e0a85a", weight: 1, fillColor: "#ffe6c2", fillOpacity: 0.95 },
    Escalator:      { color: "#e0a85a", weight: 1, fillColor: "#ffedd6", fillOpacity: 0.95 },
    "Back of House":{ color: "#cfcfcf", weight: 1, fillColor: "#ececec", fillOpacity: 0.8 },
    Carpark:        { color: "#cfcfcf", weight: 1, fillColor: "#eeeeee", fillOpacity: 0.8 },
    "Event Hall":   { color: "#b9a9d8", weight: 1, fillColor: "#e8e1f5", fillOpacity: 0.9 },
    Void:           { color: "#e5e7eb", weight: 1, fillColor: "#ffffff", fillOpacity: 0 },
    _default:       { color: "#cbd5e1", weight: 1, fillColor: "#eef1f5", fillOpacity: 0.85 },
};

const LEGEND = [
    ["Shop", "#e8eef5"], ["Walkway", "#faf6ea"], ["Toilet", "#d8ecf5"],
    ["Lift", "#ffe6c2"], ["Escalator", "#ffedd6"], ["Back of House", "#ececec"],
];

const TRANSITION_LABEL = { lift: "Take lift", escalator: "Take escalator", stairs: "Take stairs" };
const VEHICLE_ICON = { lift: "\u{1F6D7}", escalator: "\u{1F6B6}", stairs: "\u{1F6B6}" };

// Direction-aware transition glyph: vehicle + up/down arrow based on floor order.
function transitionIcon(type, fromFloor, toFloor) {
    const up = (FLOOR_ORDER[toFloor] ?? 0) > (FLOOR_ORDER[fromFloor] ?? 0);
    return (VEHICLE_ICON[type] || "") + (up ? "↑" : "↓");
}

// Facility node types that are searchable destinations (besides named shops)
const FACILITIES = {
    Toilet:         { label: "Toilet", icon: "\u{1F6BB}" },
    Lift:           { label: "Lift", icon: "\u{1F6D7}" },
    Entrance:       { label: "Entrance", icon: "\u{1F6AA}" },
    Surau:          { label: "Surau", icon: "\u{1F54C}" },
    "Nursing Room": { label: "Nursing Room", icon: "\u{1F37C}" },
};

// ── Map (floorplans only — no tile basemap) ───────────────────────────────────
const map = L.map("map", {
    center: [1.5141, 103.6549],
    zoom: 18,
    minZoom: 16,
    maxZoom: 22,
    rotate: true,
    bearing: 316.5,
    zoomControl: true,
    attributionControl: false,
});

// ── State ─────────────────────────────────────────────────────────────────────
let graph = null;            // { nodes, edges }
let nodesById = {};          // nodeID -> node
let adj = {};                // nodeID -> [{to, weight}]
let edgeType = {};           // "from-to" -> type (walk/escalator/lift)
let edgeGeom = {};           // "from-to" -> [[lat,lon], ...]
let shopList = [];           // searchable destinations
let floorPlanLayers = {};    // floor_label -> L.layerGroup
let activeFloor = "G";

let currentRoute = null;     // { segments:{floor:[latlng]}, transitions:[], origin, dest, steps:[] }
let fromShop = null, toShop = null;

const planLayer = L.layerGroup().addTo(map);   // active floorplan
const routeLayer = L.layerGroup().addTo(map);  // active-floor route line
const markerLayer = L.layerGroup().addTo(map); // pins for active floor

// ── Load everything ───────────────────────────────────────────────────────────
Promise.all([
    fetch("data/graph.json").then(r => r.json()),
    fetch("data/QGIS/FloorPlans_Combined.geojson").then(r => r.json()),
    fetch("data/QGIS/edges.geojson").then(r => r.json()),
    fetch("data/QGIS/Up_Escalators.geojson").then(r => r.json()),
    fetch("data/QGIS/Down_Escalators.geojson").then(r => r.json()),
]).then(([graphData, plans, edges, up, down]) => {
    graph = graphData;
    nodesById = graph.nodes;

    // Adjacency + edge type for A*
    for (const e of graph.edges) {
        (adj[e.from] = adj[e.from] || []).push({ to: e.to, weight: e.weight });
        edgeType[`${e.from}-${e.to}`] = e.type;
    }

    // Route geometry lookup from the line layers (lon,lat -> lat,lon)
    const indexGeom = (features) => {
        for (const f of features) {
            const p = f.properties;
            if (!f.geometry) continue;
            const line = f.geometry.coordinates[0].map(c => [c[1], c[0]]);
            edgeGeom[`${p.from_n_id}-${p.to_n_id}`] = line;
            edgeGeom[`${p.to_n_id}-${p.from_n_id}`] = [...line].reverse();
        }
    };
    indexGeom(edges.features);
    indexGeom(up.features);
    indexGeom(down.features);

    // Floorplan layers, split by floor and styled by Type
    for (const fl of FLOORS) floorPlanLayers[fl] = L.layerGroup();
    L.geoJSON(plans, {
        style: f => styleFor(f.properties),
        onEachFeature: (f, layer) => {
            const p = f.properties;
            const fl = String(p.FloorLevel);
            if (!floorPlanLayers[fl]) return;
            if (p.Type === "Shop" && p.ShopName) {
                layer.bindTooltip(p.ShopName, { className: "shop-label", permanent: false, direction: "center" });
            }
            layer.addTo(floorPlanLayers[fl]);
        },
    });

    // Searchable destinations: named shops + facilities (toilets, lifts, ...)
    const facilityNodes = [];
    for (const [id, n] of Object.entries(nodesById)) {
        if (n.name) shopList.push({ name: n.name, nodeId: id, floor_label: n.floor_label, lat: n.lat, lon: n.lon });
        else if (FACILITIES[n.type]) facilityNodes.push({ id, n });
    }
    // number facilities that repeat on the same floor (e.g. "Toilet 1", "Toilet 2")
    const facTotal = {}, facSeen = {};
    for (const { n } of facilityNodes) {
        const k = `${n.type}|${n.floor_label}`;
        facTotal[k] = (facTotal[k] || 0) + 1;
    }
    const facList = facilityNodes.map(({ id, n }) => {
        const f = FACILITIES[n.type];
        const k = `${n.type}|${n.floor_label}`;
        facSeen[k] = (facSeen[k] || 0) + 1;
        const suffix = facTotal[k] > 1 ? ` ${facSeen[k]}` : "";
        return { name: `${f.icon} ${f.label}${suffix}`, nodeId: id, floor_label: n.floor_label, lat: n.lat, lon: n.lon, isFacility: true };
    });
    shopList.sort((a, b) => a.name.localeCompare(b.name));
    facList.sort((a, b) => a.name.localeCompare(b.name));
    shopList = shopList.concat(facList);

    buildLegend();
    showFloor("G");
    fitToFloor("G");
    console.log(`Loaded ${Object.keys(nodesById).length} nodes, ${shopList.length} shops, floors ${FLOORS}`);
});

function styleFor(p) {
    const base = TYPE_STYLE[p.Type] || TYPE_STYLE._default;
    if (p.Type === "Shop" && (!p.ShopName || p.Category === "Unoccupied")) {
        return { ...base, fillColor: "#f1f2f4", fillOpacity: 0.6 };
    }
    return base;
}

function buildLegend() {
    const el = document.getElementById("legend");
    el.innerHTML = "<h4>Legend</h4>" + LEGEND.map(([name, color]) =>
        `<div class="legend-row"><span class="legend-swatch" style="background:${color}"></span>${name}</div>`
    ).join("");
}

// ── Floor switching ───────────────────────────────────────────────────────────
function showFloor(floor) {
    activeFloor = floor;
    document.getElementById("floorLevel").value = floor;

    planLayer.clearLayers();
    if (floorPlanLayers[floor]) planLayer.addLayer(floorPlanLayers[floor]);

    renderRouteForActiveFloor();
}

function fitToFloor(floor) {
    const lg = floorPlanLayers[floor];
    if (!lg) return;
    let bounds = null;
    lg.eachLayer(l => { bounds = bounds ? bounds.extend(l.getBounds()) : l.getBounds(); });
    if (bounds) map.fitBounds(bounds, { padding: [30, 30] });
}

document.getElementById("floorLevel").addEventListener("change", function () {
    showFloor(this.value);
});

// ── A* ────────────────────────────────────────────────────────────────────────
function heuristic(a, b) {
    const dx = a.lon - b.lon, dy = a.lat - b.lat;
    const floorPenalty = Math.abs((a.floor || 0) - (b.floor || 0)) * 0.0002;
    return Math.sqrt(dx * dx + dy * dy) + floorPenalty;
}

function aStar(startId, goalId) {
    if (!nodesById[startId] || !nodesById[goalId]) return null;
    const open = new Set([startId]);
    const cameFrom = {};
    const g = {}, f = {};
    for (const id in nodesById) { g[id] = Infinity; f[id] = Infinity; }
    g[startId] = 0;
    f[startId] = heuristic(nodesById[startId], nodesById[goalId]);

    while (open.size) {
        let cur = null;
        for (const n of open) if (cur === null || f[n] < f[cur]) cur = n;
        if (cur === goalId) {
            const path = [cur];
            while (cur in cameFrom) { cur = cameFrom[cur]; path.push(cur); }
            return path.reverse();
        }
        open.delete(cur);
        for (const { to, weight } of (adj[cur] || [])) {
            const tentative = g[cur] + weight;
            if (tentative < g[to]) {
                cameFrom[to] = cur;
                g[to] = tentative;
                f[to] = tentative + heuristic(nodesById[to], nodesById[goalId]);
                open.add(to);
            }
        }
    }
    return null;
}

// ── Build route model (split by floor + transitions) ──────────────────────────
function buildRoute(path) {
    const segments = {};       // floor_label -> [latlng, ...]
    const rawTransitions = [];
    const connectors = [];     // escalator/stair lines (have geometry) to draw on both floors
    let curFloor = nodesById[path[0]].floor_label;
    let curCoords = [];
    let totalDist = 0;

    const flush = () => { if (curCoords.length) (segments[curFloor] = segments[curFloor] || []).push(...curCoords); curCoords = []; };

    for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const fa = nodesById[a].floor_label, fb = nodesById[b].floor_label;
        const t = edgeType[`${a}-${b}`] || "walk";
        const geom = edgeGeom[`${a}-${b}`];

        if (fa === fb) {
            if (geom) curCoords.push(...geom);
        } else {
            flush();
            rawTransitions.push({ type: t, fromFloor: fa, toFloor: fb, atNode: a, toNode: b });
            if (geom) connectors.push({ type: t, fromFloor: fa, toFloor: fb, geom });
            curFloor = fb;
        }
    }
    flush();

    // Merge chained vertical hops with no walking between (e.g. lift 1->2->3 => "to Level 3").
    // They chain when one transition's arrival node is the next one's departure node.
    const transitions = [];
    for (const tr of rawTransitions) {
        const last = transitions[transitions.length - 1];
        if (last && last.type === tr.type && last.toNode === tr.atNode) {
            last.toFloor = tr.toFloor;
            last.toNode = tr.toNode;
        } else {
            transitions.push({ ...tr });
        }
    }

    // distance/time from edge weights (vertical penalties included)
    for (let i = 0; i < path.length - 1; i++) {
        const link = (adj[path[i]] || []).find(e => e.to === path[i + 1]);
        if (link) totalDist += link.weight;
    }

    const steps = [{ kind: "start", floor: nodesById[path[0]].floor_label, label: fromShop ? fromShop.name : "Start" }];
    for (const tr of transitions) steps.push({ kind: "transition", type: tr.type, fromFloor: tr.fromFloor, toFloor: tr.toFloor });
    steps.push({ kind: "end", floor: nodesById[path[path.length - 1]].floor_label, label: toShop ? toShop.name : "Destination" });

    return { segments, transitions, connectors, steps, totalDist, originNode: path[0], destNode: path[path.length - 1] };
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function pin(latlng, html, bg) {
    return L.marker(latlng, {
        icon: L.divIcon({ className: "", html: `<div class="map-pin" style="background:${bg}">${html}</div>`, iconAnchor: [0, 0] }),
    });
}

function renderRouteForActiveFloor() {
    routeLayer.clearLayers();
    markerLayer.clearLayers();
    if (!currentRoute) return;

    const coords = currentRoute.segments[activeFloor];
    if (coords && coords.length) {
        const poly = L.polyline(coords, { color: "#ef4444", weight: 5, opacity: 0.9 }).addTo(routeLayer);
        L.polylineDecorator(poly, {
            patterns: [{ offset: "5%", repeat: "12%", symbol: L.Symbol.arrowHead({ pixelSize: 8, polygon: false, pathOptions: { stroke: true, color: "#1d4ed8", weight: 2 } }) }],
        }).addTo(routeLayer);
    }

    // Escalator/stair connector lines — dashed, drawn on both the floor you leave and arrive,
    // so users can see which way to walk onto and off the escalator.
    for (const c of (currentRoute.connectors || [])) {
        if (c.fromFloor === activeFloor || c.toFloor === activeFloor) {
            L.polyline(c.geom, { color: "#b45309", weight: 4, opacity: 0.9, dashArray: "6 8" }).addTo(routeLayer);
        }
    }

    // origin / destination pins, only on their own floor
    const o = nodesById[currentRoute.originNode], d = nodesById[currentRoute.destNode];
    if (o.floor_label === activeFloor) pin([o.lat, o.lon], "&#128205; You are here", "#22c55e").addTo(markerLayer);
    if (d.floor_label === activeFloor) pin([d.lat, d.lon], `&#127937; ${toShop ? toShop.name : "Destination"}`, "#ef4444").addTo(markerLayer);

    // transition pins: leaving this floor, and arriving on this floor
    for (const tr of currentRoute.transitions) {
        if (tr.fromFloor === activeFloor) {
            const n = nodesById[tr.atNode];
            pin([n.lat, n.lon], `${transitionIcon(tr.type, tr.fromFloor, tr.toFloor)} ${TRANSITION_LABEL[tr.type] || "Go"} to ${floorName(tr.toFloor)}`, "#b45309").addTo(markerLayer);
        }
        if (tr.toFloor === activeFloor) {
            const n = nodesById[tr.toNode];
            pin([n.lat, n.lon], `&#128072; Continue on ${floorName(activeFloor)}`, "#0ea5e9").addTo(markerLayer);
        }
    }
    highlightSteps();
}

function floorName(fl) { return fl === "G" ? "Ground" : "Level " + fl; }

// ── Steps panel ───────────────────────────────────────────────────────────────
function renderSteps() {
    const el = document.getElementById("routeSteps");
    if (!currentRoute) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    el.classList.remove("hidden");
    el.innerHTML = currentRoute.steps.map((s, i) => {
        if (s.kind === "transition") {
            return `<li data-floor="${s.toFloor}" data-i="${i}"><span class="step-icon">${transitionIcon(s.type, s.fromFloor, s.toFloor)}</span>
                    <span><span class="step-transition">${TRANSITION_LABEL[s.type]} to ${floorName(s.toFloor)}</span></span></li>`;
        }
        const icon = s.kind === "start" ? "&#128205;" : "&#127937;";
        return `<li data-floor="${s.floor}" data-i="${i}"><span class="step-icon">${icon}</span>
                <span>${s.label}<br><span class="step-floor">${floorName(s.floor)}</span></span></li>`;
    }).join("");

    el.querySelectorAll("li").forEach(li => li.addEventListener("click", () => {
        const step = currentRoute && currentRoute.steps[+li.getAttribute("data-i")];
        if (!step) return;
        const fl = li.getAttribute("data-floor");
        if (fl && fl !== activeFloor) showFloor(fl);
        fitMapToStep(step);
    }));
}

// Zoom/pan the map to frame whichever step the user tapped.
function fitMapToStep(step) {
    let bounds = null;
    const extend = (latlng) => { bounds = bounds ? bounds.extend(latlng) : L.latLngBounds(latlng, latlng); };
    const addSegment = (fl) => { const s = currentRoute.segments[fl]; if (s) s.forEach(extend); };
    const addNode = (id) => { const n = nodesById[id]; if (n) extend([n.lat, n.lon]); };

    if (step.kind === "start") {
        addSegment(step.floor); addNode(currentRoute.originNode);
    } else if (step.kind === "end") {
        addSegment(step.floor); addNode(currentRoute.destNode);
    } else { // transition: frame where you arrive + the onward path on that floor
        addSegment(step.toFloor);
        for (const c of currentRoute.connectors) {
            if (c.fromFloor === step.toFloor || c.toFloor === step.toFloor) c.geom.forEach(extend);
        }
        const tr = currentRoute.transitions.find(t =>
            t.type === step.type && t.fromFloor === step.fromFloor && t.toFloor === step.toFloor);
        if (tr) addNode(tr.toNode);
    }
    if (bounds) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 21 });
}

function highlightSteps() {
    document.querySelectorAll("#routeSteps li").forEach(li => {
        li.classList.toggle("active", li.getAttribute("data-floor") === activeFloor);
    });
}

// ── Navigation ────────────────────────────────────────────────────────────────
function updateNavigateBtn() {
    document.getElementById("navigateBtn").disabled = !(fromShop && toShop);
}

function triggerRoute() {
    if (!fromShop || !toShop || !graph) return;
    const path = aStar(fromShop.nodeId, toShop.nodeId);
    if (!path) { alert("No route found between these locations."); return; }

    currentRoute = buildRoute(path);

    const mins = Math.max(1, Math.ceil(currentRoute.totalDist / 70));
    const info = document.getElementById("routeInfo");
    const floorsCrossed = currentRoute.transitions.length;
    info.classList.remove("hidden");
    info.innerHTML = `<strong>Route found</strong><br>~${Math.round(currentRoute.totalDist)} m · ~${mins} min` +
        (floorsCrossed ? ` · ${floorsCrossed} floor change${floorsCrossed > 1 ? "s" : ""}` : "");

    renderSteps();
    showFloor(nodesById[currentRoute.originNode].floor_label);
    const seg = currentRoute.segments[activeFloor];
    if (seg && seg.length) map.fitBounds(L.polyline(seg).getBounds(), { padding: [40, 40] });
}

function clearAll() {
    fromShop = toShop = null;
    currentRoute = null;
    document.getElementById("fromInput").value = "";
    document.getElementById("toInput").value = "";
    document.getElementById("routeInfo").classList.add("hidden");
    document.getElementById("routeSteps").classList.add("hidden");
    routeLayer.clearLayers();
    markerLayer.clearLayers();
    updateNavigateBtn();
}

document.getElementById("navigateBtn").addEventListener("click", triggerRoute);
document.getElementById("clearBtn").addEventListener("click", clearAll);

// ── Autocomplete ──────────────────────────────────────────────────────────────
function makeAutocomplete(inputId, listId, onSelect) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        list.innerHTML = "";
        if (!q) { list.classList.add("hidden"); return; }
        const matches = shopList.filter(s => s.name.toLowerCase().includes(q)).slice(0, 10);
        if (!matches.length) { list.classList.add("hidden"); return; }
        for (const shop of matches) {
            const li = document.createElement("li");
            li.innerHTML = `<span>${shop.name}</span><span class="suggestion-floor">${floorName(shop.floor_label)}</span>`;
            li.addEventListener("mousedown", e => {
                e.preventDefault();
                input.value = shop.name;
                list.classList.add("hidden");
                onSelect(shop);
            });
            list.appendChild(li);
        }
        list.classList.remove("hidden");
    });
    input.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 150));
}

makeAutocomplete("fromInput", "fromSuggestions", s => { fromShop = s; updateNavigateBtn(); });
makeAutocomplete("toInput", "toSuggestions", s => { toShop = s; updateNavigateBtn(); });

// ── QR scanning ───────────────────────────────────────────────────────────────
const qrOverlay = document.getElementById("qrOverlay");
const qrVideo = document.getElementById("qrVideo");
const qrCanvas = document.getElementById("qrCanvas");
let qrStream = null, qrAnim = null;

document.getElementById("qrBtn").addEventListener("click", async () => {
    try {
        qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        qrVideo.srcObject = qrStream;
        await qrVideo.play();
        qrOverlay.classList.remove("hidden");
        scanQr();
    } catch {
        alert("Camera access was denied. Please allow camera permission and try again.");
    }
});

document.getElementById("qrClose").addEventListener("click", stopQr);

function stopQr() {
    if (qrStream) { qrStream.getTracks().forEach(t => t.stop()); qrStream = null; }
    if (qrAnim) { cancelAnimationFrame(qrAnim); qrAnim = null; }
    qrOverlay.classList.add("hidden");
}

function scanQr() {
    if (!qrStream) return;
    if (qrVideo.readyState === qrVideo.HAVE_ENOUGH_DATA) {
        const ctx = qrCanvas.getContext("2d");
        qrCanvas.width = qrVideo.videoWidth;
        qrCanvas.height = qrVideo.videoHeight;
        ctx.drawImage(qrVideo, 0, 0, qrCanvas.width, qrCanvas.height);
        const img = ctx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
        const code = jsQR(img.data, img.width, img.height);
        if (code) { stopQr(); handleQr(code.data); return; }
    }
    qrAnim = requestAnimationFrame(scanQr);
}

// QR encodes a node ID ("n_2_0048"), a shop name, or a URL with ?node= / ?name=
function handleQr(data) {
    let nodeId = null, name = null;
    try {
        const url = new URL(data);
        nodeId = url.searchParams.get("node");
        name = url.searchParams.get("name") || url.searchParams.get("shop");
    } catch {
        if (nodesById[data.trim()]) nodeId = data.trim();
        else name = data.trim();
    }
    if (name && !nodeId) {
        const hit = shopList.find(s => s.name.toLowerCase() === name.toLowerCase());
        if (hit) nodeId = hit.nodeId;
    }
    if (nodeId && nodesById[nodeId]) {
        const n = nodesById[nodeId];
        setFrom({ name: name || n.name || nodeId, nodeId, floor_label: n.floor_label, lat: n.lat, lon: n.lon });
    } else {
        alert(`QR scanned: "${data}"\nCould not match a known location.`);
    }
}

function setFrom(shop) {
    fromShop = shop;
    document.getElementById("fromInput").value = shop.name;
    updateNavigateBtn();
    if (shop.floor_label) showFloor(shop.floor_label);
}
