import { db } from "../db.js";

const stmts = {
    addNode: db.prepare(`
        INSERT INTO kg_nodes (id, label, type, attributes)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            type = excluded.type,
            attributes = excluded.attributes
    `),
    addEdge: db.prepare(`
        INSERT INTO kg_edges (source, target, label, weight)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source, target, label) DO UPDATE SET
            weight = excluded.weight
    `),
    queryGraph: db.prepare(`
        SELECT 
            n1.label as source_label, n1.type as source_type,
            e.label as relation, e.weight,
            n2.label as target_label, n2.type as target_type
        FROM kg_edges e
        JOIN kg_nodes n1 ON e.source = n1.id
        JOIN kg_nodes n2 ON e.target = n2.id
        WHERE n1.label LIKE ? OR n2.label LIKE ?
        LIMIT 20
    `),
    traverseGraph: db.prepare(`
        WITH RECURSIVE traverse(id, path, depth) AS (
            SELECT id, label, 1 FROM kg_nodes WHERE label LIKE ?
            UNION
            SELECT n.id, t.path || ' -> ' || e.label || ' -> ' || n.label, t.depth + 1
            FROM kg_edges e
            JOIN kg_nodes n ON e.target = n.id
            JOIN traverse t ON e.source = t.id
            WHERE t.depth < ?
        )
        SELECT path FROM traverse WHERE depth > 1 LIMIT 20;
    `)
};

export function addEntity(id: string, label: string, type: string, attributes?: Record<string, any>) {
    stmts.addNode.run(id, label, type, attributes ? JSON.stringify(attributes) : null);
    return `Added entity: ${label} (${type})`;
}

export function addRelation(sourceId: string, targetId: string, label: string, weight: number = 1.0) {
    try {
        stmts.addEdge.run(sourceId, targetId, label, weight);
        return `Added relation: ${sourceId} -[${label}]-> ${targetId}`;
    } catch (err: any) {
        return `Failed to add relation (ensure source & target IDs exist): ${err.message}`;
    }
}

export function queryGraph(searchTerm: string) {
    const term = `%${searchTerm}%`;
    const results = stmts.queryGraph.all(term, term) as any[];
    if (results.length === 0) return "No graph relations found.";
    return results.map(r => `(${r.source_label}:${r.source_type}) -[${r.relation}]-> (${r.target_label}:${r.target_type})`).join("\n");
}

export function traverseGraph(startLabel: string, maxDepth: number = 3) {
    const results = stmts.traverseGraph.all(`%${startLabel}%`, maxDepth) as any[];
    if (results.length === 0) return "No graph paths found.";
    return results.map(r => r.path).join("\n");
}
