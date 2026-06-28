"""
Build graph.json for the Tasek Mall navigator from the QGIS exports.

Inputs (in data/QGIS/):
  nodes.geojson                  - all nodes, all floors (nodeID, Type, FloorLevel, ShopName, ...)
  edges.geojson                  - same-floor corridor edges (from_n_id, to_n_id, distance, bidir, accessible)
  Up_Escalators.geojson          - one-way escalator links (from_n_id, to_n_id)
  Down_Escalators.geojson        - one-way escalator links
  TASEK MAPPING LIFT NODES ...csv- lift connectors (from_n_id, to_n_id, type, bidir, accessible)

Output:
  data/graph.json  - { "nodes": {id: {lat,lon,floor,floor_label,type,name,lotno,category}},
                       "edges": [ {from,to,weight,type,accessible}, ... ] }   (directional)

Cross-floor links (lift/escalator) get a tunable time-equivalent weight instead of a
geometric length, so A* trades them off fairly against walking distance.
"""

import json, csv, os

HERE = os.path.dirname(os.path.abspath(__file__))
QGIS = os.path.join(HERE, "data", "QGIS")
OUT = os.path.join(HERE, "data", "graph.json")

# Time-equivalent weights (metres of walking) for vertical moves. Tune here.
# Lifts are weighted high (wait + ride) so routing prefers escalators; lifts are
# only chosen when no escalator path exists (or for accessible routing later).
VERTICAL_WEIGHT = {"lift": 45.0, "escalator": 8.0, "stairs": 15.0}

# Map floor labels to a numeric order for the A* floor-change heuristic.
FLOOR_ORDER = {"B2": -2, "B1": -1, "G": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6}


def load_geojson(name):
    with open(os.path.join(QGIS, name), encoding="utf-8") as f:
        return json.load(f)["features"]


# Node sources, combined into one set. Vertical (lift/escalator) nodes live in
# their own file with frozen _L/_E IDs; the regular file holds everything else.
NODE_FILES = ["nodes.geojson", "vertical_nodes.geojson"]


def build_nodes(report):
    nodes = {}
    for fname in NODE_FILES:
        for f in load_geojson(fname):
            p = f["properties"]
            nid = p.get("nodeID")
            if not nid:
                continue
            if not f.get("geometry") or not f["geometry"].get("coordinates"):
                report.append(f"  [node] dropped {nid}: no geometry ({fname})")
                continue
            if nid in nodes:
                report.append(f"  [node] DUPLICATE id {nid} ({fname}) — overwriting earlier definition")
            lon, lat = f["geometry"]["coordinates"][:2]
            label = str(p.get("FloorLevel")) if p.get("FloorLevel") is not None else None
            nodes[nid] = {
                "lat": lat,
                "lon": lon,
                "floor": FLOOR_ORDER.get(label, 0),
                "floor_label": label,
                "type": p.get("Type"),
                "name": p.get("ShopName"),
                "lotno": p.get("LotNo"),
                "category": p.get("Category"),
            }
    return nodes


def add_edge(edges, frm, to, weight, etype, accessible, bidir, nodes, report, src):
    """Append a directional edge (and its reverse if bidir), skipping bad refs."""
    if frm not in nodes or to not in nodes:
        report.append(f"  [{src}] dropped edge with unknown node(s): {frm} -> {to}")
        return 0
    added = 0
    edges.append({"from": frm, "to": to, "weight": round(weight, 3),
                  "type": etype, "accessible": int(accessible)})
    added += 1
    if bidir:
        edges.append({"from": to, "to": frm, "weight": round(weight, 3),
                      "type": etype, "accessible": int(accessible)})
        added += 1
    return added


def build_edges(nodes, report):
    edges = []

    # Corridor edges (geometric distance, usually bidirectional)
    for f in load_geojson("edges.geojson"):
        p = f["properties"]
        add_edge(edges, p.get("from_n_id"), p.get("to_n_id"),
                 float(p.get("distance") or 0), "walk",
                 p.get("accessible", 1), int(p.get("bidir", 1) or 0),
                 nodes, report, "corridor")

    # Escalators: one-way, fixed penalty
    for fname in ("Up_Escalators.geojson", "Down_Escalators.geojson"):
        for f in load_geojson(fname):
            p = f["properties"]
            add_edge(edges, p.get("from_n_id"), p.get("to_n_id"),
                     VERTICAL_WEIGHT["escalator"], "escalator",
                     p.get("accessible", 0), 0,  # escalators never bidirectional
                     nodes, report, "escalator")

    # Lifts: bidirectional, fixed penalty
    with open(os.path.join(QGIS, "TASEK MAPPING LIFT NODES - Sheet1.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            etype = (r.get("type") or "lift").strip()
            add_edge(edges, r["from_n_id"].strip(), r["to_n_id"].strip(),
                     VERTICAL_WEIGHT.get(etype, VERTICAL_WEIGHT["lift"]), etype,
                     r.get("accessible", 1), int(r.get("bidir", 1) or 0),
                     nodes, report, "lift")

    return edges


def validate(nodes, edges, report):
    """Warn about nodes unreachable by any edge (likely digitising gaps)."""
    connected = set()
    for e in edges:
        connected.add(e["from"]); connected.add(e["to"])
    orphans = [nid for nid in nodes if nid not in connected]
    if orphans:
        report.append(f"  {len(orphans)} orphan node(s) with no edges (first 15): {orphans[:15]}")


def main():
    report = []
    nodes = build_nodes(report)
    edges = build_edges(nodes, report)
    validate(nodes, edges, report)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes, "edges": edges}, f, indent=2, ensure_ascii=False)

    floors = sorted({n["floor_label"] for n in nodes.values() if n["floor_label"]},
                    key=lambda l: FLOOR_ORDER.get(l, 0))
    named = sum(1 for n in nodes.values() if n.get("name"))
    print(f"graph.json written -> {OUT}")
    print(f"  {len(nodes)} nodes  |  {len(edges)} directional edges  |  floors: {floors}")
    print(f"  {named} named shops (searchable)")
    if report:
        print("\nVALIDATION REPORT:")
        print("\n".join(report))
    else:
        print("\nNo data issues found.")


if __name__ == "__main__":
    main()
