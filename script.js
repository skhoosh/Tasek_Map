// Use OSM Basemap
var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 22,
    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
});

// Initialise Map - lock zoom !!!ALSO NEED TO LOCK EXTENTS
var map = L.map('map', {
    center: [1.5140811569360366, 103.65495615797322],
    zoom: 18,
    layers: [osm],
    minZoom: 0,
    maxZoom: 22,
    rotate: true,
    // rotateControl: {
    //   closeOnZeroBearing:false
    // },
    bearing: 316.5,
    // touchRotate:true
});

// Initialise floor layer variables
let floor1Layer = L.layerGroup();
let floor2Layer = L.layerGroup();
let floor3Layer = L.layerGroup();

// Function to load GeoJSONS 
const loadGeojson = (url, floorLayer) => {
    fetch(url)
        .then(r => r.json())
        .then(data => L.geoJSON(data).addTo(floorLayer))
}

loadGeojson("data/Tasek_Level2_Test01.geojson", floor2Layer);
loadGeojson("data/Level1_Test.geojson", floor1Layer);
loadGeojson("data/Test_Level3_Floorplan_01.geojson", floor3Layer);

// when first load, show floor 1 layer
floor1Layer.addTo(map);

// function to show floor selected
function showFloor(floor) {
    map.removeLayer(floor1Layer);
    map.removeLayer(floor2Layer);
    map.removeLayer(floor3Layer);

    if (floor === 1) map.addLayer(floor1Layer);
    if (floor === 2) map.addLayer(floor2Layer);
    if (floor === 3) map.addLayer(floor3Layer);

}

// get dropdown select value and use it to show the correct floor 
document.getElementById("floorLevel").addEventListener("change", function () {
    const selectedFloor = parseInt(this.value);
    showFloor(selectedFloor);
});



console.log('hello');
// Display some debug info
// L.Rotate.debug(map);


// Load A* Graph
let graph = null;
// Edge Index: 
let edgesData = null;
let edgeLookup = {};

Promise.all([
    fetch("data/graph.json").then(res => res.json()),
    fetch("data/Test_Level3_Edges_01.geojson").then(res => res.json())
])
    .then(([graphData, edgesJson]) => {
        graph = graphData;
        edgesData = edgesJson;

        // Build lookup
        edgesData.features.forEach(f => {
            const from = f.properties.from_n_id;
            const to = f.properties.to_n_id;
            const bidirectional = f.properties.bidir;
            // const key = `${from}-${to}`;
            // edgeLookup[key] = f.geometry.coordinates[0];
            // edgeLookup[`${to}-${from}`] = f.geometry.coordinates[0];
            const coords = f.geometry.coordinates[0]; // LineString
            const forward = coords.map(c => [c[1], c[0]]); // lon,lat → lat,lon
            // const reverse = [...forward].reverse();        // reverse direction

            edgeLookup[`${from}-${to}`] = forward;
            if (bidirectional === 1) {
                edgeLookup[`${to}-${from}`] = [...forward].reverse();
            }

        });

        // Draw all edges for debugging
        L.geoJSON(edgesData, { style: { color: 'gray', weight: 3, opacity: 0.5 } }).addTo(map);

        console.log("Graph and edges loaded");
    });


// A* Routing in Javascript: 
function heuristic(a, b) {
    // Euclidean distance in WGS84 (ok for small indoor areas)
    const dx = a.lon - b.lon;
    const dy = a.lat - b.lat;
    const floorPenalty = Math.abs(a.floor - b.floor) * 0.0001;
    return Math.sqrt(dx * dx + dy * dy) + floorPenalty;
    // return Math.sqrt(dx * dx + dy * dy);
}

function aStar(graph, startId, goalId) {
    const nodes = graph.nodes;

    const open = new Set([startId]);
    const cameFrom = {};

    const gScore = {};
    const fScore = {};

    for (let id in nodes) {
        gScore[id] = Infinity;
        fScore[id] = Infinity;
    }

    gScore[startId] = 0;
    fScore[startId] = heuristic(nodes[startId], nodes[goalId]);

    while (open.size > 0) {
        // find node with lowest f-score
        let current = null;
        for (let n of open) {
            if (current === null || fScore[n] < fScore[current]) {
                current = n;
            }
        }

        // reached destination
        if (current == goalId) {
            let path = [current];
            while (current in cameFrom) {
                current = cameFrom[current];
                path.push(current);
            }
            return path.reverse();
        }

        open.delete(current);

        for (let e of graph.edges) {
            if (e.from !== current) continue;

            const neighbor = e.to;

            const tentative_gScore = gScore[current] + e.weight;

            if (tentative_gScore < gScore[neighbor]) {
                cameFrom[neighbor] = current;
                gScore[neighbor] = tentative_gScore;
                fScore[neighbor] = tentative_gScore + heuristic(nodes[neighbor], nodes[goalId]);
                open.add(neighbor);
            }
        }
    }

    return null; // no path found
}


let currentRoute = null;
let routePoints = null;
let routeLayer = L.layerGroup().addTo(map);
function drawRoute(path) {
    routeLayer.clearLayers();

    let finalCoords = [];

    for (let i = 0; i < path.length - 1; i++) {
        const key = `${path[i]}-${path[i + 1]}`;
        if (edgeLookup[key]) {
            const coords = edgeLookup[key]
            // coords.forEach(points => {
            //     L.marker(points)
            //     .bindPopup(String(i))
            //     .addTo(map);
            // })
            finalCoords.push(...coords);
            // console.log(coords);
        }
    }
    routePoints = L.marker([1.514123897, 103.6559185]).addTo(map);
    console.log(finalCoords);
    const poly = L.polyline(finalCoords, { color: 'red', weight: 4 }).addTo(routeLayer);

    // Plot each coordinate that makes the polyline for debugging: 
    // finalCoords.forEach((pt) => {
    //     var x = finalCoords.indexOf(pt)
    //     L.marker(pt).bindPopup(`${x}`).addTo(map);
    // })


    // Add arrows:
    L.polylineDecorator(poly, {
        patterns: [
            {
                offset: '5%',
                repeat: '10%',
                symbol: L.Symbol.arrowHead({
                    pixelSize: 8,
                    polygon: false,
                    pathOptions: { stroke: true, color: 'blue' }
                })
            }
        ]
    }).addTo(routeLayer);
}


// connect to UI routing:

function route(startNodeId, destNodeId) {
    const path = aStar(graph, startNodeId, destNodeId);
    if (!path) {
        alert("No path found!");
        return;
    }
    drawRoute(path);
    // showRoute(path);
}