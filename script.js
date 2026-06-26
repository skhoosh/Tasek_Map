// ── Constants ─────────────────────────────────────────────────────────────────
const FLOOR_ORDER = { B2: -2, B1: -1, G: 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6 };
const FLOORS = ["G", "1", "2", "3", "4", "5"];

const TYPE_STYLE = {
    Shop:           { color: "#9CB4A4", weight: 1, fillColor: "#DDE9E1", fillOpacity: 1 },

    Walkway:        { color: "#D8CCB3", weight: 1, fillColor: "#F6F2E8", fillOpacity: 1 },
    Courtyard:      { color: "#D8CCB3", weight: 1, fillColor: "#F6F2E8", fillOpacity: 1 },

    Toilet:         { color: "#9BB2D3", weight: 1, fillColor: "#E7EEF7", fillOpacity: 1 },
    "Nursing Room": { color: "#D09ABC", weight: 1, fillColor: "#F7E6F0", fillOpacity: 1 },
    Surau:          { color: "#7BAF8C", weight: 1, fillColor: "#DDEFE2", fillOpacity: 1 },

    Lift:           { color: "#D39B43", weight: 1, fillColor: "#F6D79B", fillOpacity: 1 },

    Escalator:      { color: "#D6B26A", weight: 1, fillColor: "#F4D8A5", fillOpacity: 1 },

    "Back of House":{ color: "#B7BEC8", weight: 1, fillColor: "#E1E5EA", fillOpacity: 1 },
    Carpark:        { color: "#B7BEC8", weight: 1, fillColor: "#E7EAEE", fillOpacity: 1 },

    "Event Hall":   { color: "#A69BD4", weight: 1, fillColor: "#ECE8FA", fillOpacity: 1 },

    Void:           { color: "#00000000", weight: 0, fillColor: "#FFFFFF", fillOpacity: 0 },

    _default:       { color: "#B7BEC8", weight: 1, fillColor: "#E7EAEE", fillOpacity: 1 },
};

const LEGEND = [
    ["Shop", "#DDE9E1"], ["Walkway", "#F6F2E8"], ["Toilet", "#E7EEF7"],
    ["Lift", "#F6D79B"], ["Escalator", "#F4D8A5"], ["Back of House", "#E1E5EA"],
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
    minZoom: 18,
    maxZoom: 22,
    zoomControl: true,
    attributionControl: false,
    rotate: true,
    bearing: 316.5,
    // lock the rotation so users can't knock it off 316.5°
    rotateControl: false,
    touchRotate: false,
    shiftKeyRotate: false,
});

// keep the map sized to its (resizable) container so it isn't hidden behind the panel
new ResizeObserver(() => map.invalidateSize({ animate: false }))
    .observe(document.getElementById("map"));

// ── On-map floor selector (buttons, highest floor on top) ──────────────────────
const FloorControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
        const div = L.DomUtil.create("div", "floor-buttons");
        FLOORS.slice().reverse().forEach(fl => {
            const b = L.DomUtil.create("button", "floor-btn", div);
            b.textContent = fl;
            b.dataset.floor = fl;
            L.DomEvent.on(b, "click", L.DomEvent.stop).on(b, "click", () => showFloor(fl));
        });
        L.DomEvent.disableClickPropagation(div);
        return div;
    },
});
map.addControl(new FloorControl());

// brief centred overlay announcing the floor when it changes
let floorToastTimer = null;
function flashFloorToast(floor) {
    const t = document.getElementById("floorToast");
    if (!t) return;
    t.textContent = floorName(floor);
    t.classList.add("show");
    clearTimeout(floorToastTimer);
    floorToastTimer = setTimeout(() => t.classList.remove("show"), 900);
}

var southWest = L.latLng(1.511292, 103.65357)
var northEast = L.latLng(1.516925, 103.656255)
var bounds = L.latLngBounds(southWest,northEast)
map.setMaxBounds(bounds)
map.on('drag', function() {
    map.panInsideBounds(bounds, { animate: false });
});

// ── State ─────────────────────────────────────────────────────────────────────
let graph = null;            // { nodes, edges }
let nodesById = {};          // nodeID -> node
let adj = {};                // nodeID -> [{to, weight}]
let edgeType = {};           // "from-to" -> type (walk/escalator/lift)
let edgeGeom = {};           // "from-to" -> [[lat,lon], ...]
let shopList = [];           // searchable destinations
let floorPlanLayers = {};    // floor_label -> L.layerGroup
let activeFloor = "2";


