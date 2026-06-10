import json

# Load nodes GeoJSON
with open("./data/Test_Level3_Nodes_01.geojson") as f:
    nodes_geo = json.load(f)

# Load edges GeoJSON
with open("./data/Test_Level3_Edges_01.geojson") as f:
    edges_geo = json.load(f)


# Convert nodes to dict keyed by node_id
nodes = {}
for feature in nodes_geo['features']:
    props = feature['properties']
    coord = feature['geometry']['coordinates']
    node_id = str(props['node_id'])
    nodes[node_id] = {
        "lat": coord[1],
        "lon": coord[0],
        "floor": props.get('floor'),
        "type": props.get('type'),
        "name": props.get('name')
    }

# Convert edges to simple list
edges = []
for feature in edges_geo['features']:
    props = feature['properties']
    edges.append({
        "id": props.get("edge_id"),
        "from": str(props.get("from_n_id")),
        "to": str(props.get("to_n_id")),
        "weight": props.get("distance"),
        "floor": props.get("floor", None),
        "accessible": props.get("accessible", 1),
        "bidir": props.get("bidir",1)
    })
    # print(props.get("accessible"))

    if props.get("bidir") == 1:
        edges.append({
            "id": props.get("edge_id"),
            "from": str(props.get("to_n_id")),
            "to": str(props.get("from_n_id")),
            "weight": props.get("distance"),
            "floor": props.get("floor", None),
            "accessible": props.get("accessible", 1),
            "bidir": props.get("bidir",1)
        })


# Combine into graph
graph = {
    "nodes": nodes,
    "edges": edges
}

# Save graph.json
with open("./data/graph.json", "w") as f:
    json.dump(graph, f, indent=2)

print("graph.json generated!")