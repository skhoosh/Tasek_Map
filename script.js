// ── Constants ─────────────────────────────────────────────────────────────────
const FLOOR_ORDER = { B2: -2, B1: -1, G: 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6 };
const FLOORS = ["G", "1", "2", "3", "4", "5"];

// Floorplan polygon styling by Type (higher contrast so it stands out on the bg)
const TYPE_STYLE = {
    Shop:           { color: "#7d97bb", weight: 1, fillColor: "#d3e1f4", fillOpacity: 1 },
    Walkway:        { color: "#cbbd97", weight: 1, fillColor: "#fbf6ea", fillOpacity: 1 },
    Courtyard:      { color: "#cbbd97", weight: 1, fillColor: "#fbf6ea", fillOpacity: 1 },
    Toilet:         { color: "#579fc4", weight: 1, fillColor: "#bbe0f2", fillOpacity: 1 },
    "Nursing Room": { color: "#c684b1", weight: 1, fillColor: "#efccdf", fillOpacity: 1 },
    Surau:          { color: "#7fb58e", weight: 1, fillColor: "#c8e9d1", fillOpacity: 1 },
    Lift:           { color: "#cf8526", weight: 1, fillColor: "#ffc673", fillOpacity: 1 },
    Escalator:      { color: "#cf8526", weight: 1, fillColor: "#ffd595", fillOpacity: 1 },
    "Back of House":{ color: "#aeb4bd", weight: 1, fillColor: "#d4d8df", fillOpacity: 1 },
    Carpark:        { color: "#aeb4bd", weight: 1, fillColor: "#dadde2", fillOpacity: 1 },
    "Event Hall":   { color: "#9b89c4", weight: 1, fillColor: "#dbcff1", fillOpacity: 1 },
    Void:           { color: "#00000000", weight: 0, fillColor: "#ffffff", fillOpacity: 0 },
    _default:       { color: "#a7b1c0", weight: 1, fillColor: "#e2e8f0", fillOpacity: 1 },
};

const LEGEND = [
    ["Shop", "#d3e1f4"], ["Walkway", "#fbf6ea"], ["Toilet", "#bbe0f2"],
    ["Lift", "#ffc673"], ["Escalator", "#ffd595"], ["Back of House", "#d4d8df"],
];

const TRANSITION_LABEL = { lift: "Take lift", escalator: "Take escalator", stairs: "Take stairs" };
const VEHICLE_ICON = { lift: "\u{1F6D7}", escalator: "\u{1F6B6}", stairs: "\u{1F6B6}" };

// Direction-aware transition glyph: vehicle + up/down arrow based on floor order.
function transitionIcon(type, fromFloor, toFloor) {
    const up = (FLOOR_ORDER[toFloor] ?? 0) > (FLOOR_ORDER[fromFloor] ?? 0);
    return (VEHICLE_ICON[type] || "") + (up ? "↑" : "↓");
}

// Merge near-duplicate category labels coming from the data (singular/plural, reordered).
const CATEGORY_ALIAS = {
    "Food and Beverage": "Food and Beverages",
    "Leisure and Entertainment": "Entertainment and Leisure",
    "Home": "Home and Living",
    "Homes": "Home and Living",
};
function normCat(c) { return c ? (CATEGORY_ALIAS[c] || c) : null; }

// Categories that aren't real shopping categories — kept out of the filter dropdown.
const NON_SHOP_CATEGORIES = new Set(["Unoccupied", "Roof", "Storage", "Void", "Event Hall"]);

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
                layer.bindTooltip(p.ShopName, { className: "shop-label", permanent: true, direction: "center" });
                layer.on("click", e => openShopPopup(e, p));
            }
            layer.addTo(floorPlanLayers[fl]);
        },
    });

    // Searchable destinations: named shops + facilities (toilets, lifts, ...)
    const facilityNodes = [];
    for (const [id, n] of Object.entries(nodesById)) {
        if (n.name) shopList.push({ name: n.name, nodeId: id, floor_label: n.floor_label, lat: n.lat, lon: n.lon, category: normCat(n.category) });
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
        return { name: `${f.icon} ${f.label}${suffix}`, nodeId: id, floor_label: n.floor_label, lat: n.lat, lon: n.lon, isFacility: true, category: "Facilities" };
    });
    shopList.sort((a, b) => a.name.localeCompare(b.name));
    facList.sort((a, b) => a.name.localeCompare(b.name));
    shopList = shopList.concat(facList);

    buildLegend();
    buildCategoryFilter();
    showFloor("G");
    fitToFloor("G");
    updateLabelVisibility();
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