let currentRoute = null;     // { segments:{floor:[latlng]}, transitions:[], origin, dest, steps:[] }
let fromShop = null, toShop = null;

const planLayer = L.layerGroup().addTo(map);   // active floorplan
const routeLayer = L.layerGroup().addTo(map);  // active-floor route line
const markerLayer = L.layerGroup().addTo(map); // pins for active floor


// ── Use icon markers ───────────────────────────────────────────────────────────
var startLocation = L.icon({
    iconUrl: "icons/startLocation.svg",
    iconSize:[50,50],
})

var endLocation = L.icon({
    iconUrl: "icons/endLocation.svg",
    iconSize:[50,50],  
});

var escalatorUp = L.icon({
    iconUrl: "icons/escalatorUp.svg",
    iconSize:[50,50],
});

var escalatorDown = L.icon({
    iconUrl: "icons/escalatorDown.svg",
    iconSize:[50,50],
});

var liftUp = L.icon({
    iconUrl: "icons/liftUp.svg",
    iconSize:[50,50],
});

var liftDown = L.icon({
    iconUrl: "icons/liftDown.svg",
    iconSize:[50,50],
});

// pick the right SVG icon for a vertical transition
function transitionMarkerIcon(type, goingUp) {
    if (type === "escalator") return goingUp ? escalatorUp : escalatorDown;
    if (type === "lift") return goingUp ? liftUp : liftDown;
    return null; // stairs: no dedicated icon
}

// L.marker([1.514149, 103.655106], {icon: testIcon}).addTo(map);

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
    showFloor("2");
    fitToFloor("2");
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
    document.querySelectorAll(".floor-btn").forEach(b => b.classList.toggle("active", b.dataset.floor === floor));
    flashFloorToast(floor);

    planLayer.clearLayers();
    if (floorPlanLayers[floor]) planLayer.addLayer(floorPlanLayers[floor]);

    renderRouteForActiveFloor();
}

function fitToFloor(floor) {
    const lg = floorPlanLayers[floor];
    if (!lg) return;
    let bounds = null;
    lg.eachLayer(l => { bounds = bounds ? bounds.extend(l.getBounds()) : l.getBounds(); });
    if (bounds) map.fitBounds(bounds, fitOpts());
}

// The map div now occupies only the unblocked area (panel doesn't overlap it),
// so plain padding frames the route correctly on every screen size.
function fitOpts(maxZoom) {
    const opts = { padding: [30, 30] };
    if (maxZoom) opts.maxZoom = maxZoom;
    return opts;
}

// Hide shop labels when zoomed out (avoids clutter); show when zoomed in.
const LABEL_MIN_ZOOM = 17;
function updateLabelVisibility() {
    map.getContainer().classList.toggle("hide-labels", map.getZoom() < LABEL_MIN_ZOOM);
}
map.on("zoomend", updateLabelVisibility);


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
// function pin(latlng, html, bg) {
//     return L.marker(latlng, {
//         icon: L.divIcon({ className: "", html: `<div class="map-pin" style="background:${bg}">${html}</div>`, iconAnchor: [0, 0] }),
//     });
// }

function pin(latlng, iconName) {
    return L.marker(latlng, {
        icon: iconName,
    });
}

