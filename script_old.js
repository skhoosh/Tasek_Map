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

floor1Layer.addTo(map);

// function to show floor selected
function showFloor(floor) {
  map.removeLayer(floor1Layer);
  map.removeLayer(floor2Layer);

  if (floor === 1) map.addLayer(floor1Layer);
  if (floor === 2) map.addLayer(floor2Layer);
}

// get dropdown select value and use it to show the correct floor 
document.getElementById("floorLevel").addEventListener("change", function () {
  const selectedFloor = parseInt(this.value);
  showFloor(selectedFloor);
});



/*function showShopName(feature, layer) {
  if (feature.properties.ShopName) {
    layer.bindPopup(feature.properties.ShopName);
  }
}

function showShopNameTT(feature, layer) {
  if (feature.properties.ShopName) {
    layer.bindTooltip(feature.properties.ShopName,{
      permanent: true,
      direction: 'center'
    });
    console.log(feature);
  }
}*/

// L.geoJSON(TasekL2).addTo(map);

/*L.geoJSON(TasekL2, {
  style: function (feature) {
    switch (feature.properties.Zone) {
      case 'Orange': return { color: "#f56743" };
      case 'Yellow': return { color: "#f3ce35" };
      case 'Blue': return { color: "#00aaac" };
      case 'Green': return { color: "#86ab51" };
      case 'Pink': return { color: "#c2558a" };
      case 'Purple': return { color: "#a366a0" };
    }
  },
  onEachFeature : showShopNameTT
}).addTo(map);*/

console.log('hello');
// Display some debug info
// L.Rotate.debug(map);


let graph = null;

fetch("data/graph.json")
  .then(res => res.json())
  .then(data => {
    graph = data;
    console.log("Graph loaded:", graph);
  })

// A* Routing in Javascript: 
function heuristic(a, b) {
  // Euclidean distance in WGS84 (ok for small indoor areas)
  const dx = a.lon - b.lon;
  const dy = a.lat - b.lat;
  return Math.sqrt(dx * dx + dy * dy);
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

// // Convert node IDs (coordinate for the polyline)
// function pathToLatLngs(path) {
//   return path.map(id => {
//     const n = graph.nodes[id];
//     return [n.lat, n.lon];
//   });
// }

// // Draw route on leaflet 
// let routeLine = null;

// function showRoute(path) {
//   const latlngs = pathToLatLngs(path);

//   if (routeLine) {
//     routeLine.remove();
//   }

//   routeLine = L.polyline(latlngs, {
//     color: "blue",
//     weight: 4
//   }).addTo(map);

//   map.fitBounds(routeLine.getBounds());
// }

// Edge Index: 
let edgesData = null;
let edgeLookup = {};

fetch('data/Test_Edges_01.geojson')
  .then(res => res.json())
  .then(data => {
    edgesData = data;

    // Build lookup table for routing display
    edgesData.features.forEach(f => {
      const from = f.properties.from_id;
      const to = f.properties.to_id;

      const key = `${from}-${to}`;
      edgeLookup[key] = f.geometry.coordinates[0]; // assuming MultiLineString

      // For bidirectional edges
      edgeLookup[`${to}-${from}`] = f.geometry.coordinates[0];
    });

    console.log("Edges loaded", edgeLookup);
  })
  .catch(err => console.error("Failed to load edges", err));

L.geoJSON(edgesData, {
  style: { color: 'gray', weight: 3, opacity: 0.5 }
}).addTo(map);

// Draw route
// function drawRoute(path) {
//     const finalCoords = [];

//     for (let i = 0; i < path.length - 1; i++) {
//         const a = path[i];
//         const b = path[i+1];
//         const key = `${a}-${b}`;

//         if (edgeLookup[key]) {
//             finalCoords.push(...edgeLookup[key]);  
//         }
//     }

//     L.polyline(finalCoords, {color: 'red'}).addTo(map);
// }

function drawRoute(path) {
  let finalCoords = [];

  for (let i = 0; i < path.length - 1; i++) {
    const key = `${path[i]}-${path[i + 1]}`;
    if (edgeLookup[key]) {
      finalCoords.push(...edgeLookup[key]);
    }
  }

  L.polyline(finalCoords, { color: 'blue', weight: 4 }).addTo(map);
  console.log(finalCoords)
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