// Hide shop labels when zoomed out (avoids clutter); show when zoomed in.
const LABEL_MIN_ZOOM = 17;
function updateLabelVisibility() {
    map.getContainer().classList.toggle("hide-labels", map.getZoom() < LABEL_MIN_ZOOM);
}
map.on("zoomend", updateLabelVisibility);

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
        // solid base + animated "flow" overlay that moves toward the destination
        const base = L.polyline(coords, { color: "#ef4444", weight: 6, opacity: 0.85 }).addTo(routeLayer);
        L.polyline(coords, { color: "#fee2e2", weight: 3, opacity: 0.95, className: "route-flow" }).addTo(routeLayer);
        L.polylineDecorator(base, {
            patterns: [{ offset: "6%", repeat: "14%", symbol: L.Symbol.arrowHead({ pixelSize: 8, polygon: false, pathOptions: { stroke: true, color: "#1d4ed8", weight: 2 } }) }],
        }).addTo(routeLayer);
    }

    // Escalator/stair connectors — animated amber dashes + arrows showing travel direction,
    // drawn on both the floor you leave and the floor you arrive on.
    for (const c of (currentRoute.connectors || [])) {
        if (c.fromFloor === activeFloor || c.toFloor === activeFloor) {
            const cp = L.polyline(c.geom, { color: "#b45309", weight: 4, opacity: 0.95, className: "route-flow" }).addTo(routeLayer);
            L.polylineDecorator(cp, {
                patterns: [{ offset: "10%", repeat: "28%", symbol: L.Symbol.arrowHead({ pixelSize: 9, polygon: false, pathOptions: { stroke: true, color: "#b45309", weight: 2 } }) }],
            }).addTo(routeLayer);
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

// ── Category filter ───────────────────────────────────────────────────────────
let activeCategory = "";
const autocompletes = [];

function buildCategoryFilter() {
    const sel = document.getElementById("categoryFilter");
    if (!sel) return;
    const cats = [...new Set(shopList
        .filter(s => !s.isFacility && s.category && !NON_SHOP_CATEGORIES.has(s.category))
        .map(s => s.category))].sort();
    cats.push("Facilities"); // browse toilets/lifts/entrances etc.
    for (const c of cats) {
        const o = document.createElement("option");
        o.value = c; o.textContent = c;
        sel.appendChild(o);
    }
    sel.addEventListener("change", function () {
        activeCategory = this.value;
        // re-open the focused field's list with the new filter applied
        autocompletes.forEach(a => { if (document.activeElement === a.input) a.render(); });
    });
}

// ── Combobox: focus shows the (category-filtered) list; typing narrows it ──────
function makeAutocomplete(inputId, listId, onSelect) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    const render = () => {
        const q = input.value.trim().toLowerCase();
        const matches = shopList.filter(s =>
            (!q || s.name.toLowerCase().includes(q)) &&
            (!activeCategory || s.category === activeCategory)
        ).slice(0, 60);
        list.innerHTML = "";
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
    };
    input.addEventListener("input", render);
    input.addEventListener("focus", render);
    input.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 150));
    autocompletes.push({ input, list, render });
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

function setTo(shop) {
    toShop = shop;
    document.getElementById("toInput").value = shop.name;
    updateNavigateBtn();
}

// Tap-to-select: clicking a shop polygon offers "From here" / "To here".
function openShopPopup(e, p) {
    const shop = shopList.find(s => s.name === p.ShopName && s.floor_label === String(p.FloorLevel));
    if (!shop) return;
    const div = document.createElement("div");
    div.className = "map-popup";
    div.innerHTML = `<div class="popup-title">${p.ShopName}</div><div class="popup-sub">${floorName(String(p.FloorLevel))}</div>`;
    const row = document.createElement("div");
    row.className = "popup-btns";
    const bFrom = document.createElement("button");
    bFrom.textContent = "From here";
    bFrom.addEventListener("click", () => { setFrom(shop); map.closePopup(); });
    const bTo = document.createElement("button");
    bTo.textContent = "To here";
    bTo.className = "primary";
    bTo.addEventListener("click", () => { setTo(shop); map.closePopup(); });
    row.append(bFrom, bTo);
    div.append(row);
    L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
}