function renderRouteForActiveFloor() {
    routeLayer.clearLayers();
    markerLayer.clearLayers();
    if (!currentRoute) return;

    const coords = currentRoute.segments[activeFloor];
    if (coords && coords.length) {
        // white casing (readable on any background) + bold route + animated flow toward destination
        L.polyline(coords, { color: "#ffffff", weight: 9, opacity: 0.95 }).addTo(routeLayer);
        const base = L.polyline(coords, { color: "#1D4ED8", weight: 5, opacity: 1 }).addTo(routeLayer);
        L.polyline(coords, { color: "#76e7f8", weight: 2, opacity: 1, className: "route-flow" }).addTo(routeLayer);
        L.polylineDecorator(base, {
            patterns: [{ offset: "6%", repeat: "14%", symbol: L.Symbol.arrowHead({ pixelSize: 6, polygon: false, pathOptions: { stroke: true, color: "#76e7f8", weight: 3 } }) }],
        }).addTo(routeLayer);
    }

    // Escalator/stair connectors — animated amber dashes + arrows showing travel direction,
    // drawn on both the floor you leave and the floor you arrive on.
    for (const c of (currentRoute.connectors || [])) {
        if (c.fromFloor === activeFloor || c.toFloor === activeFloor) {
            const cp = L.polyline(c.geom, { color: "#6a8ded", weight: 5, opacity: 1 }).addTo(routeLayer);
            L.polyline(c.geom, { color: "#76e7f8", weight: 2, opacity: 0.95, className: "route-flow" }).addTo(routeLayer);
            L.polylineDecorator(cp, {
                patterns: [{ offset: "10%", repeat: "28%", symbol: L.Symbol.arrowHead({ pixelSize: 6, polygon: false, pathOptions: { stroke: true, color: "#76e7f8", weight: 3 } }) }],
            }).addTo(routeLayer);
        }
    }
// L.marker([1.514149, 103.655106], {icon: testIcon}).addTo(map);
    // origin / destination pins, only on their own floor
    const o = nodesById[currentRoute.originNode], d = nodesById[currentRoute.destNode];
    if (o.floor_label === activeFloor) pin([o.lat, o.lon], startLocation).addTo(markerLayer);
    if (d.floor_label === activeFloor) pin([d.lat, d.lon], endLocation).addTo(markerLayer);

    // transition pins: leaving this floor, and arriving on this floor
    for (const tr of currentRoute.transitions) {
        if (tr.fromFloor === activeFloor) {
            const n = nodesById[tr.atNode];
            const goingUp = (FLOOR_ORDER[tr.toFloor] ?? 0) > (FLOOR_ORDER[tr.fromFloor] ?? 0);
            const icon = transitionMarkerIcon(tr.type, goingUp);
            if (icon) {
                pin([n.lat, n.lon], icon).addTo(markerLayer);
            } else {
                // stairs (no dedicated SVG): labelled marker with up/down arrow
                L.marker([n.lat, n.lon], {
                    icon: L.divIcon({ className: "", iconAnchor: [0, 0],
                        html: `<div class="map-pin" style="background:#b45309"><span class="dir-arrow">${goingUp ? "▲" : "▼"}</span> Stairs to ${floorName(tr.toFloor)}</div>` }),
                }).addTo(markerLayer);
            }
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
    if (bounds) map.fitBounds(bounds, fitOpts(21));
}

function highlightSteps() {
    document.querySelectorAll("#routeSteps li").forEach(li => {
        li.classList.toggle("active", li.getAttribute("data-floor") === activeFloor);
    });
}

// ── Navigation ────────────────────────────────────────────────────────────────
function updateNavigateBtn() {
    document.getElementById("navigateBtn").disabled = !(fromShop && toShop);
    refreshClearBtns();
}

// Show/hide the per-field clear (✕) buttons based on whether the field has text.
function refreshClearBtns() {
    document.querySelectorAll(".clear-field").forEach(btn => {
        const inp = document.getElementById(btn.dataset.target);
        if (inp) btn.classList.toggle("show", !!inp.value);
    });
}

document.querySelectorAll(".clear-field").forEach(btn => {
    const inp = document.getElementById(btn.dataset.target);
    inp.addEventListener("input", refreshClearBtns);
    btn.addEventListener("mousedown", e => e.preventDefault()); // don't blur the field before click
    btn.addEventListener("click", () => {
        inp.value = "";
        if (btn.dataset.target === "fromInput") fromShop = null; else toShop = null;
        const listId = btn.dataset.target === "fromInput" ? "fromSuggestions" : "toSuggestions";
        document.getElementById(listId).classList.add("hidden");
        updateNavigateBtn();
        inp.focus();
    });
});

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
    if (seg && seg.length) map.fitBounds(L.polyline(seg).getBounds(), fitOpts());
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

makeAutocomplete("fromInput", "fromSuggestions", s => setFrom(s));
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
    showFromPreview();
}

// When a start location is chosen (before navigating), jump to its floor, drop the
// start marker, and zoom in on it.
function showFromPreview() {
    if (!fromShop || currentRoute) return;   // an active route view takes precedence
    showFloor(fromShop.floor_label);          // clears markerLayer (no route yet)
    L.marker([fromShop.lat, fromShop.lon], { icon: startLocation }).addTo(markerLayer);
    map.setView([fromShop.lat, fromShop.lon], 20, { animate: true });
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
